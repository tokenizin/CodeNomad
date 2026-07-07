/**
 * Knowledge Cache — Warm cache layer for the architecture digest.
 *
 * Provides a shared, auto-refreshing knowledge snapshot consumed by both
 * Path A (Speech REST) and Path B (Realtime WS), ensuring the concierge
 * always has warm knowledge on start without waiting for API calls.
 *
 * Architecture:
 *   ┌─────────────────────────────────────────┐
 *   │           knowledge-cache.ts            │
 *   │  ┌──────────────────────────────────┐  │
 *   │  │  getArchitectureDigest() (src)   │  │
 *   │  │     ┌─────────────────────┐     │  │
 *   │  │     │  Warm Cache Layer   │     │  │
 *   │  │     │  - 5min TTL         │     │  │
 *   │  │     │  - Background refr. │     │  │
 *   │  │     │  - Staleness track  │     │  │
 *   │  │     └─────────────────────┘     │  │
 *   │  └──────────────────────────────────┘  │
 *   │           ↕ shared singleton           │
 *   ├── Path A: speech.ts (via getDigest())  │
 *   ├── Path B: tokidapp.ts (via getDigest())│
 *   └── openai-realtime.ts (enrichedInst.)   │
 *   └─────────────────────────────────────────┘
 *
 * @module knowledge-cache
 */

import { getArchitectureDigest } from "./codebase-tools"

// ── Cache Configuration ────────────────────────────────────────

/** Background refresh interval in milliseconds. Default: 5 minutes. */
const REFRESH_INTERVAL_MS = parseInt(
  process.env.KNOWLEDGE_CACHE_REFRESH_MS || "300000",
  10,
)

/** Maximum age before digest is considered stale (for staleness header). */
const STALE_AFTER_MS = REFRESH_INTERVAL_MS * 2

// ── Cache State ────────────────────────────────────────────────

interface CacheEntry {
  digest: string
  fetchedAt: number
  staleAt: number
  isFresh: boolean
}

let cache: CacheEntry | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null
let refreshInProgress = false

// ── Internal Refresh Logic ─────────────────────────────────────

async function refreshCache(): Promise<void> {
  if (refreshInProgress) return
  refreshInProgress = true
  try {
    const digest = await getArchitectureDigest()
    const now = Date.now()
    cache = {
      digest,
      fetchedAt: now,
      staleAt: now + STALE_AFTER_MS,
      isFresh: true,
    }
    console.log(
      `[knowledge-cache] refreshed — ${digest.length} chars at ${new Date(now).toISOString()}`,
    )
  } catch (err) {
    console.error("[knowledge-cache] refresh failed:", (err as Error).message)
    // Keep stale cache entry — mark as not fresh
    if (cache) cache.isFresh = false
  } finally {
    refreshInProgress = false
  }
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Get the warm-cached architecture digest.
 *
 * First call triggers an immediate fetch. Subsequent calls return the
 * cached value while the background timer keeps it fresh.
 *
 * The returned object includes:
 * - `digest`: The knowledge digest string
 * - `fetchedAt`: ISO timestamp of last successful fetch
 * - `isFresh`: Whether the cache is within the fresh window
 * - `age`: Age in seconds
 */
export async function getDigest(): Promise<{
  digest: string
  fetchedAt: string
  isFresh: boolean
  age: number
}> {
  // Start the background refresh timer on first call
  if (!refreshTimer) {
    refreshTimer = setInterval(refreshCache, REFRESH_INTERVAL_MS)
    // Don't let the timer keep the process alive
    if (refreshTimer && typeof refreshTimer === "object" && "unref" in refreshTimer) {
      ;(refreshTimer as NodeJS.Timeout).unref()
    }
  }

  // If no cache yet, do an immediate fetch
  if (!cache) {
    await refreshCache()
  }

  // Fire background refresh if stale but return cached version immediately
  if (cache && Date.now() > cache.staleAt) {
    refreshCache() // fire-and-forget
  }

  if (!cache) {
    return {
      digest: "",
      fetchedAt: new Date(0).toISOString(),
      isFresh: false,
      age: 0,
    }
  }

  return {
    digest: cache.digest,
    fetchedAt: new Date(cache.fetchedAt).toISOString(),
    isFresh: cache.isFresh,
    age: Math.round((Date.now() - cache.fetchedAt) / 1000),
  }
}

/**
 * Force an immediate refresh of the knowledge cache.
 * Used after significant project state changes (SCR approval, task completion).
 */
export async function forceRefresh(): Promise<void> {
  console.log("[knowledge-cache] force refresh triggered")
  await refreshCache()
}

/**
 * Get the current age of the cache in seconds.
 * Returns -1 if the cache has never been populated.
 */
export function getCacheAge(): number {
  if (!cache) return -1
  return Math.round((Date.now() - cache.fetchedAt) / 1000)
}

/**
 * Check whether the cache is initialized (has been fetched at least once).
 */
export function isCacheWarm(): boolean {
  return cache !== null
}

/**
 * Stop the background refresh timer. Call during server shutdown.
 */
export function stopBackgroundRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

/**
 * Get the background refresh interval in milliseconds (for diagnostics).
 */
export function getRefreshInterval(): number {
  return REFRESH_INTERVAL_MS
}
