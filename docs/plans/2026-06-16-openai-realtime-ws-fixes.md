# OpenAI Realtime WebSocket Voice — Reliability Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use godmode:task-runner to implement this plan task-by-task.

**Goal:** Fix critical reliability issues in the OpenAI Realtime WebSocket voice system to prevent disconnections, stale sessions, and duplicate events.

**Architecture:** Four targeted fixes to the server-side WebSocket client (`openai-realtime.ts`) and voice session management (`tokidapp.ts`). Each fix is isolated and can be committed independently.

**Tech Stack:** TypeScript, `ws` WebSocket package, OpenAI Realtime API

---

## Task 1: Update OPENAI_REALTIME_MODEL in .env

**Priority:** High

**Problem:** The `.env` file uses `gpt-realtime-mini` but the code defaults to `gpt-realtime-2` (GA). The `gpt-realtime-mini` model may not support all features (e.g., reasoning parameters).

**Files:**
- Modify: `/Users/alexshapiro/contracts/.env` (line 93)
- Modify: `/Users/alexshapiro/contracts/.env.local` (line 82)
- Modify: `/Users/alexshapiro/contracts/.env.production` (line 7)
- Modify: `/Users/alexshapiro/contracts/.env.prod` (line 49)
- Modify: `/Users/alexshapiro/contracts/.env.vercel` (line 7)

**Step 1: Update .env files**

Change `OPENAI_REALTIME_MODEL` from `gpt-realtime-mini` to `gpt-realtime-2`:

```bash
# .env (line 93)
OPENAI_REALTIME_MODEL=gpt-realtime-2

# .env.local (line 82)
OPENAI_REALTIME_MODEL=gpt-realtime-2

# .env.production (line 7)
OPENAI_REALTIME_MODEL=gpt-realtime-2

# .env.prod (line 49)
OPENAI_REALTIME_MODEL=gpt-realtime-2

# .env.vercel (line 7)
OPENAI_REALTIME_MODEL=gpt-realtime-2
```

**Step 2: Verify code default matches**

Confirm line 43 in `openai-realtime.ts` already defaults to `gpt-realtime-2`:
```typescript
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2"
```

**Step 3: Commit**

```bash
git add .env .env.local .env.production .env.prod .env.vercel
git commit -m "fix(config): upgrade OPENAI_REALTIME_MODEL to gpt-realtime-2

- Updated from gpt-realtime-mini to gpt-realtime-2 (GA) across all env files
- Ensures reasoning parameter support and latest Realtime API features
- Aligns env config with code default in openai-realtime.ts"
```

---

## Task 2: Add 15s Ping Interval to Keep WebSocket Alive

**Priority:** High

**Problem:** OpenAI's Realtime WebSocket may silently drop idle connections. A periodic ping keeps the connection alive through proxies and load balancers.

**Files:**
- Modify: `/Users/alexshapiro/contracts/CodeNomad/packages/server/src/plugins/tokidapp/concierge/openai-realtime.ts` (lines 770-809)

**Step 1: Add ping interval after WebSocket open event**

After the `ws.addEventListener("open", ...)` block sends the session config, add a 15-second ping interval:

```typescript
ws.addEventListener("open", () => {
  console.log("[openai-realtime] OpenAI WS connected for session:", sessionId)
  session.connected = true
  flushPendingForSession(session)

  // ... existing session.update config code ...

  ws.send(JSON.stringify(config))

  // ── Keep-alive ping (15s interval) ─────────────────────────
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping()
    } else {
      clearInterval(pingInterval)
    }
  }, 15_000)

  // Store reference for cleanup on close
  ;(session as any)._pingInterval = pingInterval
})
```

**Step 2: Clear ping interval on close/error**

Update the close and error handlers to clear the interval:

```typescript
ws.addEventListener("error", (err: any) => {
  console.log("[openai-realtime] OpenAI WS error for session:", sessionId, "error:", err?.message || String(err))
  onError("OpenAI Realtime connection error")
  session.connected = false
  if ((session as any)._pingInterval) {
    clearInterval((session as any)._pingInterval)
  }
})

ws.addEventListener("close", (event: any) => {
  console.log("[openai-realtime] OpenAI WS closed for session:", sessionId, "code:", event?.code, "reason:", event?.reason)
  session.connected = false
  if ((session as any)._pingInterval) {
    clearInterval((session as any)._pingInterval)
  }
  sessions.delete(sessionId)
})
```

**Step 3: Test manually**

1. Start the dev server: `bun run dev`
2. Open CodeNomad and start a voice session
3. Monitor logs for `[openai-realtime] OpenAI WS connected for session:` 
4. Wait 60+ seconds — connection should remain stable
5. Verify no `close` events in logs

**Step 4: Commit**

```bash
git add packages/server/src/plugins/tokidapp/concierge/openai-realtime.ts
git commit -m "fix(realtime): add 15s ping interval to keep OpenAI WS alive

- Prevents silent connection drops through proxies/load balancers
- Ping interval cleared on close/error to prevent leaked timers
- Ensures voice sessions remain stable during idle periods"
```

---

## Task 3: Add Auto-Reconnect with Exponential Backoff

**Priority:** Medium

**Problem:** When the WebSocket closes unexpectedly (network blip, server restart), the voice session dies permanently. Auto-reconnect restores the session transparently.

**Files:**
- Modify: `/Users/alexshapiro/contracts/CodeNomad/packages/server/src/plugins/tokidapp/concierge/openai-realtime.ts` (lines 682-948)

**Step 1: Add reconnect configuration constants**

After the VAD configuration constants (around line 78), add:

```typescript
/** ── Auto-reconnect configuration ── */
const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_BASE_DELAY_MS = 1_000  // 1s base, doubles each attempt
const RECONNECT_MAX_DELAY_MS = 30_000  // 30s cap
```

**Step 2: Add reconnect logic to createRealtimeSession**

Modify the `createRealtimeSession` function to accept reconnect state and implement backoff:

```typescript
export function createRealtimeSession(
  sessionId: string,
  onAudioDelta: (base64: string) => void,
  onTextDelta: (text: string) => void,
  onError: (error: string) => void,
  onReady?: () => void,
  onUserTranscript?: (text: string) => void,
  onResponseDone?: () => void,
  outputVoice: RealtimeVoiceId = normalizeRealtimeVoice(undefined),
  userId?: string,
  enrichedInstructions?: string,
  // ── Reconnect state (internal) ──
  _reconnectState?: {
    attempt: number
    lastAttemptMs: number
  },
): RealtimeSession {
```

**Step 3: Update close handler with reconnect logic**

Replace the existing close handler (lines 944-948):

```typescript
ws.addEventListener("close", (event: any) => {
  console.log("[openai-realtime] OpenAI WS closed for session:", sessionId, "code:", event?.code, "reason:", event?.reason)
  session.connected = false
  if ((session as any)._pingInterval) {
    clearInterval((session as any)._pingInterval)
  }
  sessions.delete(sessionId)

  // ── Auto-reconnect with exponential backoff ──
  const attempt = (_reconnectState?.attempt ?? 0) + 1
  if (attempt <= MAX_RECONNECT_ATTEMPTS && event?.code !== 1000) {
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
      RECONNECT_MAX_DELAY_MS,
    )
    console.log(`[openai-realtime] Reconnecting session ${sessionId} in ${delay}ms (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})`)
    setTimeout(() => {
      if (!sessions.has(sessionId)) {
        createRealtimeSession(
          sessionId,
          onAudioDelta,
          onTextDelta,
          onError,
          onReady,
          onUserTranscript,
          onResponseDone,
          outputVoice,
          userId,
          enrichedInstructions,
          { attempt, lastAttemptMs: Date.now() },
        )
      }
    }, delay)
  } else if (attempt > MAX_RECONNECT_ATTEMPTS) {
    console.log(`[openai-realtime] Max reconnect attempts reached for session ${sessionId}`)
    onError("Voice session lost — please reconnect")
  }
})
```

**Step 4: Test manually**

1. Start a voice session
2. Kill the network connection briefly (toggle WiFi or airplane mode)
3. Restore network — session should reconnect automatically
4. Check logs for `[openai-realtime] Reconnecting session...`

**Step 5: Commit**

```bash
git add packages/server/src/plugins/tokidapp/concierge/openai-realtime.ts
git commit -m "fix(realtime): add auto-reconnect with exponential backoff

- Max 5 reconnect attempts with 1s-30s backoff
- Only reconnects on abnormal close (not code 1000)
- Prevents duplicate sessions via sessions.has() check
- Notifies client on permanent failure"
```

---

## Task 4: Deduplicate voice_ready Event

**Priority:** Low

**Problem:** `voice_ready` fires on both `session.created` AND `session.updated`, causing duplicate events to the client. This can trigger redundant UI state changes.

**Files:**
- Modify: `/Users/alexshapiro/contracts/CodeNomad/packages/server/src/plugins/tokidapp/concierge/openai-realtime.ts` (lines 817-822)
- Modify: `/Users/alexshapiro/contracts/CodeNomad/packages/server/src/server/routes/tokidapp.ts` (lines 150-157)

**Step 1: Add session state tracking**

In the `RealtimeSession` interface (around line 82), add a flag:

```typescript
interface RealtimeSession {
  ws: WebSocket
  sessionId: string
  connected: boolean
  outputVoice: RealtimeVoiceId
  toolCallbacks: Map<string, (args: string) => Promise<string>>
  audioBytes: number
  pendingChunks: string[]
  onReady?: () => void
  responseInProgress: boolean
  pendingResponseQueue: Array<() => void>
  /** Track if session.created has fired (for voice_ready dedup) */
  sessionCreatedFired: boolean
}
```

**Step 2: Initialize the flag**

In `createRealtimeSession`, initialize the new field:

```typescript
const session: RealtimeSession = {
  ws,
  sessionId,
  connected: false,
  outputVoice: voice,
  toolCallbacks: new Map(),
  audioBytes: 0,
  pendingChunks: [],
  onReady,
  responseInProgress: false,
  pendingResponseQueue: [],
  sessionCreatedFired: false,
}
```

Also initialize in the stub session (around line 704):

```typescript
return {
  ws: stubWs,
  sessionId,
  connected: false,
  outputVoice: normalizeRealtimeVoice(outputVoice),
  toolCallbacks: new Map(),
  audioBytes: 0,
  pendingChunks: [],
  onReady,
  responseInProgress: false,
  pendingResponseQueue: [],
  sessionCreatedFired: false,
}
```

**Step 3: Update the session.created/session.updated handler**

Replace lines 817-822:

```typescript
case "session.created":
  console.log("[openai-realtime] OpenAI session created event for session:", sessionId)
  session.sessionCreatedFired = true
  session.onReady?.()
  break

case "session.updated":
  console.log("[openai-realtime] OpenAI session updated event for session:", sessionId)
  // Only fire onReady on session.updated if it's a voice change re-init
  // (session.created already fired the initial ready)
  if (session.sessionCreatedFired) {
    session.onReady?.()
  }
  break
```

**Step 4: Update the response.done handler**

The `response.done` handler (line 862) also calls `session.onReady?.()` — this is correct (signals voice ready after response completes) and should remain unchanged.

**Step 5: Test manually**

1. Start a voice session
2. Check logs — should see only ONE `[voice-ws] notifyReady — sending voice_ready to client` on initial connect
3. Change voice (if UI supports it) — should see `session.updated` but not duplicate `voice_ready` on initial connect

**Step 6: Commit**

```bash
git add packages/server/src/plugins/tokidapp/concierge/openai-realtime.ts
git commit -m "fix(realtime): deduplicate voice_ready event

- Only fire voice_ready on session.created, not session.updated
- Prevents duplicate UI state changes on initial connect
- session.updated still fires onReady for voice change re-init"
```

---

## Execution Summary

| Task | Priority | Files Modified | Risk |
|------|----------|----------------|------|
| 1. Update OPENAI_REALTIME_MODEL | High | 5 `.env` files | Low — config only |
| 2. Add 15s ping interval | High | `openai-realtime.ts` | Low — additive |
| 3. Add auto-reconnect | Medium | `openai-realtime.ts` | Medium — new logic |
| 4. Deduplicate voice_ready | Low | `openai-realtime.ts` | Low — state flag |

## Verification Checklist

After all tasks are complete:

- [ ] Voice session connects successfully with `gpt-realtime-2`
- [ ] WebSocket stays alive for 5+ minutes without manual intervention
- [ ] Network interruption triggers automatic reconnection
- [ ] Only one `voice_ready` event fires on initial connection
- [ ] Voice changes still work (session.updated path)
- [ ] All existing voice functionality preserved (audio, transcription, tools)
