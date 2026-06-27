import { Show, createSignal, type Component } from "solid-js"
import { RefreshCw, FileQuestion, AlertTriangle, Clock, Link2 } from "lucide-solid"

interface WikiLintResult {
  orphanPages: string[]
  brokenLinks: Array<{ from: string; link: string }>
  stalePages: Array<{ page: string; lastModified: string }>
  indexGaps: string[]
  summary: string
  error?: string
}

interface WikiLintTabProps {
  t: (key: string, vars?: Record<string, any>) => string
  instanceId: string
}

const WikiLintTab: Component<WikiLintTabProps> = (props) => {
  const [result, setResult] = createSignal<WikiLintResult | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const runLint = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/wiki-lint`)
      if (!res.ok) {
        throw new Error(`Request failed with ${res.status}`)
      }
      const data = (await res.json()) as WikiLintResult
      setResult(data)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const res = () => result()

  return (
    <div class="status-tab-container">
      <div class="flex items-center justify-between px-3 py-2 border-b border-base">
        <span class="text-sm font-medium text-primary">Wiki Health</span>
        <button
          type="button"
          class="button-tertiary inline-flex items-center gap-1 px-2 py-1 text-xs"
          onClick={() => void runLint()}
          disabled={loading()}
          aria-label="Run WikiLint scan"
          title="Run WikiLint scan"
        >
          <RefreshCw class={`h-3.5 w-3.5 ${loading() ? "animate-spin" : ""}`} />
          {loading() ? "Scanning..." : "Scan"}
        </button>
      </div>

      <Show when={!res() && !loading() && !error()}>
        <div class="right-panel-empty right-panel-empty--left">
          <span class="text-xs">Click "Scan" to check wiki health</span>
        </div>
      </Show>

      <Show when={loading()}>
        <div class="right-panel-empty right-panel-empty--left">
          <span class="text-xs">Scanning wiki...</span>
        </div>
      </Show>

      <Show when={error()}>
        <div class="px-3 py-2">
          <div class="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
            <span class="text-xs text-red-400">{error()}</span>
          </div>
        </div>
      </Show>

      <Show when={res()}>
        <div class="flex flex-col gap-3 p-3">
          {/* Summary */}
          <div class="rounded-md border border-base bg-surface-secondary px-3 py-2">
            <span class="text-sm text-primary">{res()!.summary}</span>
          </div>

          {/* Orphan Pages */}
          <Show when={res()!.orphanPages.length > 0}>
            <div class="rounded-md border border-base">
              <div class="flex items-center gap-2 border-b border-base px-3 py-2">
                <FileQuestion class="h-4 w-4 text-warning" />
                <span class="text-sm font-medium text-primary">Orphan Pages ({res()!.orphanPages.length})</span>
              </div>
              <div class="max-h-40 overflow-y-auto">
                {res()!.orphanPages.map((page: string) => (
                  <div class="border-b border-base/50 px-3 py-1.5 text-xs text-secondary last:border-0">
                    {page}
                  </div>
                ))}
              </div>
            </div>
          </Show>

          {/* Broken Links */}
          <Show when={res()!.brokenLinks.length > 0}>
            <div class="rounded-md border border-base">
              <div class="flex items-center gap-2 border-b border-base px-3 py-2">
                <Link2 class="h-4 w-4 text-error" />
                <span class="text-sm font-medium text-primary">Broken Links ({res()!.brokenLinks.length})</span>
              </div>
              <div class="max-h-40 overflow-y-auto">
                {res()!.brokenLinks.map((bl: { from: string; link: string }) => (
                  <div class="border-b border-base/50 px-3 py-1.5 text-xs last:border-0">
                    <span class="text-secondary">{bl.from}</span>
                    <span class="text-tertiary mx-1">→</span>
                    <span class="text-error">{bl.link}</span>
                  </div>
                ))}
              </div>
            </div>
          </Show>

          {/* Stale Pages */}
          <Show when={res()!.stalePages.length > 0}>
            <div class="rounded-md border border-base">
              <div class="flex items-center gap-2 border-b border-base px-3 py-2">
                <Clock class="h-4 w-4 text-warning" />
                <span class="text-sm font-medium text-primary">Stale Pages ({res()!.stalePages.length})</span>
              </div>
              <div class="max-h-40 overflow-y-auto">
                {res()!.stalePages.map((sp: { page: string; lastModified: string }) => (
                  <div class="border-b border-base/50 px-3 py-1.5 text-xs last:border-0">
                    <span class="text-secondary">{sp.page}</span>
                    <span class="text-tertiary ml-2">({sp.lastModified})</span>
                  </div>
                ))}
              </div>
            </div>
          </Show>

          {/* Index Gaps */}
          <Show when={res()!.indexGaps.length > 0}>
            <div class="rounded-md border border-base">
              <div class="flex items-center gap-2 border-b border-base px-3 py-2">
                <AlertTriangle class="h-4 w-4 text-warning" />
                <span class="text-sm font-medium text-primary">Index Gaps ({res()!.indexGaps.length})</span>
              </div>
              <div class="max-h-40 overflow-y-auto">
                {res()!.indexGaps.map((gap: string) => (
                  <div class="border-b border-base/50 px-3 py-1.5 text-xs text-secondary last:border-0">
                    {gap}
                  </div>
                ))}
              </div>
            </div>
          </Show>

          {/* All Clear */}
          <Show when={res()!.orphanPages.length === 0 && res()!.brokenLinks.length === 0 && res()!.stalePages.length === 0 && res()!.indexGaps.length === 0}>
            <div class="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2">
              <span class="text-xs text-green-400">No issues found — wiki is healthy.</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default WikiLintTab
