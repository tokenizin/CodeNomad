import { Show, createResource, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { GitBranch, RefreshCw, AlertCircle } from "lucide-solid"

/**
 * Git Graph tab — embeds the server-side Git Graph bridge (vendored VS Code
 * Git Graph extension) for the workspace's repository, scoped to the active
 * worktree. The heavy lifting (extension protocol, SSE stream) lives in
 * packages/server/src/gitgraph/bridge.ts; this tab probes availability, frames
 * the served page, and mirrors the CodeNomad / Tokenizin app theme
 * (`data-gg-theme`) into the iframe so the brand palettes stay in sync.
 */

interface GitGraphTabProps {
  t: (key: string, vars?: Record<string, any>) => string
  instanceId: string
  worktreeSlug: string | null
}

interface StatusResponse {
  available: boolean
  repoPath?: string
  reason?: string
}

/** Resolve the app theme the same way lib/theme.tsx does: explicit
 * `data-theme` on <html> wins, otherwise the OS preference. */
function resolveAppTheme(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme")
  if (attr === "light" || attr === "dark") return attr
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

const GitGraphTab: Component<GitGraphTabProps> = (props) => {
  const [nonce, setNonce] = createSignal(0)
  let frameEl: HTMLIFrameElement | undefined

  const [status] = createResource(
    () => ({ id: props.instanceId, worktree: props.worktreeSlug ?? "", nonce: nonce() }),
    async (key): Promise<StatusResponse> => {
      try {
        const qs = key.worktree ? `?worktree=${encodeURIComponent(key.worktree)}` : ""
        const res = await fetch(`/gitgraph/${encodeURIComponent(key.id)}/__status${qs}`, {
          credentials: "same-origin",
        })
        const body = (await res.json().catch(() => null)) as StatusResponse | null
        if (body && typeof body.available === "boolean") return body
        return { available: false, reason: `HTTP ${res.status}` }
      } catch (err) {
        return { available: false, reason: String(err) }
      }
    },
  )

  const frameSrc = () => {
    const params = new URLSearchParams()
    if (props.worktreeSlug) params.set("worktree", props.worktreeSlug)
    params.set("theme", resolveAppTheme())
    return `/gitgraph/${encodeURIComponent(props.instanceId)}/?${params.toString()}`
  }

  /** Mirror the current app theme into the embedded webview (same-origin). */
  const syncTheme = () => {
    const doc = frameEl?.contentDocument
    if (!doc) return
    doc.documentElement.setAttribute("data-gg-theme", resolveAppTheme())
  }

  onMount(() => {
    const observer = new MutationObserver(() => syncTheme())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] })

    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const onMedia = () => syncTheme()
    const addMedia = media.addEventListener ?? media.addListener
    const delMedia = media.removeEventListener ?? media.removeListener
    addMedia.call(media, "change", onMedia)

    onCleanup(() => {
      observer.disconnect()
      delMedia.call(media, "change", onMedia)
    })
  })

  const unavailable = () => !status.loading && Boolean(status()) && status()!.available === false

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <Show when={unavailable()}>
        <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertCircle class="h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <div class="space-y-1">
            <p class="text-sm font-medium text-foreground">Git Graph</p>
            <p class="text-xs text-muted-foreground">
              {status()!.reason || props.t("instanceShell.rightPanel.gitGraph.unavailable")}
            </p>
          </div>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-muted"
            onClick={() => setNonce((n) => n + 1)}
          >
            <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
            {props.t("instanceShell.rightPanel.gitGraph.retry")}
          </button>
        </div>
      </Show>

      <Show when={!unavailable()}>
        <Show
          when={!status.loading}
          fallback={
            <div class="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <GitBranch class="h-6 w-6 animate-pulse" aria-hidden="true" />
              <span class="text-xs">{props.t("instanceShell.rightPanel.gitGraph.loading")}</span>
            </div>
          }
        >
          <iframe
            ref={(el) => ((frameEl = el), void syncTheme())}
            onLoad={syncTheme}
            class="gitgraph-frame"
            title="Git Graph"
            src={frameSrc()}
            loading="lazy"
          />
        </Show>
      </Show>
    </div>
  )
}

export default GitGraphTab
