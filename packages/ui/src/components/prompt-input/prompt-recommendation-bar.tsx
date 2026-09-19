import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import {
  Eye, FileText, Rocket, Shield, List, CheckCircle, Search,
  GitBranch, TrendingUp, Sparkles, X, ArrowRight,
} from "lucide-solid"
import {
  getRecommendations,
  isRecommendationVisible,
  dismissRecommendation,
  dismissAllRecommendations,
  type PromptRecommendation,
} from "../../stores/prompt-recommendations"
import { useI18n } from "../../lib/i18n"

const ICON_MAP: Record<string, any> = {
  Eye, FileText, Rocket, Shield, List, CheckCircle, Search,
  GitBranch, TrendingUp, Sparkles, ArrowRight,
}

interface PromptRecommendationBarProps {
  onSelect: (prompt: string) => void
}

export default function PromptRecommendationBar(props: PromptRecommendationBarProps) {
  const { t } = useI18n()
  const [isVisible, setIsVisible] = createSignal(false)
  const [recommendations, setRecommendations] = createSignal<PromptRecommendation[]>([])
  const [isAnimating, setIsAnimating] = createSignal(false)
  let animationTimeout: ReturnType<typeof setTimeout> | undefined

  // Poll for recommendation updates (SolidJS signals don't trigger re-renders
  // across module boundaries without an effect owner, so we use a lightweight
  // interval to sync the local signal with the store)
  let pollInterval: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    pollInterval = setInterval(() => {
      const visible = isRecommendationVisible()
      const recs = getRecommendations()

      if (visible !== isVisible()) {
        setIsVisible(visible)
      }
      if (recs.length !== recommendations().length ||
          recs.some((r, i) => r.id !== recommendations()[i]?.id)) {
        setRecommendations(recs)
        if (recs.length > 0) {
          setIsAnimating(true)
          if (animationTimeout) clearTimeout(animationTimeout)
          animationTimeout = setTimeout(() => setIsAnimating(false), 300)
        }
      }
    }, 200)
  })

  onCleanup(() => {
    if (pollInterval) clearInterval(pollInterval)
    if (animationTimeout) clearTimeout(animationTimeout)
  })

  function handleSelect(rec: PromptRecommendation) {
    props.onSelect(rec.prompt)
    dismissAllRecommendations()
  }

  function handleDismiss(e: MouseEvent, id: string) {
    e.stopPropagation()
    dismissRecommendation(id)
    // If no more recommendations, hide the bar
    if (getRecommendations().length === 0) {
      setIsVisible(false)
    }
  }

  function handleDismissAll() {
    dismissAllRecommendations()
    setIsVisible(false)
  }

  return (
    <Show when={isVisible() && recommendations().length > 0}>
      <div
        class={`prompt-recommendation-bar ${isAnimating() ? "is-entering" : ""}`}
        role="region"
        aria-label={t("promptRecommendations.ariaLabel")}
        data-testid="prompt-recommendation-bar"
      >
        <div class="prompt-recommendation-header">
          <span class="prompt-recommendation-title">
            <Sparkles class="h-3 w-3" aria-hidden="true" />
            <span>{t("promptRecommendations.title")}</span>
          </span>
          <button
            type="button"
            class="prompt-recommendation-dismiss-all"
            onClick={handleDismissAll}
            aria-label={t("promptRecommendations.dismissAll")}
            title={t("promptRecommendations.dismissAll")}
          >
            <X class="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
        <div class="prompt-recommendation-chips">
          <For each={recommendations()}>
            {(rec) => {
              const IconComponent = ICON_MAP[rec.icon] || ArrowRight
              return (
                <button
                  type="button"
                  class="prompt-recommendation-chip"
                  onClick={() => handleSelect(rec)}
                  data-testid={`recommendation-chip-${rec.id}`}
                  title={rec.prompt.split("\n")[0]}
                >
                  <span class="prompt-recommendation-chip-icon">
                    <IconComponent class="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <span class="prompt-recommendation-chip-label">{rec.label}</span>
                  <span
                    class="prompt-recommendation-chip-dismiss"
                    onClick={(e) => handleDismiss(e, rec.id)}
                    aria-label={t("promptRecommendations.dismissOne")}
                    title={t("promptRecommendations.dismissOne")}
                  >
                    <X class="h-2.5 w-2.5" aria-hidden="true" />
                  </span>
                </button>
              )
            }}
          </For>
        </div>
      </div>
    </Show>
  )
}
