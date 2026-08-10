import { preparePromptDisplayText } from "../lib/prompt-display-metadata"
import { instances } from "./instances"
import { getRootClient } from "./opencode-client"
import { getOpenCodeWorkspaceIdForSession } from "./opencode-workspaces"

import { addRecentModelPreference, getModelThinkingSelection, setAgentModelPreference } from "./preferences"
import { getSessionFamily, getSessionRoot, providers, sessions, setSessionStatus, withSession } from "./session-state"
import { mapSdkSessionStatus, type SessionStatus } from "../types/session"
import { getDefaultModel, isModelValid } from "./session-models"
import { updateSessionInfo } from "./message-v2/session-info"
import { messageStoreBus } from "./message-v2/bus"
import { removeMessagePartV2, removeMessageV2 } from "./message-v2/bridge"
import { getLogger } from "../lib/logger"
import { OpencodeApiError, requestData } from "../lib/opencode-api"
import { clearConversationPlaybackForSession } from "./conversation-speech"

const log = getLogger("actions")

async function getSessionWorkspacePayload(instanceId: string, sessionId: string): Promise<{ workspace?: string }> {
  const workspace = await getOpenCodeWorkspaceIdForSession(instanceId, sessionId)
  // OpenCode requires workspace query values to start with "wrk"; anything else → 500.
  if (workspace && workspace.startsWith("wrk")) {
    return { workspace }
  }
  return {}
}

function getVariantKeysForModel(instanceId: string, model: { providerId: string; modelId: string }): string[] {
  if (!model.providerId || !model.modelId) return []
  const instanceProviders = providers().get(instanceId) || []
  const provider = instanceProviders.find((p) => p.id === model.providerId)
  const match = provider?.models.find((m) => m.id === model.modelId)
  return match?.variantKeys ?? []
}

function getThinkingVariantToSend(instanceId: string, model: { providerId: string; modelId: string }): string | undefined {
  const selected = getModelThinkingSelection(model)
  if (!selected) return undefined
  const keys = getVariantKeysForModel(instanceId, model)
  if (keys.length === 0) return undefined
  return keys.includes(selected) ? selected : undefined
}

const ID_LENGTH = 26
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

let lastTimestamp = 0
let localCounter = 0

function randomBase62(length: number): string {
  let result = ""
  const cryptoObj = (globalThis as unknown as { crypto?: Crypto }).crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const bytes = new Uint8Array(length)
    cryptoObj.getRandomValues(bytes)
    for (let i = 0; i < length; i++) {
      result += BASE62_CHARS[bytes[i] % BASE62_CHARS.length]
    }
  } else {
    for (let i = 0; i < length; i++) {
      const idx = Math.floor(Math.random() * BASE62_CHARS.length)
      result += BASE62_CHARS[idx]
    }
  }
  return result
}

function createId(prefix: string): string {
  const timestamp = Date.now()
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    localCounter = 0
  }
  localCounter++

  const value = (BigInt(timestamp) << BigInt(12)) + BigInt(localCounter)
  const bytes = new Array<number>(6)
  for (let i = 0; i < 6; i++) {
    const shift = BigInt(8 * (5 - i))
    bytes[i] = Number((value >> shift) & BigInt(0xff))
  }
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("")
  const random = randomBase62(ID_LENGTH - 12)

  return `${prefix}_${hex}${random}`
}

async function sendMessage(
  instanceId: string,
  sessionId: string,
  prompt: string,
  attachments: any[] = [],
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const client = getRootClient(instanceId)

  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const messageId = createId("msg")
  const textPartId = createId("prt")

  const preparedPrompt = preparePromptDisplayText(prompt, attachments)

  const optimisticParts: any[] = [
    {
      id: textPartId,
      type: "text" as const,
      text: preparedPrompt.promptToSend,
      synthetic: true,
      renderCache: undefined,
    },
  ]

  const requestParts: any[] = [
    {
      type: "text" as const,
      text: preparedPrompt.promptToSend,
    },
  ]

  if (attachments.length > 0) {
    for (const att of attachments) {
      const source = att.source
      if (source.type === "file") {
        const partId = createId("prt")
        requestParts.push({
          type: "file" as const,
          url: att.url,
          mime: source.mime,
          filename: att.filename,
        })
        optimisticParts.push({
          id: partId,
          type: "file" as const,
          url: att.url,
          mime: source.mime,
          filename: att.filename,
          synthetic: true,
        })
      } else if (source.type === "text") {
        const display: string | undefined = att.display
        const value: unknown = source.value
        const isPastedPlaceholder = typeof display === "string" && /^pasted #\d+/.test(display)
        const isPathPlaceholder = typeof display === "string" && /^path:/.test(display)

        // Skip path: attachments from being sent as separate parts (content is already in prompt)
        // Skip pasted placeholders too (already resolved in prompt)
        if (isPastedPlaceholder || isPathPlaceholder || typeof value !== "string") {
          continue
        }

        const partId = createId("prt")
        requestParts.push({
          type: "text" as const,
          text: value,
        })
        optimisticParts.push({
          id: partId,
          type: "text" as const,
          text: value,
          synthetic: true,
          renderCache: undefined,
        })
      }
    }
  }

  const store = messageStoreBus.getOrCreate(instanceId)
  const createdAt = Date.now()

  clearConversationPlaybackForSession(instanceId, sessionId)

  store.upsertMessage({
    id: messageId,
    sessionId,
    role: "user",
    status: "sending",
    parts: optimisticParts,
    createdAt,
    updatedAt: createdAt,
    isEphemeral: true,
    clientPromptDisplayMetadata: preparedPrompt.displayMetadata,
  })

  withSession(instanceId, sessionId, () => {
    /* trigger reactivity for legacy session data */
  })

  const requestBody = {
    parts: requestParts,
    ...(session.agent && { agent: session.agent }),
    ...(session.model.providerId &&
      session.model.modelId && {
        model: {
          providerID: session.model.providerId,
          modelID: session.model.modelId,
        },
      }),
    ...(session.model.providerId &&
      session.model.modelId &&
      (() => {
        const variant = getThinkingVariantToSend(instanceId, session.model)
        return variant ? { variant } : {}
      })()),
  }

  log.info("sendMessage", {
    instanceId,
    sessionId,
    requestBody,
  })

  try {
    log.info("session.promptAsync", { instanceId, sessionId, requestBody })
    const workspacePayload = await getSessionWorkspacePayload(instanceId, sessionId)
    await requestData(
      client.session.promptAsync({
        sessionID: sessionId,
        ...workspacePayload,
        ...(requestBody as any),
      }),
      "session.promptAsync",
    )
  } catch (error) {
    log.error("Failed to send prompt", error)
    throw error
  }
}

async function executeCustomCommand(
  instanceId: string,
  sessionId: string,
  commandName: string,
  args: string,
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const client = getRootClient(instanceId)

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const body: {
    command: string
    arguments: string
    messageID: string
    agent?: string
    model?: string
    variant?: string
  } = {
    command: commandName,
    arguments: args,
    messageID: createId("msg"),
  }

  if (session.agent) {
    body.agent = session.agent
  }

  if (session.model.providerId && session.model.modelId) {
    body.model = `${session.model.providerId}/${session.model.modelId}`
    const variant = getThinkingVariantToSend(instanceId, session.model)
    if (variant) body.variant = variant
  }

  await requestData(
    client.session.command({
      sessionID: sessionId,
      ...(await getSessionWorkspacePayload(instanceId, sessionId)),
      ...(body as any),
    }),
    "session.command",
  )
}

async function runShellCommand(instanceId: string, sessionId: string, command: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const client = getRootClient(instanceId)

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const agent = session.agent || "build"

  await requestData(
    client.session.shell({
      sessionID: sessionId,
      ...(await getSessionWorkspacePayload(instanceId, sessionId)),
      agent,
      command,
    }),
    "session.shell",
  )
}

type AbortSessionOutcome = "aborted" | "idle" | "failed"

function getOpencodeErrorTag(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const record = error as Record<string, unknown>
  if (typeof record._tag === "string") return record._tag
  if (typeof record.name === "string") return record.name
  return undefined
}

function isAbortNothingToCancel(error: unknown): boolean {
  const tag = getOpencodeErrorTag(error)
  return tag === "BadRequest" || tag === "InvalidRequestError"
}

function isLocallyActiveSessionStatus(status: SessionStatus | undefined): boolean {
  return status === "working" || status === "compacting"
}

function collectSessionFamilyIds(instanceId: string, sessionId: string): string[] {
  const root = getSessionRoot(instanceId, sessionId)
  const rootId = root?.id ?? sessionId
  const ids = new Set<string>([sessionId, rootId])

  for (const member of getSessionFamily(instanceId, rootId)) {
    ids.add(member.id)
  }

  return [...ids]
}

async function fetchOpenCodeSessionStatuses(
  instanceId: string,
): Promise<Record<string, unknown>> {
  const instance = instances().get(instanceId)
  if (!instance?.client) return {}

  const client = getRootClient(instanceId)
  const result = await client.session.status()
  if (result.data && typeof result.data === "object") {
    return result.data as Record<string, unknown>
  }
  return {}
}

function isServerActiveSessionStatus(rawStatus: unknown): boolean {
  if (!rawStatus || typeof rawStatus !== "object") return false
  return mapSdkSessionStatus(rawStatus as Parameters<typeof mapSdkSessionStatus>[0]) === "working"
}

async function resolveSessionAbortTargets(instanceId: string, sessionId: string): Promise<string[]> {
  const familyIds = collectSessionFamilyIds(instanceId, sessionId)
  const familyIdSet = new Set(familyIds)
  const root = getSessionRoot(instanceId, sessionId)
  const rootId = root?.id ?? sessionId
  const instanceSessions = sessions().get(instanceId)

  const locallyActive = new Set<string>()
  for (const id of familyIds) {
    const status = instanceSessions?.get(id)?.status
    if (isLocallyActiveSessionStatus(status)) {
      locallyActive.add(id)
    }
  }

  let serverActive = new Set<string>()
  try {
    const statusById = await fetchOpenCodeSessionStatuses(instanceId)
    for (const id of familyIds) {
      if (isServerActiveSessionStatus(statusById[id])) {
        serverActive.add(id)
      }
    }
  } catch (error) {
    log.warn("resolveSessionAbortTargets: session.status unavailable, using local state only", {
      instanceId,
      sessionId,
      error,
    })
  }

  const targets = new Set<string>()
  for (const id of locallyActive) targets.add(id)
  for (const id of serverActive) targets.add(id)

  const currentStatus = instanceSessions?.get(sessionId)?.status
  if (isLocallyActiveSessionStatus(currentStatus)) {
    targets.add(sessionId)
    targets.add(rootId)
  }

  if (targets.size === 0) {
    targets.add(sessionId)
    targets.add(rootId)
  }

  const ordered: string[] = []
  const pushTarget = (id: string) => {
    if (!familyIdSet.has(id)) return
    if (!ordered.includes(id)) ordered.push(id)
  }

  pushTarget(sessionId)
  pushTarget(rootId)
  for (const id of targets) {
    if (id !== sessionId && id !== rootId) pushTarget(id)
  }

  return ordered
}

async function refreshSessionFamilyStatus(instanceId: string, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return

  try {
    const statusById = await fetchOpenCodeSessionStatuses(instanceId)
    for (const id of sessionIds) {
      const rawStatus = statusById[id]
      if (rawStatus && typeof rawStatus === "object") {
        setSessionStatus(instanceId, id, mapSdkSessionStatus(rawStatus as Parameters<typeof mapSdkSessionStatus>[0]))
      }
    }
  } catch (error) {
    log.warn("refreshSessionFamilyStatus failed", { instanceId, sessionIds, error })
  }
}

async function abortSessionOnce(instanceId: string, sessionId: string): Promise<AbortSessionOutcome> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const client = getRootClient(instanceId)

  log.info("session.abort", { instanceId, sessionId })
  const result = await client.session.abort({
    sessionID: sessionId,
    ...(await getSessionWorkspacePayload(instanceId, sessionId)),
  })

  if ((result as { error?: unknown } | undefined)?.error) {
    const error = (result as { error: unknown }).error
    if (isAbortNothingToCancel(error)) {
      log.info("abortSessionOnce: nothing to abort, session already idle", { instanceId, sessionId })
      return "idle"
    }

    await requestData(Promise.resolve(result), "session.abort")
    return "failed"
  }

  await requestData(Promise.resolve(result), "session.abort")
  log.info("abortSessionOnce complete", { instanceId, sessionId })
  return "aborted"
}

async function abortSession(instanceId: string, sessionId: string): Promise<void> {
  log.info("abortSession", { instanceId, sessionId })

  const targets = await resolveSessionAbortTargets(instanceId, sessionId)
  log.info("abortSession targets", { instanceId, sessionId, targets })

  let anyAborted = false
  let firstFailure: unknown = null

  for (const targetId of targets) {
    try {
      const outcome = await abortSessionOnce(instanceId, targetId)
      if (outcome === "aborted") anyAborted = true
    } catch (error) {
      firstFailure ??= error
      log.error("Failed to abort session target", { instanceId, sessionId, targetId, error })
    }
  }

  await refreshSessionFamilyStatus(instanceId, targets)

  if (firstFailure) {
    throw firstFailure
  }

  if (!anyAborted) {
    log.info("abortSession: all targets already idle", { instanceId, sessionId, targets })
  }
}

/** Stop the current session and any busy members of its NomadWorks/subagent family. */
async function pauseSession(instanceId: string, sessionId: string): Promise<void> {
  await abortSession(instanceId, sessionId)
}

async function updateSessionAgent(instanceId: string, sessionId: string, agent: string): Promise<void> {
  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const nextModel = await getDefaultModel(instanceId, agent)
  const shouldApplyModel = isModelValid(instanceId, nextModel)

  withSession(instanceId, sessionId, (current) => {
    current.agent = agent
    if (shouldApplyModel) {
      current.model = nextModel
    }
  })

  if (agent && shouldApplyModel) {
    await setAgentModelPreference(instanceId, agent, nextModel)
  }

  if (shouldApplyModel) {
    updateSessionInfo(instanceId, sessionId)
  }
}

async function updateSessionModel(
  instanceId: string,
  sessionId: string,
  model: { providerId: string; modelId: string },
): Promise<void> {
  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  if (!isModelValid(instanceId, model)) {
    log.warn("Invalid model selection", model)
    return
  }

  withSession(instanceId, sessionId, (current) => {
    current.model = model
  })

  if (session.agent) {
    await setAgentModelPreference(instanceId, session.agent, model)
  }
  addRecentModelPreference(model)

  updateSessionInfo(instanceId, sessionId)
}

async function renameSession(instanceId: string, sessionId: string, nextTitle: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const client = getRootClient(instanceId)

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const trimmedTitle = nextTitle.trim()
  if (!trimmedTitle) {
    throw new Error("Session title is required")
  }

  await requestData(
    client.session.update({
      sessionID: sessionId,
      ...(await getSessionWorkspacePayload(instanceId, sessionId)),
      title: trimmedTitle,
    }),
    "session.update",
  )

  withSession(instanceId, sessionId, (current) => {
    current.title = trimmedTitle
    const time = { ...(current.time ?? {}) }
    time.updated = Date.now()
    current.time = time
  })
}

async function deleteMessagePart(instanceId: string, sessionId: string, messageId: string, partId: string): Promise<void> {
  if (!instanceId || !sessionId || !messageId || !partId) return
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const client = getRootClient(instanceId)

  await requestData(
    client.part.delete({
      sessionID: sessionId,
      ...(await getSessionWorkspacePayload(instanceId, sessionId)),
      messageID: messageId,
      partID: partId,
    }),
    "part.delete",
  )

  // Optimistic removal; SSE will also broadcast a part-removed event.
  removeMessagePartV2(instanceId, messageId, partId)
  updateSessionInfo(instanceId, sessionId)
}

async function deleteMessage(instanceId: string, sessionId: string, messageId: string): Promise<void> {
  if (!instanceId || !sessionId || !messageId) return
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const client = getRootClient(instanceId)

  const result = await client.session.deleteMessage({
    sessionID: sessionId,
    messageID: messageId,
    ...(await getSessionWorkspacePayload(instanceId, sessionId)),
  })

  // Unlike abortSession's 400 (nothing to cancel, desired end state already
  // holds), a 409 here is SessionBusyError: the message is still actively
  // being streamed into. Deletion did NOT happen, so this must surface as a
  // real failure — not be swallowed — or the UI would show the message gone
  // while the server keeps writing to it.
  const errorTag = getOpencodeErrorTag((result as { error?: unknown } | undefined)?.error)
  if (errorTag === "SessionBusyError") {
    log.info("deleteMessage: session busy, message still streaming", { instanceId, sessionId, messageId })
    throw new OpencodeApiError("Can't delete this message — it's still being generated. Stop the session first, then try again.")
  }

  await requestData(Promise.resolve(result), "session.message.delete")

  // Optimistic removal; SSE will also broadcast a message-removed event.
  removeMessageV2(instanceId, messageId)
  updateSessionInfo(instanceId, sessionId)
}

export {
  abortSession,
  deleteMessage,
  deleteMessagePart,
  executeCustomCommand,
  pauseSession,
  renameSession,
  runShellCommand,
  sendMessage,
  updateSessionAgent,
  updateSessionModel,
}
