import type { PluginInput } from "@opencode-ai/plugin"
import type { AgentPartInput, FilePartInput, Message, Part, SubtaskPartInput, TextPartInput } from "@opencode-ai/sdk"

type OpencodeClient = PluginInput["client"]
type PromptPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput

/**
 * Local Ollama model that takes over a subagent's turn when its assigned
 * provider (usually a free-tier one) hits a rate/token/credit limit for the
 * period. qwen3.6:latest is the largest all-round model in the local Ollama
 * library (36B MoE, 262k context, tool calling + reasoning + vision), so it
 * can carry any agent's tools and instructions, not just simple chat.
 */
const OLLAMA_PROVIDER_ID = "ollama"
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434").replace(/\/+$/, "")
const OLLAMA_FALLBACK_MODEL_ID = process.env.CODENOMAD_OLLAMA_FALLBACK_MODEL?.trim() || "qwen3.6:latest"

const QUOTA_MESSAGE_PATTERN =
  /rate.?limit|too many requests|quota|credits?|resource.?exhausted|payment required|free.?tier/i

// Guards against re-triggering the fallback forever if the recovered turn
// itself keeps failing (e.g. the local Ollama model errors too).
const recoveredMessageIds = new Set<string>()

type SessionErrorPayload = {
  name?: string
  data?: {
    statusCode?: number
    message?: string
  }
}

/** True when an opencode session.error looks like a rate-limit / quota / token-limit failure. */
export function isQuotaOrRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const payload = error as SessionErrorPayload
  const statusCode = payload.data?.statusCode
  if (statusCode === 429 || statusCode === 402) return true

  const message = payload.data?.message ?? ""
  if (payload.name === "APIError" || payload.name === "ProviderAuthError" || payload.name === "UnknownError") {
    return QUOTA_MESSAGE_PATTERN.test(message)
  }
  return false
}

async function isOllamaReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

function toPromptPart(part: Part): PromptPart | null {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text, synthetic: part.synthetic, ignored: part.ignored }
    case "file":
      return { type: "file", mime: part.mime, filename: part.filename, url: part.url, source: part.source }
    case "agent":
      return { type: "agent", name: part.name, source: part.source }
    case "subtask":
      return { type: "subtask", prompt: part.prompt, description: part.description, agent: part.agent }
    default:
      return null
  }
}

/**
 * When a subagent's turn fails with a rate-limit/quota-style error (the
 * common case once a free-tier model runs out for the period), replay its
 * last user turn on the local Ollama fallback model instead of leaving the
 * session dead. Best-effort: any failure here just logs and leaves the
 * session in its original errored state, it never throws into the caller.
 */
export async function attemptOllamaFallback(
  client: OpencodeClient,
  sessionID: string | undefined,
  failedError: unknown,
): Promise<void> {
  if (!sessionID) return
  if (!isQuotaOrRateLimitError(failedError)) return

  const history = await client.session.messages({ path: { id: sessionID } })
  const entries = history.data
  if (!entries || entries.length === 0) return

  let failedAssistant: { info: Message; parts: Part[] } | undefined
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry.info.role === "assistant" && entry.info.error) {
      failedAssistant = entry
      break
    }
  }
  if (!failedAssistant || failedAssistant.info.role !== "assistant") return
  const assistantInfo = failedAssistant.info

  if (assistantInfo.providerID === OLLAMA_PROVIDER_ID) {
    // The local fallback itself just failed — nothing more we can do automatically.
    return
  }

  const messageKey = `${sessionID}:${assistantInfo.id}`
  if (recoveredMessageIds.has(messageKey)) return

  const parentEntry = entries.find((entry) => entry.info.id === assistantInfo.parentID)
  if (!parentEntry || parentEntry.info.role !== "user") return

  const promptParts = parentEntry.parts.map(toPromptPart).filter((part): part is PromptPart => part !== null)
  if (promptParts.length === 0) return

  if (!(await isOllamaReachable())) {
    console.error(
      `[CodeNomadPlugin] ${assistantInfo.providerID}/${assistantInfo.modelID} hit a rate/quota limit on session ${sessionID}, ` +
        `but the local Ollama fallback at ${OLLAMA_BASE_URL} is unreachable. Leaving the session in its errored state.`,
    )
    return
  }

  recoveredMessageIds.add(messageKey)
  console.error(
    `[CodeNomadPlugin] ${assistantInfo.providerID}/${assistantInfo.modelID} hit a rate/quota limit on session ${sessionID}. ` +
      `Falling back to local Ollama (${OLLAMA_FALLBACK_MODEL_ID}) so the "${parentEntry.info.agent}" agent can keep going.`,
  )

  const result = await client.session.prompt({
    path: { id: sessionID },
    body: {
      model: { providerID: OLLAMA_PROVIDER_ID, modelID: OLLAMA_FALLBACK_MODEL_ID },
      agent: parentEntry.info.agent,
      parts: promptParts,
    },
  })

  if (result.error) {
    console.error(`[CodeNomadPlugin] Ollama fallback prompt failed for session ${sessionID}:`, result.error)
  }
}
