import type { PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { createCodeNomadClient, createCodeNomadRequester, getCodeNomadConfig } from "./lib/client.js"
import { createBackgroundProcessTools } from "./lib/background-process.js"
import { attemptOllamaFallback } from "./lib/ollama-fallback.js"
import { createToolGateClient, type JevAction, type JevPendingAction } from "./lib/tool-gate.js"

let voiceModeEnabled = false

export async function CodeNomadPlugin(input: PluginInput): Promise<{
  tool: ReturnType<typeof createBackgroundProcessTools> & {
    stop_voice_mode: ReturnType<typeof tool>
  }
  "chat.message": CodeNomadChatMessageHook
  event: CodeNomadEventHook
  "permission.ask": CodeNomadPermissionHook
  "tool.execute.before": CodeNomadToolExecuteBeforeHook
}> {
  const config = getCodeNomadConfig()
  const client = createCodeNomadClient(config)
  const requester = createCodeNomadRequester(config)
  const backgroundProcessTools = createBackgroundProcessTools(config, { baseDir: input.directory })
  const opencodeClient = input.client
  const toolGate = createToolGateClient(requester)

  const reportGate = (source: "permission.ask" | "tool.execute.before", action: JevPendingAction, verdict: unknown) => {
    void client.postEvent({
      type: "codenomad.jevGate",
      properties: { source, kind: action.kind, verdict: verdict ?? { status: "degraded", reason: "no-verdict" } },
    })
  }

  await client.startEvents((event) => {
    if (event.type === "codenomad.ping") {
      void client.postEvent({
        type: "codenomad.pong",
        properties: {
          ts: Date.now(),
          pingTs: (event.properties as any)?.ts,
        },
      }).catch(() => {})
      return
    }

    if (event.type === "codenomad.voiceMode") {
      voiceModeEnabled = Boolean((event.properties as { enabled?: unknown } | undefined)?.enabled)
    }
  })

  return {
    tool: {
      ...backgroundProcessTools,
      stop_voice_mode: tool({
        description:
          "Disable voice conversation mode and return to text-only input. " +
          "Call this when the user says 'stop', 'end conversation', 'go back to text', " +
          "or otherwise indicates they want to end the voice conversation.",
        args: {},
        async execute() {
          await requester.requestVoid("/voice-mode", {
            method: "POST",
            body: JSON.stringify({ enabled: false }),
          })
          voiceModeEnabled = false
          return "Voice conversation mode disabled. User will now interact via text input only."
        },
      }),
    },
    async "chat.message"(_input: { sessionID: string }, output: { message: { system?: string } }) {
      if (!voiceModeEnabled) {
        return
      }

      output.message.system = [output.message.system, buildVoiceModePrompt()].filter(Boolean).join("\n\n")
    },
    async "permission.ask"(input: CodeNomadPermissionInput, output: { status: JevAction }) {
      const action: JevPendingAction = {
        kind: String(input.type ?? "unknown"),
        target: normalizeTarget(input.pattern ?? input.title),
        title: typeof input.title === "string" ? input.title : undefined,
        sessionId: typeof input.sessionID === "string" ? input.sessionID : undefined,
      }

      const verdict = await toolGate.classify(action, output.status)
      reportGate("permission.ask", action, verdict)

      // Only an enforced verdict may change the decision, and never to `allow` —
      // widening authority is never the classifier's job.
      if (verdict?.enforced && verdict.status === "ok" && verdict.action !== "allow") {
        output.status = verdict.action
      }
    },
    async "tool.execute.before"(input: { tool: string; sessionID: string; callID: string }, output: { args: any }) {
      // Observation only: this hook cannot block, and a tool call that reached it
      // has already passed every permission the harness intended to apply.
      const action: JevPendingAction = {
        kind: String(input.tool ?? "unknown"),
        detail: summarizeArgs(output.args),
        sessionId: input.sessionID,
      }
      toolGate.observe(action, (verdict) => reportGate("tool.execute.before", action, verdict))
    },
    async event(input: { event: any }) {
      const opencodeEvent = input?.event
      if (!opencodeEvent || typeof opencodeEvent !== "object") return

      if (opencodeEvent.type === "session.error") {
        const properties = opencodeEvent.properties ?? {}
        await attemptOllamaFallback(opencodeClient, properties.sessionID, properties.error).catch((fallbackError) => {
          console.error(
            `[CodeNomadPlugin] Ollama fallback threw for session ${properties.sessionID}:`,
            fallbackError,
          )
        })
      }
    },
  }
}

type CodeNomadChatMessageHook = (
  _input: { sessionID: string },
  output: { message: { system?: string } },
) => Promise<void>

type CodeNomadEventHook = (input: { event: any }) => Promise<void>

/**
 * Structural mirror of the OpenCode `Permission` payload. Declared locally so the
 * packaged plugin does not need `@opencode-ai/sdk` as a dependency.
 */
type CodeNomadPermissionInput = {
  type?: string
  pattern?: string | string[]
  sessionID?: string
  title?: string
}

type CodeNomadPermissionHook = (input: CodeNomadPermissionInput, output: { status: JevAction }) => Promise<void>

type CodeNomadToolExecuteBeforeHook = (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
) => Promise<void>

function normalizeTarget(value: string | string[] | undefined): string | string[] | undefined {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean)
  if (typeof value === "string" && value.trim()) return value
  return undefined
}

/** Compact, single-line rendering of tool args for the classifier state. */
function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return ""
  if (typeof args === "string") return args
  try {
    const json = JSON.stringify(args)
    return json.length > 800 ? `${json.slice(0, 800)}…` : json
  } catch {
    return ""
  }
}

function buildVoiceModePrompt(): string {
  return [
    "Voice conversation mode is enabled.",
    "Prepend your reply with a fenced code block using language `spoken`.",
    "The `spoken` block should be the natural conversational reply you would say out loud to the user. It should be a concise spoken gist of the full response in 2 to 4 natural sentences.",
    "In the spoken block, summarize the main outcome, recommendation, or next step. Sound conversational and natural, not like a document summary.",
    "Do not include code, bullet lists, markdown formatting, or long technical detail in the spoken block.",
    "Do not add generic phrases about whether the user should read more.",
    "Only mention additional written detail when there is something specific that may matter for the user's next response, such as a tradeoff, caveat, risk, open question, exact diff, or test result.",
    "When referring to that written detail, say `below` or `in the message` rather than `detailed section`.",
    "",
    "STOPPING VOICE MODE: If the user says 'stop', 'end conversation', 'go back to text', or similar, call the `stop_voice_mode` tool immediately. Do NOT respond with a `spoken` block \u2014 just call the tool and acknowledge with a plain text message.",
    "",
    "After the `spoken` block, continue with your normal detailed response.",
    "Example:",
    "```spoken\nI implemented the relay-based voice-mode flow and it works with the current plugin bridge. The reconnect caveat is explained below.\n```",
  ].join("\n\n")
}
