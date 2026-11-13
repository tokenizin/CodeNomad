/**
 * Sorting and labels for the directory browser ("Attach files") dialog. Pure functions, no UI.
 */
import type { FileSystemEntry } from "@codenomad/api-types"

export type DirectorySortMode = "name" | "modified" | "size"

export const DIRECTORY_SORT_MODES: DirectorySortMode[] = ["name", "modified", "size"]

/** Wait after the last keystroke before searching. */
export const SEARCH_DEBOUNCE_MS = 300
/** A content search on one or two letters matches most of a workspace. */
export const MIN_CONTENT_QUERY_LENGTH = 3

function byName(a: FileSystemEntry, b: FileSystemEntry) {
  return a.name.localeCompare(b.name)
}

/**
 * Folders first (so the tree stays navigable in every mode), then by the chosen key:
 * name A to Z, newest first, or largest first. Entries without a date or size go last; ties fall back to the name.
 */
export function sortDirectoryEntries(entries: FileSystemEntry[], mode: DirectorySortMode): FileSystemEntry[] {
  return [...entries].sort((a, b) => {
    const aFolder = a.type === "directory" ? 0 : 1
    const bFolder = b.type === "directory" ? 0 : 1
    if (aFolder !== bFolder) return aFolder - bFolder
    if (mode === "modified") {
      const aTime = a.modifiedAt ? Date.parse(a.modifiedAt) : Number.NaN
      const bTime = b.modifiedAt ? Date.parse(b.modifiedAt) : Number.NaN
      const aKnown = Number.isFinite(aTime)
      const bKnown = Number.isFinite(bTime)
      if (aKnown !== bKnown) return aKnown ? -1 : 1
      if (aKnown && bKnown && aTime !== bTime) return bTime - aTime
      return byName(a, b)
    }
    if (mode === "size") {
      const aKnown = typeof a.size === "number"
      const bKnown = typeof b.size === "number"
      if (aKnown !== bKnown) return aKnown ? -1 : 1
      if (aKnown && bKnown && a.size !== b.size) return (b.size as number) - (a.size as number)
      return byName(a, b)
    }
    return byName(a, b)
  })
}

/** "912 B", "1.4 KB", "5.0 MB". Empty for a folder or an unknown size. */
export function formatFileSize(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** Local date and time of the last change, in the person's locale. Empty when unknown. */
export function formatModifiedAt(iso: string | undefined, locale?: string): string {
  if (!iso) return ""
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ""
  return new Date(time).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function isOverAttachLimit(entry: FileSystemEntry, maxBytes: number | undefined): boolean {
  return typeof maxBytes === "number" && typeof entry.size === "number" && entry.size > maxBytes
}
