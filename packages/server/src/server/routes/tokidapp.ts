import { WebSocket, WebSocketServer } from "ws"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import fs from "fs"
import path from "path"
import os from "os"
import Busboy, { type BusboyHeaders } from "@fastify/busboy"
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
  getRealtimeSessionForUser,
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
import {
  createOrchestratorSession,
  findOrchestratorBySessionId,
  findOrchestratorById,
  findRecordingsBySession,
  createRecording,
  findApprovalsByOrchestrator,
  createEvent,
} from "../../lib/tokidapp-queries"
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
  visionAnalyze,
} from "../../plugins/tokidapp/concierge/codebase-tools"
import {
  scanContract,
  getScanStatus,
  listSecurityScans,
  listSolidityContracts,
} from "../../plugins/tokidapp/concierge/security-tools"
import {
  createPrompt,
  resolvePrompt,
  cancelPrompt,
  hasActivePrompt,
  activePromptCount,
} from "../../plugins/tokidapp/concierge/interactive-session"
import {
  askUserPickOne,
  askUserPickMany,
  askUserConfirm,
  askUserText,
  askUserSlider,
} from "../../plugins/tokidapp/concierge/interactive-tools"
import { bridge } from "./nomadworks-bridge"
import { processExecution } from "../../plugins/tokidapp/workflow-executor"
import { apiPost } from "../../plugins/tokidapp/orchestrator/starguard-client"

const WORKSPACE_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()
const REALTIME_ENABLED = !!process.env.OPENAI_API_KEY
const STARGUARD_BASE = process.env.STARGUARD_BASE_URL || "https://star-worlds.vercel.app"

/** Public tunnel URL for constructing blob proxy URLs that OpenAI can fetch.
 *  The tunnel has the blob proxy route and doesn't require JWT auth. */
const TUNNEL_PUBLIC_URL = (process.env.TUNNEL_PUBLIC_URL || "https://chat.tokenizin.com").replace(/\/+$/, "")

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
    const session = await findOrchestratorBySessionId(dbSessionId)
    return session?.id ?? null
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
    const data = await findOrchestratorById(orchestratorId)
    if (data) {
      socketRef.send(JSON.stringify({ type: "orchestrator_state", ...data }))
    }
  } catch { /* ignore */ }
}

// Cache for workflow definitions fetched from StarGuard
let workflowDefinitionsCache: any = null
let workflowCacheTime = 0
const WORKFLOW_CACHE_TTL = 300_000 // 5 minutes

/**
 * Parse a file-attachment context message for image proxy URLs and auto-analyze
 * them via vision API. Returns the enriched content with vision analysis prepended,
 * or the original content if no images are found.
 *
 * The file context message format (from TokiDAPPChatPanel.tsx) is:
 *   [File attachment: image.png (/api/.../proxy?blobUrl=...) — image. ...]
 */
async function enrichAttachmentWithVision(content: string): Promise<string> {
  if (!content.startsWith("[File attachment:")) return content

  // Extract proxy URLs for images: "(url) — image"
  const imageRegex = /\((\/api\/tokidapp\/files\/proxy\?blobUrl=[^)]+)\)\s*—\s*image/gi
  const urls: string[] = []
  let match: RegExpExecArray | null
  while ((match = imageRegex.exec(content)) !== null) {
    urls.push(match[1])
  }

  if (urls.length === 0) return content

  // Limit to first 3 images to keep latency reasonable
  const imagesToAnalyze = urls.slice(0, 3)
  const results: string[] = []

  for (let i = 0; i < imagesToAnalyze.length; i++) {
    const relativeUrl = imagesToAnalyze[i]
    // Resolve against tunnel URL so OpenAI can fetch the image
    // (the tunnel has the blob proxy route and doesn't require JWT auth)
    const fullUrl = `${TUNNEL_PUBLIC_URL}${relativeUrl}`
    try {
      const analysis = await visionAnalyze(
        fullUrl,
        "Describe this image briefly. What kind of content is it? If it contains text, read it. If it's a diagram or chart, explain its structure.",
      )
      results.push(`[Image ${i + 1}: ${analysis}]`)
    } catch (err) {
      results.push(`[Image ${i + 1}: (vision analysis unavailable)]`)
    }
  }

  // Prepend analysis, keep original attachment info for context
  const visionBlock = `Auto-vision analysis of attached image(s):\n${results.join("\n\n")}`
  return `${visionBlock}\n\n${content}`
}

// ── Voice-Chat Union Injection Helpers ─────────────────────

interface InjectionAttachment {
  fileName: string
  mimeType: string
  blobUrl: string
}

const injectionDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingInjectionPayloads = new Map<string, { content: string; attachments: InjectionAttachment[] }>()

function isInjectionAttachment(value: unknown): value is InjectionAttachment {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return typeof v.fileName === "string" && typeof v.mimeType === "string" && typeof v.blobUrl === "string"
}

function normalizeInjectionAttachments(raw: unknown): InjectionAttachment[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isInjectionAttachment)
}

/** Extract per-file extracted text blocks from a file-attachment context message.
 *  Content format: `[fileName (mimeType)]:\n<extracted text>` */
export function extractFileTexts(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const sectionMatch = content.match(/Extracted file contents:\n?([\s\S]*)/i)
  if (!sectionMatch) return result
  const section = sectionMatch[1]
  const blockRegex = /\[(.+?)\s*\(([^)]+)\)\]:\n([\s\S]*?)(?=\n\[|$)/g
  let match: RegExpExecArray | null
  while ((match = blockRegex.exec(section)) !== null) {
    result[match[1].trim()] = match[3].trim()
  }
  return result
}

/** Strip file-attachment metadata from content, leaving any user-typed text. */
export function stripFileMetadata(content: string): string {
  return content
    .replace(/\[File attachment:[\s\S]*?\](?:\n\nExtracted file contents:[\s\S]*)?$/i, "")
    .trim()
}

/** Build Realtime API content items from a text message and optional attachments.
 *  Images become native `input_image` items; non-images become `input_text` with
 *  extracted text. Multiple files are batched into one content array. */
export function buildRealtimeContentItems(
  content: string,
  attachments: InjectionAttachment[],
): Array<{ type: string; [key: string]: unknown }> {
  const items: Array<{ type: string; [key: string]: unknown }> = []

  if (attachments.length === 0) {
    items.push({ type: "input_text", text: content })
    return items
  }

  const extractedTexts = extractFileTexts(content)
  let imageCount = 0

  for (const att of attachments) {
    const isImage = att.mimeType?.toLowerCase().startsWith("image/")
    if (isImage) {
      if (imageCount >= 3) continue
      imageCount++
      const proxyUrl = `${TUNNEL_PUBLIC_URL}/api/tokidapp/files/proxy?blobUrl=${encodeURIComponent(att.blobUrl)}`
      items.push({
        type: "input_image",
        image_url: proxyUrl,
        detail: "auto",
      })
    } else {
      const text = extractedTexts[att.fileName] || `[${att.fileName} (${att.mimeType})]`
      items.push({
        type: "input_text",
        text: `[${att.fileName}]\n${text}`,
      })
    }
  }

  const userText = stripFileMetadata(content)
  if (userText) {
    items.push({ type: "input_text", text: userText })
  }

  return items
}

/** Inject a text/file message into the active Realtime session after a 300ms
 *  debounce. Only the latest message in a rapid burst is injected. */
export function scheduleRealtimeInjection(
  sessionId: string,
  content: string,
  attachments: InjectionAttachment[],
) {
  const existing = injectionDebounceTimers.get(sessionId)
  if (existing) clearTimeout(existing)

  pendingInjectionPayloads.set(sessionId, { content, attachments })

  const timer = setTimeout(() => {
    injectionDebounceTimers.delete(sessionId)
    const pending = pendingInjectionPayloads.get(sessionId)
    pendingInjectionPayloads.delete(sessionId)
    if (!pending) return

    const rtSession = getRealtimeSessionForUser(sessionId)
    if (!rtSession?.connected) {
      console.log("[tokidapp] no active Realtime session for injection, falling through to routeMessage")
      return
    }

    const contentItems = buildRealtimeContentItems(pending.content, pending.attachments)

    // Step 1: Inject the image/text into the conversation context FIRST
    // so any subsequent response.create sees it immediately.
    rtSession.ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: contentItems,
      },
    }))

    // Step 2: Cancel any in-progress response (so the AI stops speaking
    // and processes the new context). Uses the resolved rtSession directly
    // instead of sessionId to avoid cross-socket lookup mismatches.
    if (rtSession.responseInProgress) {
      rtSession.ws.send(JSON.stringify({ type: "response.cancel" }))
      rtSession.responseInProgress = false
      // Drain queue — any dequeued response.create now sees the image context
      const next = rtSession.pendingResponseQueue.shift()
      if (next) next()
    }

    // Step 3: Trigger a new response (or queue if one was just dequeued)
    if (!rtSession.responseInProgress) {
      rtSession.responseInProgress = true
      rtSession.ws.send(JSON.stringify({ type: "response.create" }))
    } else {
      rtSession.pendingResponseQueue.push(() => {
        if (rtSession.connected) {
          rtSession.responseInProgress = true
          rtSession.ws.send(JSON.stringify({ type: "response.create" }))
        }
      })
    }
  }, 300)

  injectionDebounceTimers.set(sessionId, timer)
}

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
  chatSessionId?: string,
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
      // onResponseDone — tell the client to commit streaming text to a chat message
      // when the assistant finishes speaking, so transcripts appear in real-time.
      () => socketRef.send(JSON.stringify({ type: "voice_stream_complete" })),
      voice,
      userId,
      digest || undefined,
      chatSessionId,
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

  ws.on("message", async (data, isBinary) => {
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
          startVoiceRealtimeSession(
            sessionId,
            msg.voice,
            socketRef,
            typeof msg.tokidappSessionId === "string" ? msg.tokidappSessionId : undefined,
          )
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

      if (msg.type === "voice_interrupt") {
        // Barge-in: cancel the current assistant response so the user can
        // interrupt mid-speech. Clear the audio buffer to discard any
        // residual playback capture.
        const sess = getRealtimeSession(sessionId)
        if (sess && sess.responseInProgress) {
          sess.ws.send(JSON.stringify({ type: "response.cancel" }))
          sess.responseInProgress = false
          // Drain any queued responses
          const next = sess.pendingResponseQueue.shift()
          if (next) next()
        }
        clearAudioBuffer(sessionId)
        console.log("[voice-ws] voice_interrupt — cancelled assistant response")
        socketRef.send(JSON.stringify({ type: "voice_interrupted" }))
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
        // Auto-analyze image attachments via vision API and enrich the context.
        // This runs asynchronously — the Realtime session content is enriched
        // before injection so the AI can "see" images without the user asking.
        const enrichedContent = await enrichAttachmentWithVision(msg.content)

        // Inject the text into the OpenAI Realtime session so the voice AI
        // can see what the user typed (e.g. file attachments, follow-ups).
        const rtSession = getRealtimeSession(sessionId)
        if (rtSession?.connected) {
          rtSession.ws.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: enrichedContent }],
            },
          }))
          // Trigger a response so the AI processes the text and responds
          if (!rtSession.responseInProgress) {
            rtSession.responseInProgress = true
            rtSession.ws.send(JSON.stringify({ type: "response.create" }))
          } else {
            rtSession.pendingResponseQueue.push(() => {
              rtSession.responseInProgress = true
              rtSession.ws.send(JSON.stringify({ type: "response.create" }))
            })
          }
        }
        routeMessage(
          enrichedContent,
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

      if (msg.type === "interactive_response") {
        if (!msg.promptId || typeof msg.promptId !== "string") {
          socketRef.send(JSON.stringify({ type: "error", content: "interactive_response requires promptId" }))
          return
        }
        try {
          const resolved = resolvePrompt(msg.promptId, (msg.response as Record<string, unknown>) || {})
          socketRef.send(JSON.stringify({
            type: "interactive_response_ack",
            promptId: msg.promptId,
            status: resolved ? "resolved" : "not_found",
          }))
        } catch (err) {
          socketRef.send(JSON.stringify({
            type: "error",
            content: `interactive_response failed: ${(err as Error).message}`,
          }))
        }
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
      initialStage: "thinking",
      initialMessage: "Creating task and analyzing request...",
    })
    send(JSON.stringify({
      type: 'nomadworks_task_status',
      ...result,
      status: 'created',
      agentType,
      progress_stage: "thinking",
      progress_message: "Creating task and analyzing request...",
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
    const url = urlMatch ? urlMatch[0] : "https://star-worlds.vercel.app"
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
  } else if (hasWord("clickflow") || hasWord("interactive") || hasWord("inline prompt") ||
             (hasWord("ask") && hasWord("me") && (hasWord("about") || hasWord("choose") || hasWord("pick") || hasWord("select")))) {
    // ClickFlow interactive prompts — route to a helper that creates a simple prompt
    send(JSON.stringify({ type: "message", content: "ClickFlow interactive prompts are available. Try: ask_user_pick_one, ask_user_confirm, ask_user_text, ask_user_slider, or ask_user_pick_many." }))
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
`You are Star World Assistant for the StarWORLD ecosystem. ` +
`You help users with codebase tasks: investigating code, generating features, running tests, ` +
`checking git status, deploying to Vercel, spawning agents, scheduling tasks, and scanning contracts. ` +
`If the user's request matches one of these capabilities, route them to the appropriate tool. ` +
`If they ask a general question, answer concisely. ` +
`Keep greetings under 100 characters — no capability listing. ` +
`Keep responses under 200 words. Do NOT read file paths, URLs, wallet addresses, or UUIDs aloud. ` +
`When mentioning a link, do not read the full URL — say the destination name and that a link is provided.`,
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

  // Session creation — proxy to tokidapp sidecar on :8548
  // The sidecar has full DB access; this keeps auth handling and route logic unified.
  app.post("/api/tokidapp/session", async (request, reply) => {
    try {
      const sidecarUrl = "http://127.0.0.1:8548/api/tokidapp/session"
      const rawBody = request.body as Record<string, unknown> | undefined
      const authHeader = (request.headers.authorization ?? "") as string

      const sidecarRes = await fetch(sidecarUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: authHeader,
        },
        body: rawBody ? JSON.stringify(rawBody) : "{}",
        signal: AbortSignal.timeout(10_000),
      })

      const data: unknown = await sidecarRes.json()
      reply.code(sidecarRes.status)
      return data
    } catch (error) {
      request.log.error({ err: error }, "TokiDAPP session proxy to sidecar failed")
      reply.code(502)
      return { error: "Sidecar unavailable" }
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
      const { blobUrl: rawBlobUrl, sessionId, duration } = (request.body ?? {}) as Record<string, unknown>
      if (!rawBlobUrl || typeof rawBlobUrl !== "string") {
        reply.code(400)
        return { error: "blobUrl is required" }
      }

      const safeSessionId: string = typeof sessionId === "string" ? sessionId : "unknown"
      const safeDuration: number = typeof duration === "number" ? duration : typeof duration === "string" ? Number(duration) || 0 : 0

      // Build recording object
      const recording = {
        id: crypto.randomUUID(),
        blobUrl: rawBlobUrl as string,
        sessionId: safeSessionId,
        duration: safeDuration,
      }

      // Persist to DB (non-fatal if unreachable)
      try {
        await createRecording({
          id: recording.id,
          sessionId: recording.sessionId,
          blobUrl: recording.blobUrl,
          duration: recording.duration,
          format: 'webm',
          status: 'completed',
        })
      } catch (dbErr) {
        request.log.warn({ err: dbErr }, 'DB unavailable, recording persisted locally only')
      }

      // Persist locally so recordings survive server restarts
      addLocalRecording({
        id: recording.id,
        sessionId: recording.sessionId,
        blobUrl: recording.blobUrl,
        duration: recording.duration,
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

      // Try DB first; fall back to local store if unavailable
      try {
        const dbRecordings = await findRecordingsBySession(sessionId)
        return { recordings: dbRecordings }
      } catch {
        request.log.warn("DB unavailable, reading recordings from local store")
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
      const { sessionId } = (request.body || {}) as Record<string, unknown>
      const safeSessionId = typeof sessionId === "string" ? sessionId : ""

      const orchId = crypto.randomUUID()
      await createOrchestratorSession({
        id: orchId,
        sessionId: safeSessionId,
        status: "ACTIVE",
      })

      return { id: orchId, status: "ACTIVE" }
    } catch (error) {
      reply.code(500)
      return { error: (error as Error).message }
    }
  })

  app.get("/api/tokidapp/orchestrator/:id", async (request, reply) => {
    try {
      const { id } = request.params as Record<string, string>
      const result = await findOrchestratorById(id)
      if (!result) {
        reply.code(404)
        return { error: "Not found" }
      }
      return result
    } catch (error) {
      reply.code(500)
      return { error: (error as Error).message }
    }
  })

  // ── Approval Routes ────────────────────────────────────────

  app.get("/api/tokidapp/approvals", async (request, reply) => {
    try {
      const query = request.query as Record<string, string>
      if (query.orchestratorId) {
        const approvals = await findApprovalsByOrchestrator(query.orchestratorId)
        return approvals
      }
      return []
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

  // ── File Blob Proxy ─────────────────────────────────────────
  // Proxies private Vercel Blob files so they can be accessed from:
  //   - Browser <img>/<video> tags served through the tunnel
  //   - OpenAI Vision API (via vision_analyze tool)
  //   - OpenAI Realtime API (via input_image items)
  // Uses BLOB_READ_WRITE_TOKEN to fetch from Vercel Blob's private store.
  app.get("/api/tokidapp/files/proxy", async (request, reply) => {
    const query = request.query as { blobUrl?: string }
    if (!query.blobUrl) {
      reply.code(400)
      return { error: "blobUrl query parameter is required" }
    }

    // local:// scheme: serve from local file storage
    if (query.blobUrl.startsWith("local://")) {
      try {
        const localPath = query.blobUrl.slice("local://".length)
        // localPath is expected to be {sessionId}/{filename}
        const uploadsDir = path.join(os.homedir(), ".config", "codenomad", "uploads")
        const normalized = path.normalize(localPath).replace(/^(\.\.(\/|\\|$))+/, "")
        const filePath = path.join(uploadsDir, normalized)

        if (!filePath.startsWith(uploadsDir) || !fs.existsSync(filePath)) {
          reply.code(404)
          return { error: "File not found" }
        }

        const ext = path.extname(filePath).toLowerCase()
        const mimeMap: Record<string, string> = {
          ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
          ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
          ".bmp": "image/bmp", ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ".doc": "application/msword", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ".xls": "application/vnd.ms-excel", ".txt": "text/plain", ".csv": "text/csv",
          ".json": "application/json", ".xml": "application/xml", ".md": "text/markdown",
          ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
          ".zip": "application/zip", ".tar": "application/x-tar", ".gz": "application/gzip",
        }
        const contentType = mimeMap[ext] || "application/octet-stream"

        return reply
          .type(contentType)
          .headers({
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
          })
          .send(fs.readFileSync(filePath))
      } catch (error) {
        request.log.error({ err: error }, "Local file proxy failed")
        reply.code(500)
        return { error: "Failed to serve local file" }
      }
    }

    // Vercel Blob URL (deprecated): proxy from blob storage via auth token.
    // New uploads use local:// URLs from the upload-local endpoint.
    // Keep this handler for backward compatibility with existing Vercel Blob files.
    if (!query.blobUrl.includes("blob.vercel-storage.com")) {
      reply.code(400)
      return { error: "Invalid blob URL" }
    }

    request.log.warn({ blobUrl: query.blobUrl.slice(0, 60) }, "[files/proxy] Deprecated Vercel Blob proxy used — existing file served via blob.vercel-storage.com")

    const token = process.env.BLOB_READ_WRITE_TOKEN
    if (!token) {
      request.log.error("BLOB_READ_WRITE_TOKEN not configured")
      reply.code(500)
      return { error: "Blob proxy not configured" }
    }

    try {
      const res = await fetch(query.blobUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) {
        request.log.error({ status: res.status, blobUrl: query.blobUrl.slice(0, 80) }, "Blob fetch failed")
        reply.code(res.status === 404 ? 404 : 502)
        return { error: `Blob fetch failed: ${res.status}` }
      }

      const contentType = res.headers.get("content-type") || "application/octet-stream"
      const arrayBuffer = await res.arrayBuffer()

      return reply
        .type(contentType)
        .headers({
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        })
        .send(Buffer.from(arrayBuffer))
    } catch (error) {
      request.log.error({ err: error }, "Blob proxy fetch failed")
      reply.code(502)
      return { error: "Failed to fetch blob" }
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

// ── Local File Upload & Serve ────────────────────────────────
// Accepts multipart file uploads, stores to local disk, serves back.
// Supports images, PDFs, documents, text files, and common formats.
// Extraction of text content runs in background via StarGuard API.
// Vercel Blob remains as fallback when local storage is unavailable.

const ALLOWED_UPLOAD_MIME_PREFIXES = [
  "image/", "video/", "application/pdf", "application/msword",
  "application/vnd.openxmlformats-officedocument.",
  "application/vnd.ms-", "text/", "application/json", "application/xml",
  "application/zip", "application/x-tar", "application/gzip", "audio/",
]

function isAllowedUploadMime(mime: string): boolean {
  return ALLOWED_UPLOAD_MIME_PREFIXES.some((p) => mime.toLowerCase().startsWith(p))
}

function extractImageDimensions(buffer: Buffer, mimeType: string): { width: number | null; height: number | null } {
  let width: number | null = null
  let height: number | null = null
  try {
    if (mimeType === "image/jpeg" && buffer.length > 20) {
      for (let i = 0; i < buffer.length - 10; i++) {
        if (buffer[i] === 0xff && buffer[i + 1] === 0xc0) {
          height = (buffer[i + 5] << 8) | buffer[i + 6]
          width = (buffer[i + 7] << 8) | buffer[i + 8]
          break
        }
      }
    }
    if (mimeType === "image/png" && buffer.length >= 24) {
      width = (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19]
      height = (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23]
    }
    if ((mimeType === "image/gif") && buffer.length >= 10) {
      width = buffer[7] << 8 | buffer[6]
      height = buffer[9] << 8 | buffer[8]
    }
    if (mimeType === "image/webp" && buffer.length > 30) {
      const riff = new TextDecoder().decode(buffer.slice(0, 4))
      if (riff === "RIFF") {
        const vp8 = new TextDecoder().decode(buffer.slice(12, 16))
        if (vp8 === "VP8 " && buffer.length > 30) {
          width = (buffer[26] | ((buffer[27] & 0x3f) << 8))
          height = (buffer[28] | ((buffer[29] & 0x3f) << 8))
        } else if (vp8 === "VP8L" && buffer.length > 25) {
          const bits = (buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24)) >>> 0
          width = (bits & 0x3fff) + 1
          height = ((bits >> 14) & 0x3fff) + 1
        }
      }
    }
  } catch { /* non-fatal */ }
  return { width, height }
}

export function registerFileUploadRoutes(app: FastifyInstance) {
  const uploadsDir = path.join(os.homedir(), ".config", "codenomad", "uploads")
  fs.mkdirSync(uploadsDir, { recursive: true })

  // Scoped plugin for file upload (needs multipart/form-data content type parser)
  // to avoid Fastify trying to parse the body before busboy can read the raw stream.
  app.register(async (instance) => {
    // Pass multipart bodies through as raw buffers so busboy can parse them
    instance.addContentTypeParser("multipart/form-data", { parseAs: "buffer", bodyLimit: 210 * 1024 * 1024 }, (_req, body, done) => done(null, body))

    // Upload file to local storage
    // POST /api/tokidapp/files/upload-local
    instance.post("/api/tokidapp/files/upload-local", async (request, reply) => {
      try {
        // Parse multipart form using busboy from the already-parsed body buffer.
        // Fastify consumed the raw stream via addContentTypeParser; we create a
        // Readable from the parsed buffer and pipe that through busboy.
        const bodyBuffer = request.body as Buffer
        if (!bodyBuffer || bodyBuffer.length === 0) {
          reply.code(400)
          return { error: "Empty request body" }
        }

        const { Readable } = await import("stream")
        const busboy = new Busboy({
          headers: request.raw.headers as unknown as BusboyHeaders,
          limits: { fileSize: 200 * 1024 * 1024, files: 1 }, // 200 MB max
        })

        const result = await new Promise<{
        fields: Record<string, string>
        fileBuffer: Buffer | null
        filename: string | null
        mimeType: string | null
      }>((resolve, reject) => {
        const ctx = { fields: {} as Record<string, string>, fileBuffer: null as Buffer | null, filename: null as string | null, mimeType: null as string | null }

        busboy.on("file", (fieldname, stream, filename, _encoding, mimeType) => {
          const chunks: Buffer[] = []
          stream.on("data", (chunk: Buffer) => chunks.push(chunk))
          stream.on("end", () => {
            ctx.fileBuffer = Buffer.concat(chunks)
            ctx.filename = filename
            ctx.mimeType = mimeType
          })
          stream.on("error", reject)
        })

        busboy.on("field", (fieldname, value) => {
          ctx.fields[fieldname] = value
        })

        busboy.on("finish", () => resolve(ctx))
        busboy.on("error", reject)

        // Pipe the parsed body buffer through busboy for field/file extraction
        Readable.from(bodyBuffer).pipe(busboy)
      })

      if (!result.fileBuffer || !result.filename || !result.mimeType) {
        reply.code(400)
        return { error: "No file provided in upload" }
      }

      if (!isAllowedUploadMime(result.mimeType)) {
        reply.code(400)
        return { error: `File type "${result.mimeType}" is not supported` }
      }

      const sessionId = result.fields.sessionId
      if (!sessionId) {
        reply.code(400)
        return { error: "sessionId field is required" }
      }

      // Sanitize filename and build storage path
      const safeName = result.filename.replace(/[/\\]/g, "_").slice(0, 200)
      const timestamp = Date.now()
      const storedFile = `${timestamp}-${safeName}`
      const sessionDir = path.join(uploadsDir, sessionId)
      fs.mkdirSync(sessionDir, { recursive: true })
      const filePath = path.join(sessionDir, storedFile)
      fs.writeFileSync(filePath, result.fileBuffer)

      // Extract image dimensions for image types
      const { width, height } = result.mimeType.startsWith("image/")
        ? extractImageDimensions(result.fileBuffer, result.mimeType)
        : { width: null, height: null }

      // Fire background extraction via StarGuard extract endpoint
      // This creates the TokiDAPPFileArtifact in StarGuard's database
      const tunnelUrl = `${TUNNEL_PUBLIC_URL}/api/tokidapp/files/local/${sessionId}/${storedFile}`
      extractInBackground(tunnelUrl, safeName, result.mimeType, result.fileBuffer.length, sessionId, result.fileBuffer)

      return {
        url: `local://${sessionId}/${storedFile}`,
        fileName: safeName,
        fileSize: result.fileBuffer.length,
        mimeType: result.mimeType,
        width,
        height,
      }
    } catch (error) {
      request.log.error({ err: error }, "Local file upload failed")
      reply.code(500)
      return { error: "Failed to upload file" }
    }
  })
  }) // end scoped plugin

  // Serve uploaded file from local storage
  // GET /api/tokidapp/files/local/:sessionId/:filename
  app.get("/api/tokidapp/files/local/:sessionId/:filename", async (request, reply) => {
    try {
      const { sessionId, filename } = request.params as { sessionId: string; filename: string }
      const relative = path.join(sessionId, filename)
      const normalized = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "")
      const filePath = path.join(uploadsDir, normalized)

      if (!filePath.startsWith(uploadsDir) || !fs.existsSync(filePath)) {
        reply.code(404)
        return { error: "File not found" }
      }

      const ext = path.extname(filename).toLowerCase()
      const mimeMap: Record<string, string> = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
        ".bmp": "image/bmp", ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc": "application/msword",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls": "application/vnd.ms-excel", ".txt": "text/plain", ".csv": "text/csv",
        ".json": "application/json", ".xml": "application/xml", ".md": "text/markdown",
        ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
        ".wav": "audio/wav", ".ogg": "audio/ogg",
        ".zip": "application/zip", ".tar": "application/x-tar", ".gz": "application/gzip",
        ".js": "application/javascript", ".ts": "application/typescript",
        ".tsx": "application/typescript", ".py": "text/x-python",
        ".html": "text/html", ".css": "text/css",
      }
      const contentType = mimeMap[ext] || "application/octet-stream"

      return reply
        .type(contentType)
        .headers({
          "Cache-Control": "private, max-age=86400",
          "X-Content-Type-Options": "nosniff",
        })
        .send(fs.readFileSync(filePath))
    } catch (error) {
      reply.code(500)
      return { error: "Failed to serve file" }
    }
  })
}

/** Run text extraction on a locally-stored file in the background.
 *  For text-based files, extracts directly. For images, uses OpenAI vision API.
 *  For complex formats, delegates to the StarGuard extract endpoint. */
async function extractInBackground(
  fileUrl: string,
  fileName: string,
  mimeType: string,
  fileSize: number,
  sessionId: string,
  _buffer: Buffer,
): Promise<void> {
  try {
    // Text-based files: extract directly from buffer
    const textMimePrefixes = [
      "text/", "application/json", "application/xml", "application/javascript",
      "application/typescript", "application/yaml", "application/toml",
    ]
    const codeExtensions = [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
      ".py", ".rs", ".go", ".rb", ".java", ".kt", ".swift",
      ".cpp", ".c", ".h", ".hpp",
      ".yaml", ".yml", ".toml", ".json", ".xml",
      ".sh", ".bash", ".zsh", ".fish",
      ".sql", ".graphql", ".gql",
      ".css", ".scss", ".less", ".html", ".svelte", ".vue",
      ".md", ".mdx", ".rst", ".txt",
      ".env", ".gitignore", ".dockerfile",
      ".prisma", ".zmodel",
    ]
    const ext = path.extname(fileName).toLowerCase()
    const isTextExtractable = textMimePrefixes.some((p) => mimeType.startsWith(p))
      || codeExtensions.includes(ext)
    const isImage = mimeType.startsWith("image/")

    let text = ""
    const metadata: Record<string, unknown> = {}

    if (isTextExtractable) {
      // Direct text extraction for simple formats
      text = _buffer.toString("utf-8")
      metadata.encoding = "utf-8"
      metadata.extractionMethod = "direct"
    } else if (isImage) {
      // For images, delegate to StarGuard extract endpoint which uses OpenAI vision API
      // The endpoint will fetch the image via the tunnel URL
    }

    // Create artifact via StarGuard extract endpoint
    const body: Record<string, unknown> = {
      fileName,
      mimeType,
      fileSize,
      sessionId,
      localUrl: fileUrl,
    }
    if (isTextExtractable && text) {
      // For simple text files, we already extracted — pass as extractedText
      body.extractedText = text.slice(0, 100_000)
      body.metadata = metadata
      body.status = "extracted"
    }

    // Call StarGuard extract endpoint (which also accepts localUrl for fetching)
    const res = await apiPost("/api/tokidapp/files/extract", body)
    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown")
      console.error(`[file-upload] Background extraction failed for ${fileName}: HTTP ${res.status} ${errText}`)
    }
  } catch (err) {
    console.error(`[file-upload] Background extraction error for ${fileName}:`, err)
  }
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
    content: "Star World Assistant ready.",
  }))

  if (REALTIME_ENABLED) {
    const greetingText = "Hey there. I'm Star World Assistant. What can I do for you?"
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

  ws.on("message", async (data, isBinary) => {
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
              startVoiceRealtimeSession(
            sessionId,
            msg.voice,
            socketRef,
            typeof msg.tokidappSessionId === "string"
              ? msg.tokidappSessionId
              : dbSessionId ?? undefined,
          )
            } else {
              socketRef.send(JSON.stringify({ type: "message", content: "Voice mode requires OPENAI_API_KEY." }))
            }
            return
          }

          if (msg.type === "voice_interrupt") {
            const sess = getRealtimeSession(sessionId)
            if (sess?.responseInProgress && sess.connected) {
              sess.ws.send(JSON.stringify({ type: "response.cancel" }))
              sess.responseInProgress = false
              const next = sess.pendingResponseQueue.shift()
              if (next) next()
            }
            clearAudioBuffer(sessionId)
            socketRef.send(JSON.stringify({ type: "voice_interrupted" }))
            return
          }

          if (msg.type === "voice_reset") {
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
            const attachments = normalizeInjectionAttachments(msg.attachments)

            // Chat → Voice union: inject into Realtime FIRST with raw content
            // (no await on vision analysis). The Realtime API processes images
            // natively via input_image — GPT-4o-mini pre-analysis is only needed
            // for the routeMessage() fallback and would add 1-3s latency before
            // the realtime injection, creating race conditions with live voice.
            scheduleRealtimeInjection(sessionId, msg.content, attachments)

            // Run vision analysis for routeMessage fallback (can overlap with
            // the 300ms debounce + Realtime response generation).
            const enrichedContent = await enrichAttachmentWithVision(msg.content)

            routeMessage(
              enrichedContent,
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

          if (msg.type === "interactive_response") {
            if (!msg.promptId || typeof msg.promptId !== "string") {
              socketRef.send(JSON.stringify({ type: "error", content: "interactive_response requires promptId" }))
              return
            }
            try {
              const resolved = resolvePrompt(msg.promptId, (msg.response as Record<string, unknown>) || {})
              socketRef.send(JSON.stringify({
                type: "interactive_response_ack",
                promptId: msg.promptId,
                status: resolved ? "resolved" : "not_found",
              }))
            } catch (err) {
              socketRef.send(JSON.stringify({
                type: "error",
                content: `interactive_response failed: ${(err as Error).message}`,
              }))
            }
            return
          }

          if (msg.type === "clickflow_prompt") {
            ;(async () => {
              const promptType = msg.promptType as string | undefined
              const question = msg.question as string | undefined
              if (!promptType || !question) {
                socketRef.send(JSON.stringify({ type: "error", content: "clickflow_prompt requires promptType and question" }))
                return
              }
              try {
                const options = msg.options as Array<{ value: string; label: string; description?: string }> | undefined
                const config = msg.config as Record<string, unknown> | undefined
                const timeoutMs = msg.timeoutMs as number | undefined
                const sendFn = (data: string) => socketRef.send(data)

                let result: Record<string, unknown> = {}
                switch (promptType) {
                  case 'pick_one': {
                    const r = await askUserPickOne({ question, options: options || [], timeoutMs }, sendFn)
                    result = { selected: r.selected, status: r.timeout ? 'timeout' : r.cancelled ? 'cancelled' : 'answered' }
                    break
                  }
                  case 'pick_many': {
                    const r = await askUserPickMany({ question, options: options || [], config: config as any, timeoutMs }, sendFn)
                    result = { selected: r.selected, status: r.timeout ? 'timeout' : r.cancelled ? 'cancelled' : 'answered' }
                    break
                  }
                  case 'confirm': {
                    const r = await askUserConfirm({ question, config: config as any, timeoutMs }, sendFn)
                    result = { choice: r.choice, status: r.timeout ? 'timeout' : r.cancelled ? 'cancelled' : 'answered' }
                    break
                  }
                  case 'ask_text': {
                    const r = await askUserText({ question, config: config as any, timeoutMs }, sendFn)
                    result = { text: r.text, status: r.timeout ? 'timeout' : r.cancelled ? 'cancelled' : 'answered' }
                    break
                  }
                  case 'slider': {
                    const r = await askUserSlider({ question, config: config as { min: number; max: number; step?: number; defaultValue?: number }, timeoutMs }, sendFn)
                    result = { value: r.value, status: r.timeout ? 'timeout' : r.cancelled ? 'cancelled' : 'answered' }
                    break
                  }
                  default:
                    socketRef.send(JSON.stringify({ type: "error", content: `Unknown clickflow prompt type: ${promptType}` }))
                    return
                }
                socketRef.send(JSON.stringify({ type: "clickflow_result", promptType, question, result }))
              } catch (err) {
                socketRef.send(JSON.stringify({
                  type: "error",
                  content: `clickflow_prompt failed: ${(err as Error).message}`,
                }))
              }
            })()
            return
          }

          if (msg.type === "start_execution") {
            const executionId = msg.executionId as string
            if (!executionId) {
              socketRef.send(JSON.stringify({ type: "error", content: "executionId is required" }))
              return
            }
            // Fire-and-forget — engine streams status via 'send'
            processExecution(executionId, (data: string) => {
              socketRef.send(data)
            }).catch((err) => {
              socketRef.send(JSON.stringify({
                type: "error",
                content: `Execution failed: ${err instanceof Error ? err.message : String(err)}`,
              }))
            })
            return
          }

          if (msg.type === "tool_invoke" && msg.tool) {
            ;(async () => {
              const toolName = msg.tool as string
              const mcpServer = msg.mcpServer as string | undefined
              const params = (msg.params as Record<string, unknown>) || {}
              const toolId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

              // Send running status
              socketRef.send(JSON.stringify({
                type: "tool_call",
                id: toolId,
                tool: toolName,
                status: "running",
                summary: `Invoking ${mcpServer ? `${mcpServer} → ` : ""}${toolName}...`,
              }))

              try {
                // Read opencode.json to find MCP server definitions
                const configPath = path.join(WORKSPACE_ROOT, "opencode.json")
                let mcpUrl: string | null = null

                if (fs.existsSync(configPath)) {
                  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
                  if (mcpServer && config.mcp?.[mcpServer]?.url) {
                    mcpUrl = config.mcp[mcpServer].url
                  }
                  // If no specific mcpServer was specified, check opencode.json agent MCP refs
                  if (!mcpUrl) {
                    // Try tools section — specific tool definitions may point to MCP servers
                    for (const [, val] of Object.entries(config.mcp || {})) {
                      const entry = val as { url?: string }
                      if (entry.url) {
                        mcpUrl = entry.url
                        break
                      }
                    }
                  }
                }

                if (mcpUrl) {
                  // Proxy to MCP HTTP endpoint
                  const mcpHeaders: Record<string, string> = {
                    "Content-Type": "application/json",
                  }

                  // Inject Authorization header for OAuth-authenticated MCP servers
                  // HyperAgent requires a Bearer token obtained via browser OAuth flow.
                  // Set HYPERAGENT_MCP_TOKEN env var on the Mac mini host.
                  if (
                    mcpServer === "HyperAgent" &&
                    process.env.HYPERAGENT_MCP_TOKEN
                  ) {
                    mcpHeaders["Authorization"] = `Bearer ${process.env.HYPERAGENT_MCP_TOKEN}`
                  }

                  const response = await fetch(mcpUrl, {
                    method: "POST",
                    headers: mcpHeaders,
                    body: JSON.stringify({
                      name: toolName,
                      params,
                    }),
                  })

                  if (!response.ok) {
                    const errorText = await response.text().catch(() => "Unknown error")
                    throw new Error(`MCP ${mcpServer} returned ${response.status}: ${errorText}`)
                  }

                  const result = await response.text()

                  socketRef.send(JSON.stringify({
                    type: "tool_result",
                    id: toolId,
                    tool: toolName,
                    status: "complete",
                    summary: `${toolName} completed successfully`,
                    result,
                  }))
                } else {
                  // No MCP URL found — acknowledge but can't proxy
                  socketRef.send(JSON.stringify({
                    type: "tool_result",
                    id: toolId,
                    tool: toolName,
                    status: "complete",
                    summary: `${toolName} (no MCP proxy configured — tool dispatched locally)`,
                    result: `Tool "${toolName}" acknowledged. Server-side MCP routing not configured for this tool.`,
                  }))
                }
              } catch (err) {
                socketRef.send(JSON.stringify({
                  type: "tool_result",
                  id: toolId,
                  tool: toolName,
                  status: "error",
                  summary: `${toolName} failed: ${(err as Error).message}`,
                }))
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

    const orchestratorId = crypto.randomUUID()
    try {
      await createOrchestratorSession({
        id: orchestratorId,
        sessionId: starworldSessionId,
        status: "ACTIVE",
      })
    } catch {
      socketRef.send(JSON.stringify({ type: "error", content: "Failed to create orchestrator session" }))
      return
    }
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

        // Also persist event to DB (fire-and-forget, non-fatal)
        createEvent({
          id: crypto.randomUUID(),
          sessionId: orchestratorId,
          eventType: eventType || "orchestrator_event",
          data: JSON.stringify({ orchestratorId, eventType, severity, title, metadata }),
        }).catch((e: Error) => {
          console.error("[tokidapp] Failed to create event:", e.message)
        })
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
