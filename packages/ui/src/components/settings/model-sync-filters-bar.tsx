import { createMemo, createSignal, For, onCleanup, onMount, type Component } from "solid-js"

import { useI18n } from "../../lib/i18n"
import { CAPABILITY_KEYS, type ModelSyncFilter, type SyncedModelRow } from "../../lib/model-sync/filter-models"

// i18n keys for the filter selector labels (values live in all 10 locale files).
const FILTER_LABEL_KEYS: Record<ModelSyncFilter, string> = {
  all: "settings.section.modelSync.filter.all",
  capabilities: "settings.section.modelSync.filter.capabilities",
  provider: "settings.section.modelSync.filter.provider",
  model: "settings.section.modelSync.filter.model",
  id: "settings.section.modelSync.filter.id",
  category: "settings.section.modelSync.filter.category",
}

export interface ModelSyncFiltersBarProps {
  /** All synced rows (unfiltered) — drives the suggestion list. */
  rows: SyncedModelRow[]
  searchQuery: string
  onSearchChange: (value: string) => void
  filter: ModelSyncFilter
  onFilterChange: (filter: ModelSyncFilter) => void
  providerId: string | null
  onProviderChange: (providerId: string | null) => void
  providerOptions: Array<{ value: string; label: string }>
}

/**
 * Search + filter controls for the Model Status table. Owns only UI state
 * (suggestion listbox open/active index); the filter values themselves are
 * controlled by the parent so the table can react to them.
 */
export const ModelSyncFiltersBar: Component<ModelSyncFiltersBarProps> = (props) => {
  const { t } = useI18n()
  // Search suggestion listbox state (P2-b / a11y)
  const [suggestionsOpen, setSuggestionsOpen] = createSignal(false)
  const [activeSuggestionIndex, setActiveSuggestionIndex] = createSignal(-1)
  let searchWrapRef: HTMLDivElement | undefined

  onMount(() => {
    // REOPEN-AC-2: close suggestions on outside click without breaking option mousedown selection.
    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!searchWrapRef || !target) return
      if (!searchWrapRef.contains(target)) {
        setSuggestionsOpen(false)
        setActiveSuggestionIndex(-1)
      }
    }
    document.addEventListener("mousedown", handleDocumentMouseDown)
    onCleanup(() => document.removeEventListener("mousedown", handleDocumentMouseDown))
  })

  // P1-d: derive suggestions from the loaded rows instead of permanently-empty
  // static arrays. Capabilities stay a fixed vocabulary from the pure module.
  const allSuggestionOptions = createMemo<string[]>(() => {
    const dedupe = (values: string[]) => Array.from(new Set(values.filter(Boolean)))
    const rows = props.rows
    switch (props.filter) {
      case "capabilities":
        return [...CAPABILITY_KEYS]
      case "provider":
        return dedupe(rows.map((r) => r.providerId))
      case "model":
        return dedupe(rows.flatMap((r) => [r.modelName, r.modelId]))
      case "id":
        return dedupe(rows.map((r) => r.modelId))
      case "category":
        return dedupe(rows.map((r) => r.type))
      default:
        return dedupe(rows.flatMap((r) => [r.providerName, r.modelName, r.modelId, r.type]))
    }
  })

  // Only suggest values that contain what the user has typed (case-insensitive),
  // excluding an exact match of the current query, capped to keep the list short.
  const suggestionOptions = createMemo<string[]>(() => {
    const query = props.searchQuery.trim().toLowerCase()
    if (!query) return []
    return allSuggestionOptions()
      .filter((opt) => {
        const value = opt.toLowerCase()
        return value.includes(query) && value !== query
      })
      .slice(0, 20)
  })

  // P1-c: selecting a suggestion only sets the search query; it never changes
  // the active filter, so the current scope is preserved.
  const selectSuggestion = (option: string) => {
    props.onSearchChange(option)
    setSuggestionsOpen(false)
    setActiveSuggestionIndex(-1)
  }

  // P2-b: full combobox keyboard support.
  const handleSearchKeyDown = (event: KeyboardEvent) => {
    const options = suggestionOptions()
    if (event.key === "Escape") {
      setSuggestionsOpen(false)
      setActiveSuggestionIndex(-1)
      return
    }
    if (!suggestionsOpen() || options.length === 0) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveSuggestionIndex((index) => (index + 1) % options.length)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveSuggestionIndex((index) => (index <= 0 ? options.length - 1 : index - 1))
    } else if (event.key === "Home") {
      event.preventDefault()
      setActiveSuggestionIndex(0)
    } else if (event.key === "End") {
      event.preventDefault()
      setActiveSuggestionIndex(options.length - 1)
    } else if (event.key === "Enter" && activeSuggestionIndex() >= 0) {
      event.preventDefault()
      selectSuggestion(options[activeSuggestionIndex()])
    }
  }

  return (
    // Layout uses dedicated classes (model-sync-table.css) rather than utility
    // classes: the previous `sm:flex-order-1` / DaisyUI `input` classes do not
    // exist in this app, which collapsed the search box to 0px wide.
    <div class="model-sync-filters-bar">
        {/* Search input + suggestions (REOPEN-AC-2: relative anchor, outside click, accessible listbox) */}
        <div class="model-sync-filters-search" ref={(el) => (searchWrapRef = el)}>
          <input
            type="text"
            id="model-sync-search"
            role="combobox"
            aria-label={t("settings.section.modelSync.search.placeholder")}
            aria-autocomplete="list"
            aria-controls="model-sync-suggestion-list"
            aria-expanded={suggestionsOpen() && suggestionOptions().length > 0}
            aria-activedescendant={
              suggestionsOpen() && activeSuggestionIndex() >= 0
                ? `model-sync-suggestion-${activeSuggestionIndex()}`
                : undefined
            }
            placeholder={t("settings.section.modelSync.search.placeholder")}
            value={props.searchQuery}
            onInput={(e: Event) => {
              props.onSearchChange((e.target as HTMLInputElement | null)?.value ?? "")
              setSuggestionsOpen(true)
              setActiveSuggestionIndex(-1)
            }}
            onFocus={() => setSuggestionsOpen(true)}
            onBlur={() => {
              // Close when focus leaves the search wrapper. Option mousedown preventDefault
              // keeps input focus, so option selection is unaffected.
              setTimeout(() => {
                if (!searchWrapRef?.contains(document.activeElement)) {
                  setSuggestionsOpen(false)
                  setActiveSuggestionIndex(-1)
                }
              }, 0)
            }}
            onKeyDown={handleSearchKeyDown}
            class="selector-input model-sync-filters-input"
          />
          {props.searchQuery && suggestionsOpen() && suggestionOptions().length > 0 && (
            <div
              id="model-sync-suggestion-list"
              role="listbox"
              aria-label={t(FILTER_LABEL_KEYS[props.filter])}
              class="model-sync-filters-suggestions"
            >
              <div class="p-2 text-sm text-muted-foreground" role="presentation">
                <span class="text-caption">{t(FILTER_LABEL_KEYS[props.filter])}:</span>{" "}
                <For each={suggestionOptions()}>
                  {(opt, index) => (
                    <div
                      id={`model-sync-suggestion-${index()}`}
                      role="option"
                      aria-selected={index() === activeSuggestionIndex()}
                      class="model-sync-filters-option"
                      classList={{ "is-active": index() === activeSuggestionIndex() }}
                      onMouseDown={(e: MouseEvent) => e.preventDefault()}
                      onClick={() => selectSuggestion(opt)}
                    >
                      {opt}
                    </div>
                  )}
                </For>
              </div>
            </div>
          )}
        </div>
        
        {/* Filter selector (+ provider picker when filtering by provider) */}
        <div class="model-sync-filters-selects">
          <select
            value={props.filter}
            onChange={(e: Event) => {
              props.onFilterChange((e.currentTarget as HTMLSelectElement).value as ModelSyncFilter)
              setSuggestionsOpen(false)
              setActiveSuggestionIndex(-1)
            }}
            class="selector-input model-sync-filters-select"
          >
            <option value="all">{t("settings.section.modelSync.filter.all")}</option>
            <option value="capabilities">{t("settings.section.modelSync.filter.capabilities")}</option>
            <option value="provider">{t("settings.section.modelSync.filter.provider")}</option>
            <option value="model">{t("settings.section.modelSync.filter.model")}</option>
            <option value="id">{t("settings.section.modelSync.filter.id")}</option>
            <option value="category">{t("settings.section.modelSync.filter.category")}</option>
          </select>
        {props.filter === "provider" && (
            <select
              value={props.providerId ?? ""}
              onChange={(e: Event) => props.onProviderChange((e.currentTarget as HTMLSelectElement).value || null)}
              class="selector-input model-sync-filters-select"
              aria-label={t("settings.section.modelSync.provider.placeholder")}
            >
              <option value="">{t("settings.section.modelSync.provider.placeholder")}</option>
              <For each={props.providerOptions}>
                {(opt) => <option value={opt.value}>{opt.label}</option>}
              </For>
            </select>
        )}
        </div>
        
        {/* Clear search */}
        <button
          onClick={() => {
            props.onSearchChange("")
            setSuggestionsOpen(false)
            setActiveSuggestionIndex(-1)
          }}
          type="button"
          class="selector-button selector-button-tertiary model-sync-filters-clear"
          title={t("settings.section.modelSync.search.clear")}
        >
          {t("settings.section.modelSync.search.clear")}
        </button>
    </div>
  )
}
