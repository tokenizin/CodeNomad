/**
 * Search and sort for the directory browser ("Attach files") dialog: the toolbar above the list, the list of
 * search results, and the state behind them. The dialog keeps browsing; this file owns everything about finding.
 */
import { Component, For, Show, createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { File as FileIcon, Loader2, Search, X } from "lucide-solid"
import type { FileSystemEntry } from "@codenomad/api-types"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import {
  DIRECTORY_SORT_MODES,
  MIN_CONTENT_QUERY_LENGTH,
  SEARCH_DEBOUNCE_MS,
  formatFileSize,
  formatModifiedAt,
  isOverAttachLimit,
  type DirectorySortMode,
} from "../lib/directory-browser-discovery"

export type DirectorySearchMode = "name" | "content"

export interface DirectorySearchRow {
  entry: FileSystemEntry
  /** Content search only: matching lines in the file. */
  matches?: number
  snippets?: Array<{ line: number; text: string }>
}

/**
 * Searches below `path` as the person types: debounced, and a newer search cancels the one before it (the server
 * stops working on a cancelled request). Disabled, or with an empty box, it holds no results.
 */
export function createDirectorySearch(options: { path: Accessor<string | undefined>; enabled: Accessor<boolean> }) {
  const [query, setQuery] = createSignal("")
  const [mode, setMode] = createSignal<DirectorySearchMode>("name")
  const [rows, setRows] = createSignal<DirectorySearchRow[]>([])
  const [searching, setSearching] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [truncated, setTruncated] = createSignal(false)
  const [skippedTooLarge, setSkippedTooLarge] = createSignal(0)

  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let runId = 0

  function cancel() {
    if (timer) clearTimeout(timer)
    timer = undefined
    controller?.abort()
    controller = undefined
  }

  const tooShort = () => mode() === "content" && query().trim().length > 0 && query().trim().length < MIN_CONTENT_QUERY_LENGTH
  const isActive = () => options.enabled() && query().trim().length > 0

  createEffect(
    on([query, mode, options.path, options.enabled], ([rawQuery, searchMode, path, enabled]) => {
      cancel()
      const id = ++runId
      const text = rawQuery.trim()
      setError(null)
      setTruncated(false)
      setSkippedTooLarge(0)
      if (!enabled || !text || (searchMode === "content" && text.length < MIN_CONTENT_QUERY_LENGTH)) {
        setRows([])
        setSearching(false)
        return
      }
      setSearching(true)
      timer = setTimeout(async () => {
        const current = new AbortController()
        controller = current
        try {
          if (searchMode === "name") {
            const result = await serverApi.searchFileSystem(text, { path, signal: current.signal })
            if (id !== runId) return
            setRows(result.entries.map((entry) => ({ entry })))
            setTruncated(result.truncated)
          } else {
            const result = await serverApi.searchFileSystemContent(text, { path, signal: current.signal })
            if (id !== runId) return
            setRows(result.hits.map((hit) => ({ entry: hit.entry, matches: hit.matches, snippets: hit.snippets })))
            setTruncated(result.truncated)
            setSkippedTooLarge(result.skippedTooLarge)
          }
        } catch (err) {
          if (id !== runId || current.signal.aborted) return
          setRows([])
          setError(err instanceof Error && err.message ? err.message : "")
        } finally {
          if (id === runId) setSearching(false)
        }
      }, SEARCH_DEBOUNCE_MS)
    }),
  )

  onCleanup(cancel)

  function reset() {
    cancel()
    runId += 1
    setQuery("")
    setMode("name")
    setRows([])
    setSearching(false)
    setError(null)
    setTruncated(false)
    setSkippedTooLarge(0)
  }

  return { query, setQuery, mode, setMode, rows, searching, error, truncated, skippedTooLarge, tooShort, isActive, reset }
}

export type DirectorySearch = ReturnType<typeof createDirectorySearch>

interface ToolbarProps {
  sortMode: DirectorySortMode
  onSortChange: (mode: DirectorySortMode) => void
  /** Search is offered when picking files; picking a folder only sorts. */
  search?: DirectorySearch
}

export const DirectoryBrowserToolbar: Component<ToolbarProps> = (props) => {
  const { t } = useI18n()
  return (
    <div class="directory-browser-tools">
      <Show when={props.search}>
        {(search) => (
          <>
            <div class="directory-browser-search">
              <Search class="directory-browser-search-icon w-4 h-4" aria-hidden="true" />
              <input
                type="search"
                class="selector-input directory-browser-search-input"
                value={search().query()}
                onInput={(event) => search().setQuery(event.currentTarget.value)}
                placeholder={t("directoryBrowser.search.placeholder")}
                aria-label={t("directoryBrowser.search.ariaLabel")}
                spellcheck={false}
                autocomplete="off"
                data-directory-search-input
              />
              <Show when={search().query()}>
                <button
                  type="button"
                  class="directory-browser-search-clear"
                  aria-label={t("directoryBrowser.search.clear")}
                  title={t("directoryBrowser.search.clear")}
                  onClick={() => search().setQuery("")}
                >
                  <X class="w-4 h-4" />
                </button>
              </Show>
            </div>
            <div class="directory-browser-segment" role="group" aria-label={t("directoryBrowser.search.mode.ariaLabel")}>
              <For each={["name", "content"] as DirectorySearchMode[]}>
                {(mode) => (
                  <button
                    type="button"
                    class="directory-browser-segment-button"
                    classList={{ "directory-browser-segment-button-active": search().mode() === mode }}
                    aria-pressed={search().mode() === mode}
                    data-directory-search-mode={mode}
                    onClick={() => search().setMode(mode)}
                  >
                    {t(`directoryBrowser.search.mode.${mode}`)}
                  </button>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
      <label class="directory-browser-sort">
        <span class="directory-browser-sort-label">{t("directoryBrowser.sort.label")}</span>
        <select
          class="selector-input directory-browser-sort-select"
          value={props.sortMode}
          onChange={(event) => props.onSortChange(event.currentTarget.value as DirectorySortMode)}
          data-directory-sort
        >
          <For each={DIRECTORY_SORT_MODES}>{(mode) => <option value={mode}>{t(`directoryBrowser.sort.${mode}`)}</option>}</For>
        </select>
      </label>
    </div>
  )
}

/** "12.3 KB · Jan 5, 2026, 10:30 AM": whichever parts are known. */
export function entryMetaLabel(entry: FileSystemEntry, locale?: string): string {
  return [entry.type === "file" ? formatFileSize(entry.size) : "", formatModifiedAt(entry.modifiedAt, locale)].filter(Boolean).join(" · ")
}

interface ResultsProps {
  search: DirectorySearch
  onSelect: (entry: FileSystemEntry) => void
  /** Files over this size cannot be attached: they are shown, marked, and cannot be selected. */
  maxFileBytes?: number
}

export const DirectoryBrowserSearchResults: Component<ResultsProps> = (props) => {
  const { t, locale } = useI18n()
  const countLabel = (key: string, count: number) => t(count === 1 ? `${key}.one` : `${key}.other`, { count })

  return (
    <Show
      when={!props.search.searching()}
      fallback={
        <div class="panel-empty-state flex-1">
          <div class="directory-browser-loading">
            <Loader2 class="w-5 h-5 animate-spin" />
            <span>{t("directoryBrowser.search.searching")}</span>
          </div>
        </div>
      }
    >
      <Show
        when={props.search.error() === null}
        fallback={
          <div class="panel-empty-state flex-1">
            <span class="text-red-500">{props.search.error() || t("directoryBrowser.search.errorFallback")}</span>
          </div>
        }
      >
        <Show
          when={props.search.rows().length > 0}
          fallback={
            <div class="panel-empty-state flex-1" data-directory-search-empty>
              {props.search.tooShort() ? t("directoryBrowser.search.contentTooShort") : t("directoryBrowser.search.noResults")}
            </div>
          }
        >
          <div class="panel-list panel-list--fill flex-1 min-h-0 overflow-auto directory-browser-list" role="listbox" data-directory-search-results>
            <For each={props.search.rows()}>
              {(row) => {
                const tooLarge = isOverAttachLimit(row.entry, props.maxFileBytes)
                const meta = entryMetaLabel(row.entry, locale())
                return (
                  <div class="panel-list-item" role="option">
                    <div class="panel-list-item-content directory-browser-row">
                      <button
                        type="button"
                        class="directory-browser-row-main"
                        disabled={tooLarge}
                        onClick={() => props.onSelect(row.entry)}
                      >
                        <div class="directory-browser-row-icon">
                          <FileIcon class="w-4 h-4" />
                        </div>
                        <div class="directory-browser-row-text">
                          <span class="directory-browser-row-name">{row.entry.name}</span>
                          <span class="directory-browser-row-crumb">
                            {row.entry.crumbPath ? row.entry.crumbPath : t("directoryBrowser.search.inThisFolder")}
                          </span>
                          <span class="directory-browser-row-meta">
                            {[
                              meta,
                              typeof row.matches === "number" ? countLabel("directoryBrowser.search.matches", row.matches) : "",
                              tooLarge ? t("directoryBrowser.tooLarge") : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                          <Show when={row.snippets?.length}>
                            <ul class="directory-browser-snippets">
                              <For each={row.snippets}>
                                {(snippet) => (
                                  <li class="directory-browser-snippet">
                                    <span class="directory-browser-snippet-line">{snippet.line}</span>
                                    <span class="directory-browser-snippet-text">{snippet.text}</span>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                        </div>
                      </button>
                      <button
                        type="button"
                        class="selector-button selector-button-secondary directory-browser-select"
                        disabled={tooLarge}
                        title={tooLarge ? t("directoryBrowser.tooLarge") : undefined}
                        onClick={(event) => {
                          event.stopPropagation()
                          props.onSelect(row.entry)
                        }}
                      >
                        {t("directoryBrowser.select")}
                      </button>
                    </div>
                  </div>
                )
              }}
            </For>
            <Show when={props.search.truncated() || props.search.skippedTooLarge() > 0}>
              <div class="directory-browser-search-note">
                <Show when={props.search.truncated()}>
                  <span>{t("directoryBrowser.search.truncated")}</span>
                </Show>
                <Show when={props.search.skippedTooLarge() > 0}>
                  <span>{countLabel("directoryBrowser.search.skippedTooLarge", props.search.skippedTooLarge())}</span>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </Show>
    </Show>
  )
}
