import { Combobox } from "@kobalte/core/combobox"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { providers, fetchProviders } from "../stores/sessions"
import { ChevronDown, PlugZap, Star, ArrowUpDown, EyeOff, Cpu, Image, Video, Brain, Music, Cloud, Gift, AlertCircle, AlertTriangle, CheckCircle, Info, Lock, Zap, Eye, Mic, Globe } from "lucide-solid"
import type { Model, ModelCapabilities, ModelStatus } from "../types/session"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { uiState, toggleFavoriteModelPreference } from "../stores/preferences"
import { ProviderManagerModal } from "./provider-auth/provider-manager-modal"
const log = getLogger("session")

interface ModelSelectorProps {
  instanceId: string
  sessionId: string
  currentModel: { providerId: string; modelId: string }
  onModelChange: (model: { providerId: string; modelId: string }) => Promise<void>
}

interface FlatModel extends Model {
  providerName: string
  key: string
  searchText: string
}

interface ModelGroup {
  providerId: string
  providerName: string
  models: FlatModel[]
}

interface ProviderHeaderOption {
  type: "header"
  key: string
  providerId: string
  providerName: string
  searchText: string
}

type PickerOption = FlatModel | ProviderHeaderOption

const compareIds = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: "base" })

const isProviderHeaderOption = (option: PickerOption): option is ProviderHeaderOption => "type" in option && option.type === "header"

// Capability icon components
function CapabilityIcons({ capabilities }: { capabilities?: ModelCapabilities }) {
  if (!capabilities) return null
  
  const icons = [
    { condition: capabilities.tools, icon: Cpu, title: "Tools", color: "text-blue-400" },
    { condition: capabilities.image, icon: Image, title: "Vision", color: "text-green-400" },
    { condition: capabilities.video, icon: Video, title: "Video", color: "text-purple-400" },
    { condition: capabilities.reasoning, icon: Brain, title: "Reasoning", color: "text-orange-400" },
    { condition: capabilities.audio, icon: Music, title: "Audio", color: "text-pink-400" },
    { condition: capabilities.cloud, icon: Cloud, title: "Cloud", color: "text-cyan-400" },
  ].filter((i) => i.condition)
  
  if (icons.length === 0) return null
  
  return (
    <div class="flex items-center gap-1 ml-2">
      {icons.map((item, idx) => (
        <div class="relative" title={item.title} {...{ key: idx }}>
          <item.icon class="w-3.5 h-3.5 opacity-70 hover:opacity-100 transition-opacity" style={{ color: item.color }} />
        </div>
      ))}
    </div>
  )
}

// Status badge component
function StatusBadge({ status, errorDetails }: { status?: ModelStatus; errorDetails?: string }) {
  const configs = {
    insufficient_funds: { icon: AlertTriangle, color: "text-yellow-400 bg-yellow-400/10", title: errorDetails || "Insufficient credits or quota exceeded" },
    error: { icon: AlertCircle, color: "text-red-400 bg-red-400/10", title: errorDetails || "Model unavailable" },
    testing: { icon: Cpu, color: "text-blue-400 bg-blue-400/10 animate-pulse", title: "Model is being tested" },
    available: { icon: CheckCircle, color: "text-green-400 bg-green-400/10", title: "Model is available for use" },
    unknown: { icon: Info, color: "text-gray-400 bg-gray-400/10", title: errorDetails || "Model status not yet tested" },
  }
  
  const config = configs[status as keyof typeof configs]
  if (!config) return null
  
  const Icon = config.icon
  return (
    <span 
      class={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${config.color}`}
      title={config.title}
    >
      <Icon class="w-3 h-3" />
    </span>
  )
}

// Check if model is selectable (not in error state)
function isModelSelectable(model: FlatModel): boolean {
  return !model.status || model.status === "unknown" || model.status === "available" || model.status === "testing"
}

// Format context window for display
function formatContextWindow(limit?: { context?: number; input?: number; output?: number }): string | null {
  if (!limit?.context) return null
  const ctx = limit.context
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M`
  if (ctx >= 1_000) return `${(ctx / 1_000).toFixed(0)}K`
  return String(ctx)
}

// ─── Sorting / unavailable-model visibility ───
// Kept at module level so the choice survives closing and reopening the popup,
// and in localStorage so it survives a reload.
type ModelSortMode = "provider" | "context" | "verified"
const SORT_MODES: ModelSortMode[] = ["provider", "context", "verified"]
const SORT_STORAGE_KEY = "codenomad.modelSelector.sortMode"
const SHOW_UNAVAILABLE_STORAGE_KEY = "codenomad.modelSelector.showUnavailable"

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage unavailable (private mode etc.) — keep the in-memory value
  }
}

const storedSort = readStored(SORT_STORAGE_KEY) as ModelSortMode | null
const [sortMode, setSortModeSignal] = createSignal<ModelSortMode>(
  storedSort && SORT_MODES.includes(storedSort) ? storedSort : "provider",
)
const [showUnavailable, setShowUnavailableSignal] = createSignal(readStored(SHOW_UNAVAILABLE_STORAGE_KEY) === "true")

function cycleSortMode(): void {
  const next = SORT_MODES[(SORT_MODES.indexOf(sortMode()) + 1) % SORT_MODES.length]
  setSortModeSignal(next)
  writeStored(SORT_STORAGE_KEY, next)
}

function toggleShowUnavailable(): void {
  const next = !showUnavailable()
  setShowUnavailableSignal(next)
  writeStored(SHOW_UNAVAILABLE_STORAGE_KEY, String(next))
}

// Popup width, adjustable with the drag handle on its right edge
const WIDTH_STORAGE_KEY = "codenomad.modelSelector.width"
const DEFAULT_POPUP_WIDTH = 560
const MIN_POPUP_WIDTH = 300
const storedWidth = Number(readStored(WIDTH_STORAGE_KEY))
const [popupWidth, setPopupWidth] = createSignal(
  Number.isFinite(storedWidth) && storedWidth >= MIN_POPUP_WIDTH ? storedWidth : DEFAULT_POPUP_WIDTH,
)

function savePopupWidth(width: number): void {
  setPopupWidth(width)
  writeStored(WIDTH_STORAGE_KEY, String(Math.round(width)))
}

// Lower rank sorts first: tested-and-working, then being tested, then never
// tested, then out of credits, then errors
function statusRank(status?: ModelStatus): number {
  switch (status) {
    case "available":
      return 0
    case "testing":
      return 1
    case "insufficient_funds":
      return 3
    case "error":
      return 4
    default:
      return 2
  }
}

const contextSize = (model: FlatModel) => model.limit?.context ?? 0

export default function ModelSelector(props: ModelSelectorProps) {
  const { t } = useI18n()
  const instanceProviders = () => providers().get(props.instanceId) || []
  const [isOpen, setIsOpen] = createSignal(false)
  const [manualAll, setManualAll] = createSignal(false)
  const [explicitFavorites, setExplicitFavorites] = createSignal(false)
  const [autoFavoritesEligibleAtOpen, setAutoFavoritesEligibleAtOpen] = createSignal(false)
  const [searchDirty, setSearchDirty] = createSignal(false)
  const [initialQuery, setInitialQuery] = createSignal("")
  const [initialQueryReady, setInitialQueryReady] = createSignal(false)
  const [inputValue, setInputValue] = createSignal("")
  const [providersModalOpen, setProvidersModalOpen] = createSignal(false)
  // Capability toggle filters
  const [capFilterTools, setCapFilterTools] = createSignal(false)
  const [capFilterImage, setCapFilterImage] = createSignal(false)
  const [capFilterVideo, setCapFilterVideo] = createSignal(false)
  const [capFilterReasoning, setCapFilterReasoning] = createSignal(false)
  const [capFilterAudio, setCapFilterAudio] = createSignal(false)
  const [capFilterCloud, setCapFilterCloud] = createSignal(false)
  const [capFilterFree, setCapFilterFree] = createSignal(false)
  let triggerRef!: HTMLButtonElement
  let searchInputRef!: HTMLInputElement
  let listboxRef!: HTMLUListElement
  let popoverRef: HTMLDivElement | undefined
  let suppressNextClose = false
  let wasFavoritesOnlyEnabled = false
  let wasCurrentModelFavorite = false

  createEffect(() => {
    if (instanceProviders().length === 0) {
      fetchProviders(props.instanceId).catch((error) => log.error("Failed to fetch providers", error))
    }
  })

  // Re-fetch providers when model sync completes so capability icons appear
  const handleSyncComplete = () => {
    setTimeout(() => {
      fetchProviders(props.instanceId).catch((error) => log.error("Failed to re-fetch providers after sync", error))
    }, 500)
  }
  window.addEventListener("model-sync-complete", handleSyncComplete)
  onCleanup(() => window.removeEventListener("model-sync-complete", handleSyncComplete))

  const allModels = createMemo<FlatModel[]>(() =>
    instanceProviders().flatMap((p) =>
      p.models.map((m) => ({
        ...m,
        providerName: p.name,
        key: `${m.providerId}/${m.id}`,
        searchText: `${m.name} ${p.name} ${m.providerId} ${m.id} ${m.providerId}/${m.id}`,
      })),
    ),
  )

  const sortedModels = createMemo<FlatModel[]>(() => {
    const byProviderThenName = (left: FlatModel, right: FlatModel) => {
      const providerComparison = compareIds(left.providerId, right.providerId)
      if (providerComparison !== 0) return providerComparison
      const nameComparison = compareIds(left.name, right.name)
      if (nameComparison !== 0) return nameComparison
      return compareIds(left.id, right.id)
    }
    const mode = sortMode()
    return [...allModels()].sort((left, right) => {
      if (mode === "context") {
        const diff = contextSize(right) - contextSize(left)
        if (diff !== 0) return diff
      } else if (mode === "verified") {
        const diff = statusRank(left.status) - statusRank(right.status)
        if (diff !== 0) return diff
        // Within the same status, larger context first
        const ctx = contextSize(right) - contextSize(left)
        if (ctx !== 0) return ctx
      }
      return byProviderThenName(left, right)
    })
  })

  // Greyed-out (not selectable) models, hidden unless the user asks to see them.
  // The current model always stays visible so the selection never vanishes.
  const unavailableCount = createMemo(() => allModels().filter((m) => !isModelSelectable(m)).length)

  const favoriteKeySet = createMemo(() => {
    const result = new Set<string>()
    for (const item of uiState().models.favorites ?? []) {
      if (item.providerId && item.modelId) {
        result.add(`${item.providerId}/${item.modelId}`)
      }
    }
    return result
  })

  const favoriteModels = createMemo<FlatModel[]>(() => {
    const keys = favoriteKeySet()
    if (keys.size === 0) return []
    return sortedModels().filter((m) => keys.has(m.key))
  })

  const hasFavorites = createMemo(() => favoriteModels().length > 0)

  const currentModelValue = createMemo(() =>
    allModels().find((m) => m.providerId === props.currentModel.providerId && m.id === props.currentModel.modelId),
  )

  const currentModelIsFavorite = createMemo(() => {
    const current = props.currentModel
    return favoriteKeySet().has(`${current.providerId}/${current.modelId}`)
  })

  const currentModelKey = createMemo(() => {
    const current = props.currentModel
    return `${current.providerId}/${current.modelId}`
  })

  const searchActive = createMemo(() => {
    if (!searchDirty()) return false
    const next = inputValue().trim()
    return next.length > 0
  })

  const favoritesOnlyEnabled = createMemo(() => {
    if (searchActive()) return false
    if (manualAll()) return false
    if (!hasFavorites()) return false
    return explicitFavorites() || autoFavoritesEligibleAtOpen()
  })

  const visibleOptions = createMemo<FlatModel[]>(() => {
    let models = sortedModels()

    if (!showUnavailable()) {
      const currentKey = currentModelKey()
      models = models.filter((m) => isModelSelectable(m) || m.key === currentKey)
    }

    // Apply capability filters (AND logic — model must have ALL toggled capabilities)
    if (capFilterTools() || capFilterImage() || capFilterVideo() || capFilterReasoning() || capFilterAudio() || capFilterCloud()) {
      models = models.filter((m) => {
        const caps = m.capabilities
        if (!caps) return false
        if (capFilterTools() && !caps.tools) return false
        if (capFilterImage() && !caps.image) return false
        if (capFilterVideo() && !caps.video) return false
        if (capFilterReasoning() && !caps.reasoning) return false
        if (capFilterAudio() && !caps.audio) return false
        if (capFilterCloud() && !caps.cloud) return false
        return true
      })
    }

    // Apply free model filter — show only models with actual cost object where both input & output are 0
    if (capFilterFree()) {
      models = models.filter((m) => m.cost !== undefined && m.cost.input === 0 && m.cost.output === 0)
    }

    if (!favoritesOnlyEnabled()) {
      return models
    }
    return models.filter((m) => favoriteKeySet().has(m.key))
  })

  const groupedVisibleOptions = createMemo<ModelGroup[]>(() => {
    const query = searchActive() ? inputValue().trim().toLowerCase() : ""
    const groups = new Map<string, ModelGroup>()
    for (const model of visibleOptions()) {
      if (query && !model.searchText.toLowerCase().includes(query)) continue
      const existing = groups.get(model.providerId)
      if (existing) {
        existing.models.push(model)
      } else {
        groups.set(model.providerId, { providerId: model.providerId, providerName: model.providerName, models: [model] })
      }
    }

    return Array.from(groups.values())
  })

  const sortedIndex = createMemo(() => new Map(sortedModels().map((m, index) => [m.key, index])))

  const pickerOptions = createMemo<PickerOption[]>(() => {
    // Sorted by context or status: one flat list across providers (each row
    // already shows its provider), so the order isn't broken up by headers
    if (sortMode() !== "provider") {
      return groupedVisibleOptions()
        .flatMap((group) => group.models)
        .sort((left, right) => sortedIndex().get(left.key)! - sortedIndex().get(right.key)!)
    }
    return groupedVisibleOptions().flatMap((group) => [
      {
        type: "header" as const,
        key: `provider:${group.providerId}`,
        providerId: group.providerId,
        providerName: group.providerName,
        searchText: `${group.providerName} ${group.providerId}`,
      },
      ...group.models,
    ])
  })


  const handleChange = async (value: PickerOption | null) => {
    if (!value || isProviderHeaderOption(value)) return
    await props.onModelChange({ providerId: value.providerId, modelId: value.id })
  }

  const customFilter = () => true

  createEffect(() => {
    if (isOpen()) {
      setManualAll(false)
      setExplicitFavorites(false)
      setAutoFavoritesEligibleAtOpen(hasFavorites() && currentModelIsFavorite())
      setSearchDirty(false)
      setInitialQuery("")
      setInputValue("")
      setInitialQueryReady(false)
      setTimeout(() => {
        const seeded = searchInputRef?.value ?? ""
        setInitialQuery(seeded)
        setInputValue(seeded)
        setInitialQueryReady(true)
        searchInputRef?.focus()
        searchInputRef?.select()
      }, 100)
    } else {
      setInitialQueryReady(false)
      setSearchDirty(false)
      setAutoFavoritesEligibleAtOpen(false)
      // Reset capability filters when dropdown closes
      setCapFilterTools(false)
      setCapFilterImage(false)
      setCapFilterVideo(false)
      setCapFilterReasoning(false)
      setCapFilterAudio(false)
      setCapFilterCloud(false)
      setCapFilterFree(false)
    }
  })

  createEffect(() => {
    if (!isOpen()) {
      wasFavoritesOnlyEnabled = favoritesOnlyEnabled()
      wasCurrentModelFavorite = currentModelIsFavorite()
      return
    }

    const nowFavoritesOnlyEnabled = favoritesOnlyEnabled()
    const nowCurrentModelFavorite = currentModelIsFavorite()

    if (wasFavoritesOnlyEnabled && !nowFavoritesOnlyEnabled && wasCurrentModelFavorite && !nowCurrentModelFavorite) {
      setTimeout(() => {
        const key = currentModelKey()
        const target = listboxRef?.querySelector(`[data-key="${key}"]`) as HTMLElement | null
        target?.scrollIntoView({ block: "nearest" })
      }, 0)
    }

    wasFavoritesOnlyEnabled = nowFavoritesOnlyEnabled
    wasCurrentModelFavorite = nowCurrentModelFavorite
  })

  const handleSearchInput = (event: InputEvent & { currentTarget: HTMLInputElement }) => {
    const next = event.currentTarget.value
    setInputValue(next)
    if (!initialQueryReady()) return
    if (searchDirty()) return
    if (next !== initialQuery()) {
      setSearchDirty(true)
    }
  }

  const preventListboxPress = (event: PointerEvent | MouseEvent) => {
    event.preventDefault()
    event.stopImmediatePropagation?.()
    event.stopPropagation()
    suppressNextClose = true
    setTimeout(() => {
      suppressNextClose = false
    }, 0)
  }

  const toggleFavoritesOnly = () => {
    if (!hasFavorites()) return
    if (searchActive()) return

    if (favoritesOnlyEnabled()) {
      setManualAll(true)
      setExplicitFavorites(false)
      setAutoFavoritesEligibleAtOpen(false)
      return
    }

    setExplicitFavorites(true)
    setManualAll(false)
  }

  const showAllModels = () => {
    setManualAll(true)
    setExplicitFavorites(false)
    setAutoFavoritesEligibleAtOpen(false)
    setTimeout(() => searchInputRef?.focus(), 0)
  }

  // Widest the popup can get without running off the right edge of the window
  const maxPopupWidth = () => {
    const left = popoverRef?.getBoundingClientRect().left ?? 0
    return Math.max(MIN_POPUP_WIDTH, window.innerWidth - left - 8)
  }
  const clampWidth = (width: number) => Math.min(Math.max(width, MIN_POPUP_WIDTH), maxPopupWidth())

  const startResize = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    event.preventDefault()
    event.stopPropagation()
    suppressNextClose = true
    const handle = event.currentTarget
    const startX = event.clientX
    const startWidth = popoverRef?.getBoundingClientRect().width ?? popupWidth()
    handle.setPointerCapture(event.pointerId)
    document.body.style.cursor = "ew-resize"

    const onMove = (moveEvent: PointerEvent) => {
      setPopupWidth(clampWidth(startWidth + (moveEvent.clientX - startX)))
    }
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove)
      handle.removeEventListener("pointerup", onUp)
      handle.removeEventListener("pointercancel", onUp)
      document.body.style.cursor = ""
      savePopupWidth(popupWidth())
      setTimeout(() => { suppressNextClose = false }, 0)
    }
    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onUp)
    handle.addEventListener("pointercancel", onUp)
  }

  const handleResizeKey = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 80 : 20
    if (event.key === "ArrowRight") savePopupWidth(clampWidth(popupWidth() + step))
    else if (event.key === "ArrowLeft") savePopupWidth(clampWidth(popupWidth() - step))
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  const isOptionDisabled = (option: PickerOption): boolean => {
    if (isProviderHeaderOption(option)) return true
    // For model options, the option itself is the FlatModel
    return !isModelSelectable(option as FlatModel)
  }

  return (
    <div class="sidebar-selector">
      <Combobox<PickerOption>
        open={isOpen()}
        value={currentModelValue()}
        onChange={handleChange}
        onOpenChange={(next) => {
          if (!next && suppressNextClose) return
          setIsOpen(next)
        }}
        options={pickerOptions()}
        optionValue="key"
        optionTextValue="searchText"
        optionLabel={(option) => (isProviderHeaderOption(option) ? option.providerName : option.name)}
        optionDisabled={isOptionDisabled}
        placeholder={t("modelSelector.placeholder.search")}
        defaultFilter={customFilter}
        allowsEmptyCollection
        sameWidth={false}
        placement="bottom-start"
        itemComponent={(itemProps) => {
          if (isProviderHeaderOption(itemProps.item.rawValue)) {
            const header = itemProps.item.rawValue
            return (
              <li class="selector-section" role="presentation">
                <span class="selector-section-title" title={header.providerId}>
                  {header.providerName}
                  {header.providerName !== header.providerId && <span dir="ltr"> · {header.providerId}</span>}
                </span>
              </li>
            )
          }

          const model = itemProps.item.rawValue
          const isFavorite = () => favoriteKeySet().has(model.key)
          const selectable = isModelSelectable(model)
          const contextWindow = formatContextWindow(model.limit)
          // Favorites of unavailable models are kept (shown greyed out, not
          // selectable). Removing them here looped: the toggle re-ran on every
          // state save and flipped the favorite on and off with endless PATCHes.

          return (
            <Combobox.Item
              item={itemProps.item}
              class="selector-option"
            >
              <>
                <div class="selector-option-content">
                  <Combobox.ItemLabel class="selector-option-label">{model.name}</Combobox.ItemLabel>
                  <Combobox.ItemDescription class="selector-option-description flex items-center gap-2">
                    <span>{model.providerName} • {model.providerId}/{model.id}</span>
                    {contextWindow && <span class="text-xs text-muted-foreground px-1.5 py-0.5 rounded bg-muted">Ctx: {contextWindow}</span>}
                    <CapabilityIcons capabilities={model.capabilities} />
                    <StatusBadge status={model.status} errorDetails={model.errorDetails} />
                  </Combobox.ItemDescription>
                </div>
                <Combobox.ItemIndicator class="selector-option-indicator">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                </Combobox.ItemIndicator>
                <button
                  type="button"
                  class="selector-option-star"
                  data-active={isFavorite()}
                  aria-label={
                    isFavorite()
                      ? t("modelSelector.favorite.remove")
                      : t("modelSelector.favorite.add")
                  }
                  disabled={!selectable}
                  onPointerDown={preventListboxPress}
                  onPointerUp={preventListboxPress}
                  onMouseDown={preventListboxPress}
                  onMouseUp={preventListboxPress}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    event.stopPropagation()
                    suppressNextClose = true
                    setTimeout(() => {
                      suppressNextClose = false
                    }, 0)
                  }}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    if (selectable) {
                      toggleFavoriteModelPreference({
                        providerId: model.providerId,
                        modelId: model.id,
                      })
                    }
                  }}
                >
                  <Star
                    class="w-4 h-4 transition-colors"
                    fill={isFavorite() ? "currentColor" : "none"}
                    style={{ opacity: selectable ? 1 : 0.4 }}
                  />
                </button>
              </>
            </Combobox.Item>
          )
        }}
      >
        <Combobox.Control class="relative w-full" data-model-selector-control>
          <Combobox.Input class="sr-only" data-model-selector />
          <Combobox.Trigger
            ref={triggerRef}
            class="selector-trigger"
          >
            <div class="selector-trigger-label selector-trigger-label--stacked flex-1 min-w-0">
              <span class="selector-trigger-primary selector-trigger-primary--align-left">
                {t("modelSelector.trigger.primary", { model: currentModelValue()?.name ?? t("modelSelector.none") })}
              </span>
          {currentModelValue() && (
                <span class="selector-trigger-secondary" dir="ltr">
                  {currentModelValue()!.providerId}/{currentModelValue()!.id}
                </span>
              )}
            </div>
            <Combobox.Icon class="selector-trigger-icon">
              <ChevronDown class="w-3 h-3" />
            </Combobox.Icon>
          </Combobox.Trigger>
        </Combobox.Control>

        <Combobox.Portal>
          <Combobox.Content
            ref={popoverRef}
            class="selector-popover model-selector-popover"
            style={{ width: `${popupWidth()}px` }}
          >
            <div
              class="model-selector-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("modelSelector.resize.ariaLabel")}
              title={t("modelSelector.resize.title")}
              tabIndex={0}
              onPointerDown={startResize}
              onMouseDown={preventListboxPress}
              onKeyDown={handleResizeKey}
              onDblClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                savePopupWidth(clampWidth(DEFAULT_POPUP_WIDTH))
              }}
            />
            <div class="selector-search-container">
              <div class="selector-input-group">
                <Combobox.Input
                  ref={searchInputRef}
                  class="selector-search-input flex-1 min-w-0"
                  placeholder={t("modelSelector.placeholder.search")}
                  onInput={handleSearchInput}
                />
                <button
                  type="button"
                  class="selector-favorites-toggle"
                  aria-label={t("modelSelector.favoritesOnly.toggle.ariaLabel")}
                  aria-pressed={favoritesOnlyEnabled()}
                  disabled={!hasFavorites() || searchActive()}
                  data-active={favoritesOnlyEnabled()}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    toggleFavoritesOnly()
                  }}
                >
                  <Star class="w-4 h-4" fill={favoritesOnlyEnabled() ? "currentColor" : "none"} />
                </button>
                <button
                  type="button"
                  class="selector-favorites-toggle selector-sort-toggle"
                  aria-label={t("modelSelector.sort.ariaLabel")}
                  title={t(`modelSelector.sort.${sortMode()}`)}
                  data-active={sortMode() !== "provider"}
                  onMouseDown={preventListboxPress}
                  onPointerDown={preventListboxPress}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    cycleSortMode()
                    suppressNextClose = true
                    setTimeout(() => { suppressNextClose = false }, 0)
                  }}
                >
                  <ArrowUpDown class="w-4 h-4" />
                  {sortMode() !== "provider" && (
                    <span class="selector-sort-label">{t(`modelSelector.sort.short.${sortMode()}`)}</span>
                  )}
                </button>
              </div>
            </div>
            {/* Capability filter toggle bar */}
            <div class="selector-capability-filters">
              {([
                { signal: capFilterTools, set: setCapFilterTools, icon: Cpu, label: "Tools", color: "var(--status-info, #3b82f6)" },
                { signal: capFilterImage, set: setCapFilterImage, icon: Image, label: "Vision", color: "var(--status-success, #22c55e)" },
                { signal: capFilterVideo, set: setCapFilterVideo, icon: Video, label: "Video", color: "#a855f7" },
                { signal: capFilterReasoning, set: setCapFilterReasoning, icon: Brain, label: "Reasoning", color: "#f97316" },
                { signal: capFilterAudio, set: setCapFilterAudio, icon: Music, label: "Audio", color: "#ec4899" },
                { signal: capFilterCloud, set: setCapFilterCloud, icon: Cloud, label: "Cloud", color: "#06b6d4" },
              ] as const).map((cap) => (
                <button
                  type="button"
                  class="selector-capability-toggle"
                  data-active={cap.signal()}
                  aria-pressed={cap.signal()}
                  aria-label={cap.label}
                  title={cap.label}
                  onMouseDown={preventListboxPress}
                  onPointerDown={preventListboxPress}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    cap.set(!cap.signal())
                    suppressNextClose = true
                    setTimeout(() => { suppressNextClose = false }, 0)
                  }}
                >
                  <cap.icon
                    class="w-3.5 h-3.5"
                    style={{
                      color: cap.signal() ? cap.color : "var(--text-muted)",
                      opacity: cap.signal() ? 1 : 0.4,
                    }}
                  />
                  <span
                    class="selector-capability-toggle-label"
                    style={{ color: cap.signal() ? cap.color : "var(--text-muted)" }}
                  >
                    {cap.label}
                  </span>
                </button>
              ))}
              <button
                type="button"
                class="selector-capability-toggle"
                data-active={capFilterFree()}
                aria-pressed={capFilterFree()}
                aria-label={t("modelSelector.freeToggle.label")}
                title={t("modelSelector.freeToggle.title")}
                onMouseDown={preventListboxPress}
                onPointerDown={preventListboxPress}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setCapFilterFree(!capFilterFree())
                  suppressNextClose = true
                  setTimeout(() => { suppressNextClose = false }, 0)
                }}
              >
                <Gift
                  class="w-3.5 h-3.5"
                  style={{
                    color: capFilterFree() ? "var(--status-success, #22c55e)" : "var(--text-muted)",
                    opacity: capFilterFree() ? 1 : 0.4,
                  }}
                />
                <span
                  class="selector-capability-toggle-label"
                  style={{ color: capFilterFree() ? "var(--status-success, #22c55e)" : "var(--text-muted)" }}
                >
                  {t("modelSelector.freeToggle.label")}
                </span>
              </button>
              <button
                type="button"
                class="selector-capability-toggle"
                data-active={showUnavailable()}
                aria-pressed={showUnavailable()}
                aria-label={t("modelSelector.showUnavailable.label")}
                title={t("modelSelector.showUnavailable.title")}
                disabled={unavailableCount() === 0}
                onMouseDown={preventListboxPress}
                onPointerDown={preventListboxPress}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  toggleShowUnavailable()
                  suppressNextClose = true
                  setTimeout(() => { suppressNextClose = false }, 0)
                }}
              >
                {showUnavailable() ? (
                  <Eye class="w-3.5 h-3.5" style={{ color: "var(--text-primary)" }} />
                ) : (
                  <EyeOff class="w-3.5 h-3.5" style={{ color: "var(--text-muted)", opacity: 0.4 }} />
                )}
                <span
                  class="selector-capability-toggle-label"
                  style={{ color: showUnavailable() ? "var(--text-primary)" : "var(--text-muted)" }}
                >
                  {t("modelSelector.showUnavailable.label")} ({unavailableCount()})
                </span>
              </button>
            </div>
            <Combobox.Listbox ref={listboxRef} class="selector-listbox" />
            <div class="selector-footer">
              <button
                type="button"
                class="selector-option selector-option-action w-full"
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setIsOpen(false)
                  setProvidersModalOpen(true)
                }}
              >
                <PlugZap class="w-4 h-4" />
                <span class="selector-option-label">{t("modelSelector.manageProviders")}</span>
              </button>
              <button
                type="button"
                class="selector-option selector-option-action w-full"
                style={{ display: favoritesOnlyEnabled() && !searchActive() ? "flex" : "none" }}
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  showAllModels()
                }}
              >
                <span class="selector-option-label">{t("modelSelector.favoritesOnly.showAll")}</span>
              </button>
            </div>
          </Combobox.Content>
        </Combobox.Portal>
      </Combobox>
      <ProviderManagerModal instanceId={props.instanceId} open={providersModalOpen()} onOpenChange={setProvidersModalOpen} />
    </div>
  )
}
