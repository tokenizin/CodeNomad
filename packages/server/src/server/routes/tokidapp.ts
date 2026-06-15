import { WebSocket, WebSocketServer } from "ws"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import fs from "fs"
import path from "path"
import os from "os"
import type { StarGuardJwtHandler } from "../../auth/starguard-jwt"
import {
  createRealtimeSession,
  sendAudioChunk,
  commitAudioBuffer,
  resetInputAudio,
  hasEnoughInputAudio,
  clearAudioBuffer,
  endVoiceSession,
  getRealtimeSession,
  getRealtimeSessionVoice,
  ensureSingleUserSession,
} from "../../plugins/tokidapp/concierge/openai-realtime"
import { normalizeRealtimeVoice } from "../../plugins/tokidapp/concierge/realtime-voices"
import { getArchitectureDigest } from "../../plugins/tokidapp/concierge/codebase-tools"
import { executeDAG, buildLifecycleDAG } from "../../plugins/tokidapp/orchestrator/dag-engine"
import {
  createApprovalRequest,
  waitForApprovalDecision,
  resolveApproval,
  submitApprovalDecision,
  fetchPendingApprovals,
  getPendingApprovals,
} from "../../plugins/tokidapp/orchestrator/approval-queue"
import { apiPost, apiGet, apiPut } from "../../plugins/tokidapp/orchestrator/starguard-client"
import { addLocalRecording, getLocalRecordings } from "./local-recordings"
import type { DAGNode, DAGDefinition, ExecutionCallbacks } from "../../plugins/tokidapp/orchestrator/types"
import {
  registerTokidappSocket,
  unregisterTokidappSocket,
  getTokidappSocket,
  tokidappSessionId,
  type WsSocketRef,
} from "../ws-socket-registry"
import {
  investigateCodebase,
  generateFeature,
  runTests,
  gitStatus,
  captureGitDiff,
  gitCommitPush,
  triggerVercelDeploy,
  checkDeployStatus,
  spawnAgent,
  scheduleTask,
  listTasks,
  assignTask,
  rollbackDeploy,
  runA11yAudit,
  checkA11yScan,
  checkColorContrast,
  readFileContent,
  runLint,
  runTypeCheck,
  gitBranchAction,
} from "../../plugins/tokidapp/concierge/codebase-tools"
import {
  scanContract,
  getScanStatus,
  listSecurityScans,
  listSolidityContracts,
} from "../../plugins/tokidapp/concierge/security-tools"
import { bridge } from "./nomadworks-bridge"

const WORKSPACE_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()
const REALTIME_ENABLED = !!process.env.OPENAI_API_KEY
const STARGUARD_BASE = process.env.STARGUARD_BASE_URL || "https://shapiro-vip.vercel.app"

/** WS registry keys (tokidapp_*, voice_*) — not StarWorld TokiDAPPSession ids. */
function isWsTransportSessionKey(id: string): boolean {
  return id.startsWith("tokidapp_") || id.startsWith("voice_")
}

function resolveStarworldSessionId(boundDbSessionId: string | null): string | null {
  if (!boundDbSessionId || isWsTransportSessionKey(boundDbSessionId)) return null
  return boundDbSessionId
}

async function lookupOrchestratorIdForDbSession(dbSessionId: string): Promise<string | null> {
  try {
    const res = await apiGet(`/api/tokidapp/orchestrator?sessionId=${encodeURIComponent(dbSessionId)}`)
    if (!res.ok) return null
    const sessions = await res.json()
    return Array.isArray(sessions) && sessions.length > 0 ? (sessions[0] as { id: string }).id : null
  } catch {
    return null
  }
}

async function sendOrchestratorStateForSession(
  wsSessionId: string,
  dbSessionId: string | null,
  orchestratorSessions: Map<string, string>,
  socketRef: { send: (msg: string) => void },
): Promise<void> {
  let orchestratorId = orchestratorSessions.get(wsSessionId) ?? null
  if (!orchestratorId) {
    const starworldSessionId = resolveStarworldSessionId(dbSessionId)
    if (starworldSessionId) {
      orchestratorId = await lookupOrchestratorIdForDbSession(starworldSessionId)
      if (orchestratorId) orchestratorSessions.set(wsSessionId, orchestratorId)
    }
  }
  if (!orchestratorId) return
  try {
    const res = await apiGet(`/api/tokidapp/orchestrator/${orchestratorId}`)
    if (res.ok) {
      const data = await res.json()
      socketRef.send(JSON.stringify({ type: "orchestrator_state", ...data }))
    }
  } catch { /* ignore */ }
}

// Cache for workflow definitions fetched from StarGuard
let workflowDefinitionsCache: any = null
let workflowCacheTime = 0
const WORKFLOW_CACHE_TTL = 300_000 // 5 minutes

const tokidappWss = new WebSocketServer({ noServer: true })

// ── CodeNomad Voice Realtime WebSocket ─────────────────────

const voiceWss = new WebSocketServer({ noServer: true })

interface VoiceRealtimeSocket {
  send: (msg: string) => void
  close: (code?: number, reason?: string) => void
}

async function startVoiceRealtimeSession(
  sessionId: string,
  requestedVoice: unknown,
  socketRef: { send: (msg: string) => void },
) {
  const voice = normalizeRealtimeVoice(requestedVoice)
  const existingVoice = getRealtimeSessionVoice(sessionId)
  console.log("[voice-ws] startVoiceRealtimeSession sessionId:", sessionId, "voice:", voice, "existingVoice:", existingVoice)
  if (existingVoice && existingVoice !== voice) {
    console.log("[voice-ws] voice changed, ending existing session")
    endVoiceSession(sessionId)
  }
  resetInputAudio(sessionId)
  const notifyReady = () => {
    console.log("[voice-ws] notifyReady — sending voice_ready to client")
    socketRef.send(JSON.stringify({ type: "voice_ready", voice }))
    // No auto-greeting: let the user speak first. The client already sends a
    // text greeting (see attachTokidappSocket). Injecting a fake "Hi." as a
    // user message causes the AI to respond to a request the user never made,
    // potentially calling tools or investigating before the user has spoken.
  }
  // Ensure only ONE Realtime session per user across voice WS and tokidapp WS
  ensureSingleUserSession(sessionId)

  // Extract userId from sessionId (format: "voice_${userId}")
  const userId = sessionId.startsWith("voice_") ? sessionId.slice(6) : undefined
  if (!getRealtimeSession(sessionId)) {
    console.log("[voice-ws] no existing session, creating new OpenAI Realtime session")

    // Fetch architecture knowledge base digest for prompt enrichment
    const digest = await getArchitectureDigest().catch(() => "")

    createRealtimeSession(
      sessionId,
      (audioBase64) => socketRef.send(JSON.stringify({ type: "audio", data: audioBase64 })),
      (textDelta) => socketRef.send(JSON.stringify({ type: "stream", delta: textDelta })),
      (error) => {
        console.log("[voice-ws] OpenAI Realtime error:", error)
        socketRef.send(JSON.stringify({ type: "error", content: error }))
      },
      notifyReady,
      (transcript) =>
        socketRef.send(JSON.stringify({ type: "user_transcript", content: transcript })),
      undefined,
      voice,
      userId,
      digest || undefined,
    )
  } else {
    console.log("[voice-ws] existing session found, calling notifyReady directly")
    notifyReady()
  }
}

const voiceSockets = new Map<string, VoiceRealtimeSocket>()

function attachVoiceSocket(ws: WebSocket, userId: string) {
  const sessionId = `voice_${userId}`
  const socketRef: VoiceRealtimeSocket = {
    send: (msg: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg)
    },
    close: (code?: number, reason?: string) => {
      ws.close(code, reason)
    },
  }

  voiceSockets.set(sessionId, socketRef)
  const orchestratorSessions = new Map<string, string>()
  const taskWatchers = new Map<string, () => void>()
  let dbSessionId: string | null = null

  const cleanup = () => {
    voiceSockets.delete(sessionId)
    orchestratorSessions.delete(sessionId)
    // Clean up all nomadworks task watchers for this session
    for (const [, unwatch] of taskWatchers) {
      unwatch()
    }
    taskWatchers.clear()
    clearAudioBuffer(sessionId)
    endVoiceSession(sessionId)
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) return
    const raw = typeof data === "string" ? data : data.toString("utf8")
    const trimmed = raw.trim()
    if (!trimmed) return

    try {
      const msg = JSON.parse(trimmed)

      if (msg.type === "ping") {
        socketRef.send(JSON.stringify({ type: "pong", ts: Date.now() }))
        return
      }

      if (msg.type === "cancel") {
        // Cancel the in-progress OpenAI Realtime response
        const sess = getRealtimeSession(sessionId)
        if (sess?.connected && sess.responseInProgress) {
          sess.ws.send(JSON.stringify({ type: "response.cancel" }))
          sess.responseInProgress = false
          // Drain queued responses
          const next = sess.pendingResponseQueue.shift()
          if (next) next()
        }
        socketRef.send(JSON.stringify({ type: "voice_cancelled" }))
        return
      }

      if (msg.type === "voice_start") {
        console.log("[voice-ws] voice_start received, REALTIME_ENABLED:", REALTIME_ENABLED)
        if (REALTIME_ENABLED) {
          startVoiceRealtimeSession(sessionId, msg.voice, socketRef)
        } else {
          console.log("[voice-ws] REALTIME_ENABLED is false — OPENAI_API_KEY not set")
          socketRef.send(JSON.stringify({ type: "message", content: "Voice mode requires OPENAI_API_KEY." }))
        }
        return
      }

      if (msg.type === "voice_reset") {
        // Client finished playing an AI response — clear any residual audio
        // (echo / background noise captured during playback) so it doesn't
        // get committed as user input.
        console.log("[voice-ws] voice_reset received — clearing audio buffer")
        clearAudioBuffer(sessionId)
        return
      }

      if (msg.type === "voice_stop") {
        if (hasEnoughInputAudio(sessionId)) {
          commitAudioBuffer(sessionId)
        } else {
          resetInputAudio(sessionId)
          socketRef.send(JSON.stringify({
            type: "voice_cancelled",
            content: "No speech detected. Hold the microphone a little longer.",
          }))
        }
        return
      }

      if (msg.type === "voice_disconnect") {
        // Full teardown of the voice session — close OpenAI Realtime WS,
        // clear audio buffers, and reset state. The WebSocket itself stays
        // open so the client can re-connect with voice_start if needed.
        endVoiceSession(sessionId)
        clearAudioBuffer(sessionId)
        socketRef.send(JSON.stringify({ type: "voice_disconnected" }))
        return
      }

      if (msg.type === "audio" && msg.data) {
        sendAudioChunk(sessionId, msg.data)
        return
      }

      // ── Voice Socket Message Router ─────────────────────────

      if (msg.type === "session_bind" && msg.sessionId) {
        const candidate = String(msg.sessionId).trim()
        if (!candidate || isWsTransportSessionKey(candidate)) {
          socketRef.send(JSON.stringify({
            type: "error",
            content: "session_bind requires StarWorld DB sessionId",
          }))
          return
        }
        dbSessionId = candidate
        socketRef.send(JSON.stringify({ type: "session_bound", sessionId: candidate }))
        return
      }

      if (msg.type === "message" && msg.content) {
        routeMessage(
          msg.content as string,
          (outgoing) => socketRef.send(outgoing),
          msg.workflowSlug as string | undefined,
          msg.workflowStep as number | undefined,
          msg.agentType as string | undefined,
          dbSessionId,
        )
        return
      }

      if (msg.type === "orchestrate" && msg.intent) {
        handleOrchestrateMessage(
          sessionId,
          dbSessionId,
          msg.intent as string,
          (msg.context as Record<string, unknown>) || {},
          socketRef,
          orchestratorSessions,
        )
        return
      }

      if (msg.type === "approval_decision" && msg.approvalId) {
        ;(async () => {
          const decision = msg.decision as string
          if (decision === "approve" || decision === "reject") {
            resolveApproval(
              msg.approvalId as string,
              decision === "approve" ? "approved" : "rejected",
            )
            await submitApprovalDecision(
              msg.approvalId as string,
              decision as "approve" | "reject",
              msg.comment as string | undefined,
            )
            socketRef.send(JSON.stringify({
              type: "approval_update",
              approvalId: msg.approvalId,
              status: decision === "approve" ? "APPROVED" : "REJECTED",
            }))
          }
        })()
        return
      }

      if (msg.type === "dag_query") {
        ;(async () => {
          await sendOrchestratorStateForSession(sessionId, dbSessionId, orchestratorSessions, socketRef)
        })()
        return
      }

      if (msg.type === "deploy" && msg.commitMsg) {
        ;(async () => {
          const gitResult = await gitCommitPush(msg.commitMsg, WORKSPACE_ROOT, STARGUARD_BASE, (outgoing) => socketRef.send(outgoing))
          socketRef.send(JSON.stringify({ type: "deploy_status", status: "committed", commitMsg: msg.commitMsg, commitHash: gitResult }))
          const deployResult = await triggerVercelDeploy(WORKSPACE_ROOT, (outgoing) => socketRef.send(outgoing))
          socketRef.send(JSON.stringify({ type: "deploy_status", status: deployResult.includes("failed") ? "failed" : "building", logs: deployResult }))
        })()
        return
      }

      if (msg.type === "nomadworks_invoke") {
        ;(async () => {
          try {
            const starworldSessionId = resolveStarworldSessionId(dbSessionId)
            if (!starworldSessionId) {
              socketRef.send(JSON.stringify({
                type: "error",
                content: "StarWorld session not bound. Reconnect TokiDAPP from StarGuard.",
              }))
              return
            }
            const result = await bridge.createTaskFile({
              intent: msg.intent || "",
              agentType: msg.agentType || "developer",
              context: (msg.context as Record<string, unknown>) || {},
              sessionId: starworldSessionId,
              complexity: msg.complexity as "tiny" | "standard" | "complex" | undefined,
            })
            socketRef.send(JSON.stringify({ type: "nomadworks_task_status", ...result, status: "created" }))

            // Start watching for task status changes and stream updates back to client
            const unwatch = bridge.watchTask(result.taskId, (outgoing) => socketRef.send(outgoing))
            taskWatchers.set(result.taskId, unwatch)
          } catch (err) {
            socketRef.send(JSON.stringify({ type: "error", content: `nomadworks_invoke failed: ${(err as Error).message}` }))
          }
        })()
        return
      }

      if (msg.type === "nomadworks_status") {
        ;(async () => {
          try {
            const status = await bridge.readTaskStatus(msg.taskId as string)
            if (status) {
              socketRef.send(JSON.stringify({ type: "nomadworks_task_status", ...status }))
            } else {
              socketRef.send(JSON.stringify({ type: "error", content: `Task ${msg.taskId} not found` }))
            }
          } catch (err) {
            socketRef.send(JSON.stringify({ type: "error", content: `nomadworks_status failed: ${(err as Error).message}` }))
          }
        })()
        return
      }

      if (msg.type === "nomadworks_list") {
        ;(async () => {
          try {
            const sessionId = msg.sessionId as string | undefined
            const tasks = await bridge.listTasks(sessionId)
            socketRef.send(JSON.stringify({
              type: "nomadworks_list",
              tasks,
            }))
          } catch (err) {
            socketRef.send(JSON.stringify({ type: "error", content: `nomadworks_list failed: ${(err as Error).message}` }))
          }
        })()
        return
      }

    } catch {
      // Ignore malformed JSON
    }
  })

  ws.on("close", cleanup)
  ws.on("error", cleanup)
}

export function registerVoiceRealtimeWebSocket(
  app: FastifyInstance,
  starGuardJwtHandler?: StarGuardJwtHandler,
) {
  console.log("[voice-ws] registerVoiceRealtimeWebSocket called, starGuardJwtHandler:", !!starGuardJwtHandler)

  app.server.on("upgrade", (request, socket, head) => {
    const rawUrl = request.url ?? "/"
    let parsed: URL
    try {
      parsed = new URL(rawUrl, "http://localhost")
    } catch {
      return
    }

    if (!parsed.pathname.startsWith("/api/voice/session")) return

    const token = parsed.searchParams.get("token") || ""
    // Only log token prefix in development; in production log length only to avoid leaking partial tokens
    const tokenInfo = process.env.NODE_ENV === "production"
      ? `token length: ${token.length}`
      : `token length: ${token.length}, token prefix: ${token.substring(0, 20)}...`
    console.log("[voice-ws] upgrade request received,", tokenInfo)
    if (!token) {
      console.log("[voice-ws] no token — 401")
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }

    if (starGuardJwtHandler) {
      console.log("[voice-ws] JWT handler enabled, verifying token...")
      starGuardJwtHandler.verify(token).then((payload) => {
        if (!payload) {
          console.log("[voice-ws] JWT verification returned null — 401")
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
          socket.destroy()
          return
        }
        console.log("[voice-ws] JWT verified OK, userId:", payload.userId)
        voiceWss.handleUpgrade(request, socket, head, (ws) => {
          console.log("[voice-ws] WS upgrade complete, calling attachVoiceSocket")
          attachVoiceSocket(ws, payload.userId)
        })
      }).catch((err) => {
        console.log("[voice-ws] JWT verification error:", err?.message || err)
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
        socket.destroy()
      })
      return
    }

    // No JWT handler — allow in dev mode
    console.log("[voice-ws] no JWT handler, dev mode — allowing")
    voiceWss.handleUpgrade(request, socket, head, (ws) => {
      attachVoiceSocket(ws, token)
    })
  })
}

// ── Agent-Aware Routing Helper ──────────────────────────────

/** Route a message to a specific NomadWorks agent type.
 *  Creates a task file via the bridge and streams status updates.
 *  Fire-and-forget for Phase 1 — unwatch not stored; cleaned up on WS close. */
async function handleAgentRouting(
  agentType: string,
  content: string,
  dbSessionId: string | null,
  send: (msg: string) => void,
): Promise<void> {
  const starworldSessionId = resolveStarworldSessionId(dbSessionId)
  if (!starworldSessionId) {
    send(JSON.stringify({
      type: 'error',
      content: 'Session not bound. Reconnect TokiDAPP from StarGuard.',
    }))
    return
  }
  try {
    const result = await bridge.createTaskFile({
      intent: content,
      agentType,
      context: {},
      sessionId: starworldSessionId,
    })
    send(JSON.stringify({
      type: 'nomadworks_task_status',
      ...result,
      status: 'created',
      agentType,
    }))
    // Start watching for task status changes (fire and forget — no unwatch storage)
    bridge.watchTask(result.taskId, (outgoing) => send(outgoing))
  } catch (err) {
    send(JSON.stringify({
      type: 'error',
      content: `Agent routing failed: ${(err as Error).message}`,
    }))
  }
}

// ── Message Router ────────────────────────────────────────────

async function routeMessage(
  content: string,
  send: (msg: string) => void,
  workflowSlug?: string,
  workflowStep?: number,
  agentType?: string,
  dbSessionId?: string | null,
): Promise<void> {
  // ── Agent-Aware Routing ───────────────────────────────────
  if (agentType) {
    await handleAgentRouting(agentType, content, dbSessionId ?? null, send)
    return
  }
  // ── End Agent-Aware Routing ───────────────────────────────

  // If workflow context is provided, route by workflow slug
  if (workflowSlug && workflowStep) {
    const slugToHint: Record<string, string> = {
      "investigate-code": "investigate",
      "generate-feature": "generate",
      "run-tests": "test",
      "deploy-app": "deploy",
      "spawn-agent": "spawn agent",
      "schedule-task": "schedule task",
      "assign-task": "assign task",
    }
    const hint = slugToHint[workflowSlug]
    if (hint) {
      content = hint + " " + content
    }
  }
  const lower = content.toLowerCase()

  // Word-boundary keyword matcher — avoids false positives like
  // "review" matching "view" or "ready" matching "read".
  // Builds: \b<word>(?:s|ing|ed|es|er)?\b
  function hasWord(...words: string[]): boolean {
    return words.some(w => new RegExp(`\\b${w}(?:s|ing|ed|es|er)?\\b`, 'i').test(lower))
  }

  if (hasWord("investigate") || hasWord("search") || hasWord("find") || hasWord("look")) {
    send(JSON.stringify({ type: "tool_call", id: "1", tool: "investigate_codebase", status: "running", summary: "Searching codebase..." }))
    const result = await investigateCodebase(content, WORKSPACE_ROOT, send)
    send(JSON.stringify({ type: "tool_result", id: "1", tool: "investigate_codebase", status: "complete", summary: result }))
    emitCausalGraphUpdate(send, "investigate_codebase", result, "route-investigate")
  } else if (hasWord("generate") || hasWord("create") || hasWord("add") || hasWord("make")) {
    send(JSON.stringify({ type: "tool_call", id: "2", tool: "generate_feature", status: "running", summary: "Generating feature..." }))
    const result = await generateFeature(content, WORKSPACE_ROOT, send)
    send(JSON.stringify({ type: "tool_result", id: "2", tool: "generate_feature", status: "complete", summary: result }))
    emitCausalGraphUpdate(send, "generate_feature", result, "route-generate")
  } else if (hasWord("test") || hasWord("verify") || hasWord("check")) {
    send(JSON.stringify({ type: "tool_call", id: "3", tool: "run_tests", status: "running", summary: "Running tests..." }))
    const result = await runTests(WORKSPACE_ROOT, send)
    send(JSON.stringify({ type: "tool_result", id: "3", tool: "run_tests", status: "complete", summary: result }))
    emitCausalGraphUpdate(send, "run_tests", result, "route-test")
  } else if (lower.includes("git status") || hasWord("branch") || lower.includes("repo")) {
    send(JSON.stringify({ type: "tool_call", id: "4", tool: "git_status", status: "running", summary: "Checking git state..." }))
    const result = await gitStatus(WORKSPACE_ROOT)
    send(JSON.stringify({ type: "tool_result", id: "4", tool: "git_status", status: "complete", summary: result }))
  } else if (hasWord("deploy") || hasWord("release") || hasWord("publish")) {
    send(JSON.stringify({ type: "tool_call", id: "5", tool: "git_commit_push", status: "running", summary: "Committing and pushing..." }))
    const gitResult = await gitCommitPush(content, WORKSPACE_ROOT, STARGUARD_BASE, send)
    send(JSON.stringify({ type: "tool_result", id: "5", tool: "git_commit_push", status: "complete", summary: gitResult }))

    send(JSON.stringify({ type: "tool_call", id: "6", tool: "trigger_deploy", status: "running", summary: "Triggering Vercel deploy..." }))
    const deployResult = await triggerVercelDeploy(WORKSPACE_ROOT, send)
    send(JSON.stringify({ type: "tool_result", id: "6", tool: "trigger_deploy", status: "complete", summary: deployResult }))
    emitCausalGraphUpdate(send, "trigger_deploy", deployResult, "route-deploy")
  } else if (hasWord("spawn") || lower.includes("start agent") || lower.includes("launch agent")) {
    send(JSON.stringify({ type: "tool_call", id: "7", tool: "spawn_agent", status: "running", summary: "Spawning agent..." }))
    const result = await spawnAgent(content, STARGUARD_BASE, WORKSPACE_ROOT, send)
    send(JSON.stringify({ type: "tool_result", id: "7", tool: "spawn_agent", status: "complete", summary: result }))
  } else if (hasWord("schedule") || lower.includes("create task") || (lower.includes("add task") && !lower.includes("add a page"))) {
    send(JSON.stringify({ type: "tool_call", id: "8", tool: "schedule_task", status: "running", summary: "Scheduling task..." }))
    const result = await scheduleTask(content, STARGUARD_BASE, send)
    send(JSON.stringify({ type: "tool_result", id: "8", tool: "schedule_task", status: "complete", summary: result }))
  } else if (lower.includes("list task") || lower.includes("show task") || lower.includes("my tasks") || lower.includes("all tasks")) {
    send(JSON.stringify({ type: "tool_call", id: "9", tool: "list_tasks", status: "running", summary: "Fetching tasks..." }))
    const result = await listTasks(content, STARGUARD_BASE, send)
    send(JSON.stringify({ type: "tool_result", id: "9", tool: "list_tasks", status: "complete", summary: result }))
  } else if (lower.includes("assign task") || lower.includes("assign to")) {
    send(JSON.stringify({ type: "tool_call", id: "10", tool: "assign_task", status: "running", summary: "Assigning task..." }))
    const result = await assignTask(content, STARGUARD_BASE, send)
    send(JSON.stringify({ type: "tool_result", id: "10", tool: "assign_task", status: "complete", summary: result }))
  } else if (hasWord("rollback") || lower.includes("undo deploy") || hasWord("revert")) {
    send(JSON.stringify({ type: "tool_call", id: "11", tool: "rollback_deploy", status: "running", summary: "Rolling back deploy..." }))
    const result = await rollbackDeploy(send)
    send(JSON.stringify({ type: "tool_result", id: "11", tool: "rollback_deploy", status: "complete", summary: result }))
  } else if (hasWord("a11y") || hasWord("accessibility") || hasWord("wcag") || hasWord("lighthouse")) {
    const urlMatch = content.match(/https?:\/\/[^\s]+/)
    const url = urlMatch ? urlMatch[0] : "https://shapiro-vip.vercel.app"
    send(JSON.stringify({ type: "tool_call", id: "12", tool: "run_a11y_audit", status: "running", summary: "Running accessibility audit..." }))
    const result = await runA11yAudit(url, WORKSPACE_ROOT, send)
    send(JSON.stringify({ type: "tool_result", id: "12", tool: "run_a11y_audit", status: "complete", summary: result }))
  } else if (hasWord("read") || hasWord("show") || hasWord("view") || hasWord("open")) {
    const fileMatch = content.match(/\b(?:read|show|view|open|list)\s+([^\s]+(?:\/[^\s]+)*)/i)
    const filePath = fileMatch ? fileMatch[1] : (content.replace(/\b(?:read|show|view|open|list)\s*/gi, "").trim())
    if (filePath && filePath.length > 1) {
      send(JSON.stringify({ type: "tool_call", id: "13", tool: "read_file", status: "running", summary: `Reading ${filePath}...` }))
      const result = await readFileContent(filePath, WORKSPACE_ROOT)
      send(JSON.stringify({ type: "tool_result", id: "13", tool: "read_file", status: "complete", summary: result }))
    } else {
      send(JSON.stringify({ type: "message", content: "What file would you like to read? Specify the path like: read src/app/page.tsx" }))
    }
  } else if (hasWord("lint") || hasWord("eslint")) {
    send(JSON.stringify({ type: "tool_call", id: "14", tool: "run_lint", status: "running", summary: "Running linter..." }))
    const result = await runLint(WORKSPACE_ROOT, send)
    send(JSON.stringify({ type: "tool_result", id: "14", tool: "run_lint", status: "complete", summary: result }))
  } else if (hasWord("typecheck") || hasWord("type-check") || hasWord("type check") || hasWord("tsc")) {
    send(JSON.stringify({ type: "tool_call", id: "15", tool: "run_typecheck", status: "running", summary: "Running type check..." }))
    const result = await runTypeCheck(WORKSPACE_ROOT, send)
    send(JSON.stringify({ type: "tool_result", id: "15", tool: "run_typecheck", status: "complete", summary: result }))
  } else if (hasWord("branch")) {
    const isCreate = lower.includes("create") || lower.includes("new")
    const isDelete = lower.includes("delete") || lower.includes("remove")
    const isSwitch = lower.includes("switch") || lower.includes("checkout") || lower.includes("go to")
    const nameMatch = content.match(/(?:branch\s+)?(\w[\w/-]+)/i)
    const branchName = (!isCreate && !isDelete && !isSwitch) ? undefined : (nameMatch ? nameMatch[1] : undefined)
    const action = isCreate ? "create" : isDelete ? "delete" : isSwitch ? "switch" : "list"
    send(JSON.stringify({ type: "tool_call", id: "16", tool: "git_branch", status: "running", summary: `Branch action: ${action}...` }))
    const result = await gitBranchAction(action, branchName, WORKSPACE_ROOT)
    send(JSON.stringify({ type: "tool_result", id: "16", tool: "git_branch", status: "complete", summary: result }))
  } else if (hasWord("scan") || hasWord("security") || lower.indexOf("vulnerabilit") !== -1) {
    // Extract contract name from message
    const contractMatch = content.match(/(?:scan|check|audit)\s+(\w[\w-]*)/i)
    const contractName = contractMatch ? contractMatch[1] : ""
    if (contractName) {
      send(JSON.stringify({ type: "tool_call", id: "20", tool: "security_scan", status: "running", summary: `Scanning ${contractName}...` }))
      const result = await scanContract(contractName, WORKSPACE_ROOT, send)
      send(JSON.stringify({ type: "tool_result", id: "20", tool: "security_scan", status: "complete", summary: result }))
      emitCausalGraphUpdate(send, "security_scan", result, "route-security")
    } else {
      // List contracts and scans if no specific contract
      const contracts = await listSolidityContracts(WORKSPACE_ROOT)
      const scanList = await listSecurityScans()
      send(JSON.stringify({
        type: "message",
        content: `Available contracts to scan:\n${contracts.map(c => `  \u2022 ${c.name}`).join("\n") || "  (none)"}\n\n${scanList}`,
      }))
    }
  } else {
    // Unrecognized query — try GPT for a natural-language answer
    // before falling back to the static capabilities list.
    let answered = false
    const OPENAI_KEY = process.env.OPENAI_API_KEY
    if (OPENAI_KEY) {
      try {
        const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content:
                  `You are the TokiDAPP concierge for the StarWORLD ecosystem. ` +
                  `You help users with codebase tasks: investigating code, generating features, running tests, ` +
                  `checking git status, deploying to Vercel, spawning agents, scheduling tasks, and scanning contracts. ` +
                  `If the user's request matches one of these capabilities, route them to the appropriate tool. ` +
                  `If they ask a general question, answer concisely from your knowledge. ` +
                  `Keep responses under 200 words. Do NOT read file paths, URLs, wallet addresses, or UUIDs aloud.`,
              },
              { role: "user", content },
            ],
            max_tokens: 500,
          }),
        })
        if (gptRes.ok) {
          const gptData = (await gptRes.json()) as {
            choices?: Array<{ message?: { content?: string } }>
          }
          const reply = gptData?.choices?.[0]?.message?.content?.trim()
          if (reply) {
            send(JSON.stringify({ type: "message", content: reply }))
            answered = true
          }
        }
      } catch {
        // GPT unreachable — fall through to static list
      }
    }
    if (!answered) {
      send(JSON.stringify({
        type: "message",
        content: [
          "I can help with:",
          "• **Investigate** — search and read codebase files",
          "• **Generate** — create new pages, components, routes",
          "• **Test** — run the test suite",
          "• **Git status** — check branch, changes, history",
          "• **Deploy** — commit, push, and deploy to Vercel",
          "• **Spawn agent** — launch OpenCode/OpenCoder/OpenAgent workspaces",
          "• **Schedule task** — create and schedule tasks for agents or users",
          "• **List tasks** — view all pending/assigned/completed tasks",
          "• **Assign task** — assign a task to a specific user",
          "• **Rollback deploy** — revert to the previous commit and redeploy",
          "• **Accessibility** — run a11y audits (Lighthouse, axe-core)",
          "• **Security scan** — scan Solidity contracts for vulnerabilities",
          "• **Read file** — view file contents or list directories",
          "• **Lint** — run the linter",
          "• **Type check** — run TypeScript type checking",
          "• **Git branch** — list, create, switch, or delete branches",
          "",
          "What would you like to do?",
        ].join("\n"),
      }))
    }
  }
}

// ── Workflow Definitions (fetched from StarGuard) ──────────────

async function fetchWorkflowDefinitions(): Promise<any[]> {
  try {
    const res = await fetch(`${STARGUARD_BASE}/api/tokidapp/workflows`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return []
    const data: any = await res.json()
    return data.workflows || []
  } catch {
    return []
  }
}

async function getWorkflowDefinitions(): Promise<any[]> {
  const now = Date.now()
  if (!workflowDefinitionsCache || now - workflowCacheTime > WORKFLOW_CACHE_TTL) {
    workflowDefinitionsCache = await fetchWorkflowDefinitions()
    workflowCacheTime = now
  }
  return workflowDefinitionsCache
}

// ── Routes ────────────────────────────────────────────────────

export function registerTokidappRoutes(app: FastifyInstance) {
  // Proxy: serve workflow definitions from StarGuard with local cache
  app.get("/api/tokidapp/workflows", async () => {
    const workflows = await getWorkflowDefinitions()
    return { version: 1, updatedAt: new Date().toISOString().split("T")[0], workflows, digitalAssets: [] }
  })

  // Health / status
  app.get("/api/tokidapp/status", async () => {
    // Check OpenAI API connectivity if key is configured
    let openaiStatus = "not_configured"
    if (REALTIME_ENABLED) {
      try {
        const response = await fetch("https://api.openai.com/v1/models", {
          method: "HEAD",
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          signal: AbortSignal.timeout(5000),
        })
        openaiStatus = response.ok ? "reachable" : `error_${response.status}`
      } catch (e) {
        openaiStatus = "unreachable"
      }
    }
    return {
      status: "ok",
      activeSockets: 0, // computed by StarGuard // TODO: restore active socket count via registry
      workspaceRoot: WORKSPACE_ROOT,
      vercelCliAvailable: true,
      realtimeEnabled: REALTIME_ENABLED,
      openaiApiStatus: openaiStatus,
    }
  })

  // Deploy shortcut (HTTP POST, no WebSocket needed)
  const DeployBodySchema = z.object({
    commitMsg: z.string().min(1),
  })

  app.post("/api/tokidapp/deploy", async (request, reply) => {
    try {
      const body = DeployBodySchema.parse(request.body ?? {})
      const send = (msg: string) => {} // no-op for HTTP path
      const gitResult = await gitCommitPush(body.commitMsg, WORKSPACE_ROOT, STARGUARD_BASE, send)
      const deployResult = await triggerVercelDeploy(WORKSPACE_ROOT, send)
      return { git: gitResult, deploy: deployResult }
    } catch (error) {
      request.log.error({ err: error }, "TokiDAPP deploy failed")
      reply.code(500)
      return { error: (error as Error).message }
    }
  })

  // WS session info
  const SessionQuerySchema = z.object({
    token: z.string().min(1),
  })

  app.get("/api/tokidapp/ws/info", async (request, reply) => {
    try {
      const query = SessionQuerySchema.parse(request.query)
      return { sessionId: tokidappSessionId(query.token), active: !!getTokidappSocket(tokidappSessionId(query.token)) }
    } catch {
      reply.code(400)
      return { error: "token required" }
    }
  })

  // ── Recording Routes ───────────────────────────────────────
  // The client uploads audio directly to Vercel Blob; we store metadata here.

  app.post("/api/tokidapp/recordings", async (request, reply) => {
    try {
      const { blobUrl, sessionId, duration } = (request.body ?? {}) as Record<string, unknown>
      if (!blobUrl || typeof blobUrl !== "string") {
        reply.code(400)
        return { error: "blobUrl is required" }
      }

      // Proxy recording metadata to StarGuard for persistence
      // Non-fatal: if StarGuard is unreachable, we persist locally instead.
      let recording: Record<string, unknown>
      try {
        const res = await apiPost("/api/tokidapp/recordings", {
          blobUrl,
          sessionId: sessionId ?? "unknown",
          duration: Number(duration) || 0,
        })
        recording = res.ok ? await res.json() : {
          id: crypto.randomUUID(),
          blobUrl,
          sessionId: sessionId ?? "unknown",
          duration: Number(duration) || 0,
        }
      } catch (proxyErr) {
        request.log.warn({ err: proxyErr }, "StarGuard proxy unavailable, persisting recording locally")
        recording = {
          id: crypto.randomUUID(),
          blobUrl,
          sessionId: sessionId ?? "unknown",
          duration: Number(duration) || 0,
        }
      }

      // Persist locally so recordings survive server restarts
      // even when StarGuard is unreachable.
      addLocalRecording({
        id: recording.id as string,
        sessionId: recording.sessionId as string,
        blobUrl: recording.blobUrl as string,
        duration: Number(recording.duration) || 0,
        createdAt: new Date().toISOString(),
      })

      return recording
    } catch (error) {
      request.log.error({ err: error }, "Failed to save recording")
      reply.code(500)
      return { error: "Failed to save recording" }
    }
  })

  app.get("/api/tokidapp/recordings", async (request, reply) => {
    try {
      const query = request.query as Record<string, string>
      const sessionId = query.sessionId

      if (!sessionId) {
        return { recordings: [] }
      }

      // Try StarGuard first; fall back to local store if unavailable
      try {
        const res = await apiGet("/api/tokidapp/recordings", { sessionId })
        if (res.ok) {
          const contentType = res.headers.get("content-type") || ""
          if (contentType.includes("application/json")) {
            return await res.json()
          }
        }
      } catch {
        request.log.warn("StarGuard proxy unavailable, reading recordings from local store")
      }

      // Fall back to locally-persisted recordings
      const localRecordings = getLocalRecordings(sessionId)
      return { recordings: localRecordings }
    } catch {
      // Even on unexpected errors, return empty rather than 500
      return { recordings: [] }
    }
  })

  // ── Translation Route (EN ↔ ID) ────────────────────────────

  app.post("/api/tokidapp/translate", async (request, reply) => {
    try {
      const { text, source, target } = (request.body ?? {}) as Record<string, string>
      if (!text) {
        reply.code(400)
        return { error: "text is required" }
      }

      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) {
        // Fallback: return original text
        return { translation: text }
      }

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a translator. Translate the following text from ${source || "en"} to ${target || "id"}. Return ONLY the translated text, no explanations, no quotes.`,
            },
            {
              role: "user",
              content: text,
            },
          ],
          max_tokens: 200,
        }),
      })

      if (!response.ok) {
        request.log.error({ status: response.status }, "Translation API failed")
        return { translation: text }
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      const translation = data?.choices?.[0]?.message?.content?.trim() ?? text
      return { translation }
    } catch (error) {
      request.log.error({ err: error }, "Translation failed")
      return { translation: (request.body as Record<string, string>)?.text ?? "" }
    }
  })

  // ── Orchestrator Routes ────────────────────────────────────

  app.post("/api/tokidapp/orchestrator", async (request, reply) => {
    try {
      const { sessionId, voiceMode = true } = (request.body || {}) as Record<string, unknown>

      const res = await apiPost("/api/tokidapp/orchestrator", { sessionId, voiceMode })

      if (!res.ok) {
        reply.code(res.status)
        return { error: "Failed to create orchestrator session" }
      }

      const orchestrator = await res.json()
      return orchestrator
    } catch (error) {
      reply.code(500)
      return { error: (error as Error).message }
    }
  })

  app.get("/api/tokidapp/orchestrator/:id", async (request, reply) => {
    try {
      const { id } = request.params as Record<string, string>
      const res = await apiGet(`/api/tokidapp/orchestrator/${id}`)
      if (!res.ok) {
        reply.code(res.status)
        return { error: "Not found" }
      }
      return await res.json()
    } catch (error) {
      reply.code(500)
      return { error: (error as Error).message }
    }
  })

  // ── Approval Routes ────────────────────────────────────────

  app.get("/api/tokidapp/approvals", async (request, reply) => {
    try {
      const query = request.query as Record<string, string>
      const params = new URLSearchParams()
      if (query.status) params.set("status", query.status)
      if (query.orchestratorId) params.set("orchestratorId", query.orchestratorId)
      if (query.assignedTo) params.set("assignedTo", query.assignedTo)

      const res = await apiGet("/api/tokidapp/approvals", Object.fromEntries(params))
      if (!res.ok) return []
      return await res.json()
    } catch {
      reply.code(500)
      return { error: "Failed to fetch approvals" }
    }
  })

  app.post("/api/tokidapp/approvals/:id/approve", async (request, reply) => {
    try {
      const { id } = request.params as Record<string, string>
      const { comment } = (request.body || {}) as Record<string, string>
      const success = await submitApprovalDecision(id, "approve", comment)
      if (!success) {
        reply.code(409)
        return { error: "Could not approve" }
      }
      return { approved: id }
    } catch (error) {
      reply.code(500)
      return { error: (error as Error).message }
    }
  })

  app.post("/api/tokidapp/approvals/:id/reject", async (request, reply) => {
    try {
      const { id } = request.params as Record<string, string>
      const { comment } = (request.body || {}) as Record<string, string>
      const success = await submitApprovalDecision(id, "reject", comment)
      if (!success) {
        reply.code(409)
        return { error: "Could not reject" }
      }
      return { rejected: id }
    } catch (error) {
      reply.code(500)
      return { error: (error as Error).message }
    }
  })
}

// ── Recording Audio Upload & Serve ───────────────────────────
// Accepts raw audio/webm uploads, serves them back as static files.
// The existing POST /api/tokidapp/recordings handles metadata persistence.

export function registerRecordingRoutes(app: FastifyInstance) {
  const recordingsDir = path.join(os.homedir(), ".config", "codenomad", "recordings")
  fs.mkdirSync(recordingsDir, { recursive: true })

  app.register(async (instance) => {
    // Accept raw audio/webm body without breaking JSON parser on parent scope.
    instance.addContentTypeParser("audio/webm", { parseAs: "buffer" }, (_req, body, done) => done(null, body))

    // Upload raw audio → returns { blobUrl }
    instance.post("/api/tokidapp/recordings/audio", async (request, reply) => {
      try {
        const buffer = request.body as Buffer
        if (!buffer || buffer.length === 0) {
          reply.code(400)
          return { error: "Empty audio body" }
        }

        const sessionId = (request.headers["x-session-id"] || "unknown") as string
        const duration = Number(request.headers["x-duration"]) || 0
        const id = crypto.randomUUID()
        const filename = `${id}.webm`
        const filePath = path.join(recordingsDir, filename)
        fs.writeFileSync(filePath, buffer)

        return { blobUrl: `/api/tokidapp/recordings/files/${filename}` }
      } catch (error) {
        request.log.error({ err: error }, "Failed to save recording audio")
        reply.code(500)
        return { error: "Failed to save recording audio" }
      }
    })

    // Serve recorded audio file
    instance.get("/api/tokidapp/recordings/files/:filename", async (request, reply) => {
      try {
        const { filename } = request.params as { filename: string }
        // Basic path-traversal protection
        const normalized = path.normalize(filename).replace(/^(\.\.(\/|\\|$))+/, "")
        const filePath = path.join(recordingsDir, normalized)

        if (!filePath.startsWith(recordingsDir) || !fs.existsSync(filePath)) {
          reply.code(404)
          return { error: "File not found" }
        }

        reply.type("audio/webm").send(fs.readFileSync(filePath))
      } catch (error) {
        reply.code(500)
        return { error: "Failed to serve recording" }
      }
    })
  })
}

// ── WebSocket Upgrade Handler ────────────────────────────────



// ── Causal Graph Update Helper ───────────────────────────────

function emitCausalGraphUpdate(
  send: (msg: string) => void,
  toolName: string,
  result: string,
  stepId: string,
) {
  const now = Date.now()
  const rand = Math.random().toString(36).slice(2, 6)
  const evidenceId = `evidence-${now}-${rand}`
  const nodes: any[] = [{
    id: evidenceId,
    nodeType: "Evidence",
    label: `Tool: ${toolName}`,
    description: result.slice(0, 300),
    confidence: 1.0,
    sourceStepId: stepId,
  }]
  const edges: any[] = []

  // Hypothesis for analysis tools
  if (["investigate_codebase", "analyze", "diagnose", "plan", "evaluate"].includes(toolName)) {
    const hypothesisId = `hypothesis-${now}-${rand}`
    nodes.push({
      id: hypothesisId,
      nodeType: "Hypothesis",
      label: `Analysis from ${toolName}`,
      description: result.slice(0, 150),
      confidence: 0.6,
      sourceStepId: stepId,
    })
    edges.push({
      sourceId: evidenceId,
      targetId: hypothesisId,
      label: "REVEALS",
    })
  }

  // Vulnerability for security/audit tools
  if (["security_scan", "run_a11y_audit"].includes(toolName)) {
    const vulnId = `vuln-${now}-${rand}`
    nodes.push({
      id: vulnId,
      nodeType: "Vulnerability",
      label: `Finding: ${toolName}`,
      description: result.slice(0, 200),
      confidence: 0.8,
      sourceStepId: stepId,
    })
    edges.push({
      sourceId: evidenceId,
      targetId: vulnId,
      label: "REVEALS",
    })
  }

  // Exploit for test failures
  if (toolName === "run_tests" && result.toLowerCase().includes("fail")) {
    const exploitId = `exploit-${now}-${rand}`
    nodes.push({
      id: exploitId,
      nodeType: "Exploit",
      label: `Test failure: ${stepId}`,
      description: result.slice(0, 200),
      confidence: 0.9,
      sourceStepId: stepId,
    })
    edges.push({
      sourceId: evidenceId,
      targetId: exploitId,
      label: "ENABLES",
    })
  }

  send(JSON.stringify({
    type: "causal_graph_update",
    causalNodes: nodes,
    causalEdges: edges,
  }))
}


export function registerTokidappWebSocket(app: FastifyInstance) {
  app.server.on("upgrade", (request, socket, head) => {
    const rawUrl = request.url ?? "/"
    let parsed: URL
    try {
      parsed = new URL(rawUrl, "http://localhost")
    } catch {
      return
    }

    if (!parsed.pathname.startsWith("/api/tokidapp/ws")) return

    const token = parsed.searchParams.get("token") || ""
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }

    tokidappWss.handleUpgrade(request, socket, head, (ws) => {
      attachTokidappSocket(ws, token)
    })
  })
}

function attachTokidappSocket(ws: WebSocket, token: string) {
  const sessionId = tokidappSessionId(token)
  const socketRef: WsSocketRef = {
    send: (msg: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg)
    },
    close: (code?: number, reason?: string) => {
      ws.close(code, reason)
    },
  }

  registerTokidappSocket(sessionId, socketRef)

  socketRef.send(JSON.stringify({
    type: "orchestrator_greeting",
    sessionId,
    voiceMode: REALTIME_ENABLED,
    content: "TokiDAPP Orchestrator connected. I can investigate code, generate features, run tests, orchestrate workflows with parallel execution, request approvals, and deploy to Vercel. Try saying: 'Analyze the current state and plan the next steps'.",
  }))

  if (REALTIME_ENABLED) {
    const greetingText = "Hello, I am your StarCARD orchestrator. I can help you investigate, build, test, deploy, and manage your entire workflow. What would you like to do?"
    socketRef.send(JSON.stringify({
      type: "stream",
      delta: greetingText,
    }))
  }

  const orchestratorSessions = new Map<string, string>()
  const taskWatchers = new Map<string, () => void>()
  let dbSessionId: string | null = null

  const cleanup = () => {
    unregisterTokidappSocket(sessionId)
    orchestratorSessions.delete(sessionId)
    // Clean up all nomadworks task watchers for this session
    for (const [, unwatch] of taskWatchers) {
      unwatch()
    }
    taskWatchers.clear()
    clearAudioBuffer(sessionId)
    endVoiceSession(sessionId)
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) return
    const raw = typeof data === "string" ? data : data.toString("utf8")
    const trimmed = raw.trim()
    if (!trimmed) return

    try {
      const msg = JSON.parse(trimmed)

          if (msg.type === "ping") {
            socketRef.send(JSON.stringify({ type: "pong", ts: Date.now() }))
            return
          }

          if (msg.type === "cancel") {
            socketRef.send(JSON.stringify({ type: "message", content: "Cancelled." }))
            return
          }

          if (msg.type === "voice_start") {
            if (REALTIME_ENABLED) {
              startVoiceRealtimeSession(sessionId, msg.voice, socketRef)
            } else {
              socketRef.send(JSON.stringify({ type: "message", content: "Voice mode requires OPENAI_API_KEY." }))
            }
            return
          }

          if (msg.type === "voice_stop") {
            if (hasEnoughInputAudio(sessionId)) {
              commitAudioBuffer(sessionId)
            } else {
              resetInputAudio(sessionId)
              socketRef.send(JSON.stringify({
                type: "voice_cancelled",
                content: "No speech detected. Hold the microphone a little longer.",
              }))
            }
            return
          }

          if (msg.type === "voice_disconnect") {
            // Full teardown of the voice session
            endVoiceSession(sessionId)
            clearAudioBuffer(sessionId)
            socketRef.send(JSON.stringify({ type: "voice_disconnected" }))
            return
          }

          if (msg.type === "audio" && msg.data) {
            sendAudioChunk(sessionId, msg.data)
            return
          }

          if (msg.type === "session_bind" && msg.sessionId) {
            const candidate = String(msg.sessionId).trim()
            if (!candidate || isWsTransportSessionKey(candidate)) {
              socketRef.send(JSON.stringify({
                type: "error",
                content: "session_bind requires StarWorld DB sessionId",
              }))
              return
            }
            dbSessionId = candidate
            socketRef.send(JSON.stringify({ type: "session_bound", sessionId: candidate }))
            return
          }

          if (msg.type === "orchestrate" && msg.intent) {
            handleOrchestrateMessage(
              sessionId,
              dbSessionId,
              msg.intent as string,
              (msg.context as Record<string, unknown>) || {},
              socketRef,
              orchestratorSessions,
            )
            return
          }

          if (msg.type === "approval_decision" && msg.approvalId) {
            // Resolve an approval decision in real-time
            ;(async () => {
              const decision = msg.decision as string
              if (decision === "approve" || decision === "reject") {
                resolveApproval(
                  msg.approvalId as string,
                  decision === "approve" ? "approved" : "rejected",
                )

                // Also persist to StarGuard
                await submitApprovalDecision(
                  msg.approvalId as string,
                  decision as "approve" | "reject",
                  msg.comment as string | undefined,
                )

                socketRef.send(JSON.stringify({
                  type: "approval_update",
                  approvalId: msg.approvalId,
                  status: decision === "approve" ? "APPROVED" : "REJECTED",
                }))
              }
            })()
            return
          }

          if (msg.type === "dag_query") {
            // Return current DAG state
            ;(async () => {
              await sendOrchestratorStateForSession(sessionId, dbSessionId, orchestratorSessions, socketRef)
            })()
            return
          }

          if (msg.type === "message" && msg.content) {
            routeMessage(
              msg.content,
              (outgoing) => socketRef.send(outgoing),
              msg.workflowSlug,
              msg.workflowStep,
              msg.agentType,
              dbSessionId,
            )
            return
          }

          if (msg.type === "deploy" && msg.commitMsg) {
            ;(async () => {
              const gitResult = await gitCommitPush(msg.commitMsg, WORKSPACE_ROOT, STARGUARD_BASE, (outgoing) => socketRef.send(outgoing))
              socketRef.send(JSON.stringify({ type: "deploy_status", status: "committed", commitMsg: msg.commitMsg, commitHash: gitResult }))

              const deployResult = await triggerVercelDeploy(WORKSPACE_ROOT, (outgoing) => socketRef.send(outgoing))
              socketRef.send(JSON.stringify({ type: "deploy_status", status: deployResult.includes("failed") ? "failed" : "building", logs: deployResult }))
            })()
            return
          }

          if (msg.type === "nomadworks_invoke") {
            ;(async () => {
              try {
                const starworldSessionId = resolveStarworldSessionId(dbSessionId)
                if (!starworldSessionId) {
                  socketRef.send(JSON.stringify({
                    type: "error",
                    content: "StarWorld session not bound. Reconnect TokiDAPP from StarGuard.",
                  }))
                  return
                }
                const result = await bridge.createTaskFile({
                  intent: msg.intent || "",
                  agentType: msg.agentType || "developer",
                  context: (msg.context as Record<string, unknown>) || {},
                  sessionId: starworldSessionId,
                  complexity: msg.complexity as "tiny" | "standard" | "complex" | undefined,
                })
                socketRef.send(JSON.stringify({ type: "nomadworks_task_status", ...result, status: "created" }))

                // Start watching for task status changes and stream updates back to client
                const unwatch = bridge.watchTask(result.taskId, (outgoing) => socketRef.send(outgoing))
                taskWatchers.set(result.taskId, unwatch)
              } catch (err) {
                socketRef.send(JSON.stringify({ type: "error", content: `nomadworks_invoke failed: ${(err as Error).message}` }))
              }
            })()
            return
          }

          if (msg.type === "nomadworks_status") {
            ;(async () => {
              try {
                const status = await bridge.readTaskStatus(msg.taskId as string)
                if (status) {
                  socketRef.send(JSON.stringify({ type: "nomadworks_task_status", ...status }))
                } else {
                  socketRef.send(JSON.stringify({ type: "error", content: `Task ${msg.taskId} not found` }))
                }
              } catch (err) {
                socketRef.send(JSON.stringify({ type: "error", content: `nomadworks_status failed: ${(err as Error).message}` }))
              }
            })()
            return
          }

          if (msg.type === "nomadworks_list") {
            ;(async () => {
              try {
                const sessionId = msg.sessionId as string | undefined
                const tasks = await bridge.listTasks(sessionId)
                socketRef.send(JSON.stringify({
                  type: "nomadworks_list",
                  tasks,
                }))
              } catch (err) {
                socketRef.send(JSON.stringify({ type: "error", content: `nomadworks_list failed: ${(err as Error).message}` }))
              }
            })()
            return
          }

        } catch {
          // Ignore malformed JSON
        }
      })

  ws.on("close", cleanup)
  ws.on("error", cleanup)
}

// ── Orchestrate Message Handler ──────────────────────────────

async function handleOrchestrateMessage(
  wsSessionId: string,
  dbSessionId: string | null,
  intent: string,
  context: Record<string, unknown>,
  socketRef: { send: (msg: string) => void },
  orchestratorSessions: Map<string, string>,
): Promise<void> {
  try {
    const starworldSessionId = resolveStarworldSessionId(dbSessionId)
    if (!starworldSessionId) {
      socketRef.send(JSON.stringify({
        type: "error",
        content: "StarWorld session not bound. Reconnect TokiDAPP from StarGuard.",
      }))
      return
    }

    const orchRes = await apiPost("/api/tokidapp/orchestrator", { sessionId: starworldSessionId, voiceMode: REALTIME_ENABLED })

    if (!orchRes.ok) {
      socketRef.send(JSON.stringify({ type: "error", content: "Failed to create orchestrator session" }))
      return
    }

    const orchestrator = await orchRes.json()
    const orchestratorId = orchestrator.id
    orchestratorSessions.set(wsSessionId, orchestratorId)

    socketRef.send(JSON.stringify({ type: "orchestrator_state", orchestratorId, status: "created", voiceMode: REALTIME_ENABLED }))

    // Build DAG from intent
    const { nodes, phases } = buildLifecycleDAG(
      (context.intentType as string) || "QUERY_INFO",
      intent,
      (context.entities as Record<string, string>) || {},
    )

    const dag: DAGDefinition = {
      id: `dag_${Date.now()}`,
      nodes,
      createdAt: new Date().toISOString(),
    }

    socketRef.send(JSON.stringify({
      type: "message",
      content: `Analyzing: ${phases.join(" → ")}`,
    }))

    // Callbacks stream progress back via socketRef
    const callbacks: ExecutionCallbacks = {
      onNodeStart: (node: DAGNode) => {
        socketRef.send(JSON.stringify({
          type: "dag_node_status",
          nodeId: node.title,
          nodeName: node.title,
          status: "RUNNING",
          progress: 0,
        }))
      },
      onNodeComplete: (node: DAGNode) => {
        socketRef.send(JSON.stringify({
          type: "dag_node_status",
          nodeId: node.title,
          nodeName: node.title,
          status: "COMPLETED",
          progress: 100,
          output: node.toolOutput,
        }))
      },
      onNodeFail: (node: DAGNode, error: string) => {
        socketRef.send(JSON.stringify({
          type: "dag_node_status",
          nodeId: node.title,
          nodeName: node.title,
          status: "FAILED",
          progress: 0,
          error,
        }))
      },
      onApprovalRequired: async (node: DAGNode, ctx: Record<string, unknown>) => {
        const approvalId = await createApprovalRequest(
          orchestratorId,
          node,
          ctx,
          (node.metadata?.assignedToUserId as string) || undefined,
        )

        socketRef.send(JSON.stringify({
          type: "approval_request",
          approvalId,
          title: node.title,
          context: ctx,
          nodeId: node.title,
        }))

        const decision = await waitForApprovalDecision(approvalId)

        socketRef.send(JSON.stringify({
          type: "approval_update",
          approvalId,
          status: decision === "approved" ? "APPROVED" : "REJECTED",
        }))

        return decision
      },
      onBroadcast: (channel: string, event: string, data: unknown) => {
        socketRef.send(JSON.stringify({
          type: "broadcast",
          channel,
          event,
          data,
        }))
      },
      onCausalGraphUpdate: (nodes, edges) => {
        socketRef.send(JSON.stringify({
          type: "causal_graph_update",
          causalNodes: nodes,
          causalEdges: edges,
        }))
      },
      onLog: (eventType: string, severity: string, title: string, metadata?: Record<string, unknown>) => {
        socketRef.send(JSON.stringify({
          type: "event_log",
          eventType,
          severity,
          summary: title,
          metadata,
          timestamp: new Date().toISOString(),
        }))

        // Also persist to StarGuard
        apiPost("/api/tokidapp/events", {
          orchestratorId,
          eventType,
          severity,
          title,
          metadata,
        }).catch(() => {})
      },
    }

    // Execute the DAG
    const result = await executeDAG(orchestratorId, dag, callbacks)

    socketRef.send(JSON.stringify({
      type: "orchestrator_state",
      orchestratorId,
      status: result.success ? "completed" : "failed",
      result: {
        success: result.success,
        completedNodes: result.completedNodes,
        failedNodes: result.failedNodes,
        skippedNodes: result.skippedNodes,
        totalNodes: result.totalNodes,
        durationMs: result.durationMs,
      },
    }))

    if (result.success) {
      socketRef.send(JSON.stringify({
        type: "voice_task_complete",
        content: `Your workflow finished. ${result.completedNodes} steps completed. Would you like a quick overview, or should I fast-track the next planned tasks?`,
        completedNodes: result.completedNodes,
        durationMs: result.durationMs,
      }))
      socketRef.send(JSON.stringify({
        type: "message",
        content: `✅ Orchestration complete! ${result.completedNodes} tasks completed in ${(result.durationMs / 1000).toFixed(1)}s.`,
      }))
    } else {
      socketRef.send(JSON.stringify({
        type: "error",
        content: `Orchestration finished with errors: ${result.failedNodes} failed, ${result.skippedNodes} skipped. ${result.error || ""}`,
      }))
    }
  } catch (e) {
    socketRef.send(JSON.stringify({
      type: "error",
      content: `Orchestration error: ${(e as Error).message}`,
    }))
  }
}
