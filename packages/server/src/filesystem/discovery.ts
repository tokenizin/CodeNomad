/**
 * Search for the "Attach files" dialog: by file name through nested folders, and by file content.
 *
 * Both searches start from a directory inside the server's configured root (`FileSystemBrowser.resolveSearchScope`)
 * and never leave it: links are not followed, and every content hit is checked against the root's real path.
 * Neither blocks the server: names are walked with async I/O, content is searched in a child process.
 */
import { spawn } from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type {
  FileSystemContentSearchHit,
  FileSystemContentSearchResponse,
  FileSystemEntry,
  FileSystemSearchResponse,
} from "../api-types"
import type { SearchResult } from "../plugins/tokidapp/concierge/text-search"
import { MAX_READABLE_FILE_BYTES, type FileSystemBrowser } from "./browser"

const DEFAULT_NAME_LIMIT = 50
const MAX_NAME_LIMIT = 200
const DEFAULT_DEPTH = 6
const MAX_DEPTH = 12
/** Entries looked at before a name search gives up and reports `truncated`. */
const MAX_VISITED_ENTRIES = 60_000
const NAME_SEARCH_BUDGET_MS = 8_000
const MAX_QUERY_LENGTH = 200
const MAX_TOKENS = 8

const DEFAULT_CONTENT_LIMIT = 30
const MAX_CONTENT_LIMIT = 50
const CONTENT_SEARCH_TIMEOUT_MS = 40_000
const MAX_WORKER_OUTPUT_BYTES = 8 * 1024 * 1024

/** Folders that hold generated or vendored files: never what a person wants to attach, and most of the tree. */
const IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", ".next", ".nuxt", ".turbo", ".cache", "coverage", "target",
])

export interface FileNameSearchOptions {
  /** Directory to search, as the dialog shows it. Defaults to the root. */
  path?: string
  limit?: number
  /** How many folder levels below `path` to look into (0 = only `path` itself). */
  depth?: number
  signal?: AbortSignal
}

export interface ContentSearchOptions {
  path?: string
  limit?: number
  signal?: AbortSignal
  /** Replaces the child process. Tests only. */
  runSearch?: (input: ContentSearchInput, signal?: AbortSignal) => Promise<SearchResult>
}

export interface ContentSearchInput {
  query: string
  root: string
  maxFiles: number
  snippetsPerFile: number
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

function normalizeQuery(query: string): string {
  const trimmed = query.trim()
  if (!trimmed) throw new Error("Search query is required")
  if (trimmed.length > MAX_QUERY_LENGTH) throw new Error(`Search query is too long (max ${MAX_QUERY_LENGTH} characters)`)
  return trimmed
}

/**
 * How well a file matches, 0 when it does not. Every word must appear somewhere in the path below the searched
 * folder; a match in the file's own name outranks one that is only in a folder name.
 */
export function scoreFileName(tokens: string[], lowerName: string, lowerRelativePath: string): number {
  for (const token of tokens) {
    if (!lowerRelativePath.includes(token)) return 0
  }
  let score = 1
  if (tokens.every((token) => lowerName.includes(token))) score += 4
  if (lowerName.startsWith(tokens[0])) score += 3
  const stem = lowerName.replace(/\.[^.]+$/, "")
  if (tokens.length === 1 && (lowerName === tokens[0] || stem === tokens[0])) score += 5
  return score
}

interface NameMatch {
  absolutePath: string
  relativePath: string
  name: string
  score: number
}

export async function searchFileNames(
  browser: FileSystemBrowser,
  query: string,
  options: FileNameSearchOptions = {},
): Promise<FileSystemSearchResponse> {
  const tokens = normalizeQuery(query).toLowerCase().split(/\s+/).slice(0, MAX_TOKENS)
  const scope = browser.resolveSearchScope(options.path)
  const limit = clamp(options.limit, 1, MAX_NAME_LIMIT, DEFAULT_NAME_LIMIT)
  const maxDepth = clamp(options.depth, 0, MAX_DEPTH, DEFAULT_DEPTH)
  const deadline = Date.now() + NAME_SEARCH_BUDGET_MS

  const matches: NameMatch[] = []
  let visited = 0
  let truncated = false
  // Breadth first, so a file near the top is found before the budget runs out in some deep folder.
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [{ absolute: scope.base, relative: "", depth: 0 }]

  walk: for (let index = 0; index < queue.length; index += 1) {
    const directory = queue[index]
    let dirents: fs.Dirent[]
    try {
      dirents = await fs.promises.readdir(directory.absolute, { withFileTypes: true })
    } catch {
      continue // unreadable folder
    }
    for (const dirent of dirents) {
      if (options.signal?.aborted) throw new Error("Search cancelled")
      visited += 1
      if (visited > MAX_VISITED_ENTRIES || Date.now() > deadline) {
        truncated = true
        break walk
      }
      // A link can point outside the root, or back up the tree: neither is followed nor listed.
      if (dirent.isSymbolicLink()) continue
      const lowerName = dirent.name.toLowerCase()
      const relativePath = directory.relative ? `${directory.relative}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(lowerName) && directory.depth < maxDepth) {
          queue.push({ absolute: path.join(directory.absolute, dirent.name), relative: relativePath, depth: directory.depth + 1 })
        }
        continue
      }
      if (!dirent.isFile()) continue
      const score = scoreFileName(tokens, lowerName, relativePath.toLowerCase())
      if (score > 0) {
        matches.push({ absolutePath: path.join(directory.absolute, dirent.name), relativePath, name: dirent.name, score })
      }
    }
  }

  matches.sort(
    (a, b) => b.score - a.score || a.relativePath.length - b.relativePath.length || a.relativePath.localeCompare(b.relativePath),
  )
  if (matches.length > limit) truncated = true

  const entries: FileSystemEntry[] = []
  for (const match of matches.slice(0, limit)) {
    let stats: fs.Stats
    try {
      stats = await fs.promises.stat(match.absolutePath)
    } catch {
      continue // removed while we searched
    }
    entries.push({
      name: match.name,
      path: scope.toEntryPath(match.absolutePath),
      absolutePath: match.absolutePath,
      type: "file",
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      crumbPath: path.posix.dirname(match.relativePath) === "." ? "" : path.posix.dirname(match.relativePath),
    })
  }

  return { entries, truncated, basePath: scope.base }
}

/** Path of the worker next to this file: `.ts` when run from source (bun, tsx), `.js` from the compiled build. */
function workerPath(): string {
  const here = fileURLToPath(import.meta.url)
  return path.join(path.dirname(here), `content-search-worker${path.extname(here)}`)
}

/** Runs the ranked text search in a child process, so a slow search never stalls the server. */
export function runContentSearchProcess(input: ContentSearchInput, signal?: AbortSignal): Promise<SearchResult> {
  return new Promise((resolve, reject) => {
    // execArgv carries the loader flags when the server itself runs through tsx.
    const child = spawn(process.execPath, [...process.execArgv, workerPath()], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (error: Error | null, result?: SearchResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve(result as SearchResult)
    }
    const onAbort = () => {
      child.kill("SIGKILL")
      finish(new Error("Search cancelled"))
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(new Error("Content search took too long. Search a smaller folder, or use more specific words."))
    }, CONTENT_SEARCH_TIMEOUT_MS)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      if (stdout.length > MAX_WORKER_OUTPUT_BYTES) {
        child.kill("SIGKILL")
        finish(new Error("Content search returned too much data"))
      }
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000)
    })
    child.on("error", (error) => finish(new Error(`Content search could not start: ${error.message}`)))
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(`Content search failed${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ` (exit ${code})`}`))
        return
      }
      try {
        finish(null, JSON.parse(stdout) as SearchResult)
      } catch {
        finish(new Error("Content search returned an unreadable result"))
      }
    })
    child.stdin.on("error", () => {
      /* the child exited before reading; "close" reports it */
    })
    child.stdin.end(JSON.stringify(input))
  })
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
}

export async function searchFileContents(
  browser: FileSystemBrowser,
  query: string,
  options: ContentSearchOptions = {},
): Promise<FileSystemContentSearchResponse> {
  const normalized = normalizeQuery(query)
  const scope = browser.resolveSearchScope(options.path)
  const limit = clamp(options.limit, 1, MAX_CONTENT_LIMIT, DEFAULT_CONTENT_LIMIT)
  const run = options.runSearch ?? runContentSearchProcess
  const result = await run({ query: normalized, root: scope.base, maxFiles: limit, snippetsPerFile: 2 }, options.signal)

  const realRoot = await fs.promises.realpath(scope.root)
  const hits: FileSystemContentSearchHit[] = []
  let skippedTooLarge = 0
  for (const hit of result.hits) {
    const absolutePath = path.resolve(hit.file)
    let stats: fs.Stats
    try {
      // The search engine decides what it walks; the real path decides whether we show it.
      if (!isInside(realRoot, await fs.promises.realpath(absolutePath))) continue
      stats = await fs.promises.stat(absolutePath)
    } catch {
      continue
    }
    if (!stats.isFile()) continue
    if (stats.size > MAX_READABLE_FILE_BYTES) {
      skippedTooLarge += 1
      continue
    }
    const relativePath = path.relative(scope.base, absolutePath).split(path.sep).join("/")
    const folder = path.posix.dirname(relativePath)
    hits.push({
      entry: {
        name: path.basename(absolutePath),
        path: scope.toEntryPath(absolutePath),
        absolutePath,
        type: "file",
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        crumbPath: folder === "." ? "" : folder,
      },
      matches: hit.hits,
      snippets: hit.snippets.map((snippet) => ({ line: snippet.line, text: snippet.text.slice(0, 300) })),
    })
  }

  return {
    hits,
    terms: result.terms,
    truncated: result.truncated,
    skippedTooLarge,
    engine: result.engine,
    basePath: scope.base,
  }
}
