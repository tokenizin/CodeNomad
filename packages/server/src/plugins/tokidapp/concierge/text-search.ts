/**
 * Ranked text search for the concierge's retrieval tools.
 *
 * Replaces the previous `rg -l -i "a|b|c"` shell-outs, which had two fatal flaws:
 *
 *  1. **Silent total failure.** The commands ended in `2>/dev/null || true`, so when the
 *     `rg` binary was missing the tool returned an empty string, which the caller reported
 *     as "no matches found". The model could not distinguish "nothing exists" from "search
 *     is broken", so it confidently told users a file did not exist. ripgrep is NOT
 *     installed on every host that runs this server — so that was the normal case, not an
 *     edge case.
 *
 *  2. **No precision.** OR-ing every term matched almost everything: on the StarWORLD vault a
 *     four-word question matched 179 of 205 notes, and a three-word one matched 892 source
 *     files. Results were then truncated to the first N in directory-walk order — i.e.
 *     arbitrary — and "previewed" with the first 30 lines of the file, which for a component
 *     is its import block.
 *
 *     (Deliberately no example queries spelled out here: this file would then rank as a top
 *     hit for the very searches it exists to serve.)
 *
 * This module fixes both:
 *  - ripgrep is used when present and a pure-Node walker is used when it is not, so the
 *    tools always work; `searchAvailability()` reports which engine ran.
 *  - files are RANKED: distinct terms matched first, then total hit count. Files matching
 *    every term (the AND case) therefore sort above partial matches automatically.
 *  - snippets are the actual MATCHING lines with their line numbers, not the file header.
 */

import { execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"

export interface SearchHit {
  /** Absolute path to the matching file. */
  file: string
  /** Distinct query terms found in this file — the primary ranking signal. */
  termsMatched: number
  /** Distinct query terms appearing in the file's own path — secondary signal. */
  pathMatches: number
  /** Total matching lines. */
  hits: number
  /** Matching lines, in file order, capped by `snippetsPerFile`. */
  snippets: Array<{ line: number; text: string }>
}

export interface SearchOptions {
  /** Roots to search. Missing roots are skipped. */
  roots: string[]
  /** Extensions to include, lowercase with dot (e.g. ['.ts', '.tsx']). Empty = all. */
  extensions?: string[]
  /** Directory names pruned everywhere. */
  excludeDirs?: string[]
  maxFiles?: number
  snippetsPerFile?: number
  /** Cap on bytes read per file by the Node fallback. */
  maxFileBytes?: number
}

const DEFAULT_EXCLUDES = [
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "playwright-report",
  "test-results",
]

/**
 * Files that are never useful as an answer: bundles, sourcemaps, lockfiles, and the
 * `*_files/` directories browsers emit on "save page as". A single minified bundle is one
 * enormous line that can match every term at once and outrank real source.
 */
const NOISE_FILE_RE = /(\.min\.(js|css)|\.bundle\.js|\.map|-lock\.(json|yaml)|\.lock)$/i
const NOISE_DIR_RE = /(^|[/\\])[^/\\]*_files([/\\]|$)/

function isNoiseFile(file: string): boolean {
  return NOISE_FILE_RE.test(file) || NOISE_DIR_RE.test(file)
}

/**
 * Longest line we will treat as a real match. Minified output is frequently a single
 * multi-hundred-KB line; counting that as one "hit" per term is meaningless.
 */
const MAX_MATCH_LINE_LENGTH = 2000

/** Terms shorter than this are dropped — they match everything and rank nothing. */
const MIN_TERM_LENGTH = 2

let ripgrepAvailable: boolean | null = null

/** Whether a real `rg` binary is callable. Cached; probes once per process. */
export function hasRipgrep(): boolean {
  if (ripgrepAvailable !== null) return ripgrepAvailable
  try {
    // execFileSync (not execSync) — no shell, so a missing binary throws ENOENT
    // instead of being swallowed by `|| true`.
    execFileSync("rg", ["--version"], { stdio: "ignore", timeout: 5_000 })
    ripgrepAvailable = true
  } catch {
    ripgrepAvailable = false
  }
  return ripgrepAvailable
}

/** Reset the cached probe. Tests only. */
export function resetRipgrepProbe(): void {
  ripgrepAvailable = null
}

export function searchAvailability(): { engine: "ripgrep" | "node"; note: string } {
  return hasRipgrep()
    ? { engine: "ripgrep", note: "" }
    : {
        engine: "node",
        note: "ripgrep not installed — using the built-in scanner (slower on large trees). Install with: brew install ripgrep",
      }
}

/**
 * Split a natural-language query into search terms.
 *
 * Quoted spans are kept together as a single phrase. Identifiers (CamelCase, snake_case,
 * kebab-case, dotted) are preferred and sorted first, because when a user names a symbol it
 * is nearly always the strongest signal available.
 */
export function extractTerms(query: string, stopWords?: ReadonlySet<string>): string[] {
  const terms: string[] = []
  const phraseRe = /"([^"]+)"|'([^']+)'/g
  let rest = query
  let m: RegExpExecArray | null
  while ((m = phraseRe.exec(query)) !== null) {
    const phrase = (m[1] ?? m[2] ?? "").trim()
    if (phrase) terms.push(phrase)
    rest = rest.replace(m[0], " ")
  }

  const words = rest
    .replace(/[^\w\s.-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w.length > MIN_TERM_LENGTH)
    .filter((w) => !/^\d+$/.test(w))
    .filter((w) => !stopWords?.has(w.toLowerCase()))

  const isIdentifier = (w: string) => /[A-Z]/.test(w) || /[-_.]/.test(w)
  const identifiers = words.filter(isIdentifier)
  const plain = words.filter((w) => !isIdentifier(w))

  for (const w of [...identifiers, ...plain]) {
    if (!terms.some((t) => t.toLowerCase() === w.toLowerCase())) terms.push(w)
  }
  return terms.slice(0, 8)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Rank by, in order:
 *  1. distinct query terms found in the file
 *  2. distinct query terms in the file's own path — `Sidebar.tsx` beats a generated schema
 *     that happens to say "sidebar" fifty times
 *  3. hit count, capped: past a handful of hits, more repetition of the same token says
 *     nothing about relevance and just favours large generated files
 *  4. shallower path, then name, for a stable order
 */
const HIT_SCORE_CAP = 8

function rankHits(hits: SearchHit[]): SearchHit[] {
  return hits.sort(
    (a, b) =>
      b.termsMatched - a.termsMatched ||
      b.pathMatches - a.pathMatches ||
      Math.min(b.hits, HIT_SCORE_CAP) - Math.min(a.hits, HIT_SCORE_CAP) ||
      a.file.split(path.sep).length - b.file.split(path.sep).length ||
      a.file.localeCompare(b.file),
  )
}

/** How many distinct terms appear in the file's path. */
function countPathMatches(file: string, terms: string[]): number {
  const lower = file.toLowerCase()
  let n = 0
  for (const t of terms) if (lower.includes(t.toLowerCase())) n += 1
  return n
}

function recordMatch(
  byFile: Map<string, { terms: Set<string>; hits: number; snippets: Array<{ line: number; text: string }> }>,
  file: string,
  line: number,
  text: string,
  terms: string[],
  snippetsPerFile: number,
): void {
  if (isNoiseFile(file)) return
  if (text.length > MAX_MATCH_LINE_LENGTH) return

  let entry = byFile.get(file)
  if (!entry) {
    entry = { terms: new Set(), hits: 0, snippets: [] }
    byFile.set(file, entry)
  }
  entry.hits += 1
  const lower = text.toLowerCase()
  for (const t of terms) {
    if (lower.includes(t.toLowerCase())) entry.terms.add(t.toLowerCase())
  }
  if (entry.snippets.length < snippetsPerFile) {
    entry.snippets.push({ line, text: text.trim().slice(0, 220) })
  }
}

function searchWithRipgrep(terms: string[], opts: Required<SearchOptions>): SearchHit[] {
  const byFile = new Map<string, { terms: Set<string>; hits: number; snippets: Array<{ line: number; text: string }> }>()

  for (const root of opts.roots) {
    if (!fs.existsSync(root)) continue

    // Args, not a shell string — a term containing a quote or `$(...)` is inert data.
    const args = ["-n", "--no-heading", "--with-filename", "-i", "--max-columns", "400"]
    for (const t of terms) args.push("-e", escapeRegExp(t))
    for (const d of opts.excludeDirs) args.push("--glob", `!**/${d}/**`)
    for (const ext of opts.extensions) args.push("--glob", `*${ext}`)
    args.push(root)

    let out = ""
    try {
      out = execFileSync("rg", args, {
        encoding: "utf-8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30_000,
      })
    } catch (err) {
      // rg exits 1 for "no matches" — that is a valid empty result, not a failure.
      const e = err as { status?: number; stdout?: string }
      if (e.status === 1) continue
      if (typeof e.stdout === "string" && e.stdout) out = e.stdout
      else continue
    }

    for (const raw of out.split("\n")) {
      if (!raw) continue
      // file:line:text — split carefully, Windows drive letters and colons in text.
      const first = raw.indexOf(":")
      if (first < 0) continue
      const second = raw.indexOf(":", first + 1)
      if (second < 0) continue
      const file = raw.slice(0, first)
      const line = Number.parseInt(raw.slice(first + 1, second), 10)
      if (!Number.isFinite(line)) continue
      recordMatch(byFile, file, line, raw.slice(second + 1), terms, opts.snippetsPerFile)
    }
  }

  return toHits(byFile, terms)
}

function* walk(dir: string, excludeDirs: Set<string>, depth = 0): Generator<string> {
  if (depth > 12) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".opencode") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name)) continue
      yield* walk(full, excludeDirs, depth + 1)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function searchWithNode(terms: string[], opts: Required<SearchOptions>): SearchHit[] {
  const byFile = new Map<string, { terms: Set<string>; hits: number; snippets: Array<{ line: number; text: string }> }>()
  const excludeDirs = new Set(opts.excludeDirs)
  const lowered = terms.map((t) => t.toLowerCase())
  const extensions = opts.extensions.map((e) => e.toLowerCase())
  const seen = new Set<string>()

  for (const root of opts.roots) {
    if (!fs.existsSync(root)) continue
    for (const file of walk(root, excludeDirs)) {
      if (seen.has(file)) continue
      seen.add(file)
      if (extensions.length > 0 && !extensions.includes(path.extname(file).toLowerCase())) continue
      if (isNoiseFile(file)) continue

      let content: string
      try {
        const stat = fs.statSync(file)
        if (stat.size > opts.maxFileBytes) continue
        content = fs.readFileSync(file, "utf-8")
      } catch {
        continue
      }
      // Cheap reject before splitting into lines.
      const lowerContent = content.toLowerCase()
      if (!lowered.some((t) => lowerContent.includes(t))) continue

      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase()
        if (lowered.some((t) => lower.includes(t))) {
          recordMatch(byFile, file, i + 1, lines[i], terms, opts.snippetsPerFile)
        }
      }
    }
  }

  return toHits(byFile, terms)
}

function toHits(
  byFile: Map<string, { terms: Set<string>; hits: number; snippets: Array<{ line: number; text: string }> }>,
  terms: string[] = [],
): SearchHit[] {
  const out: SearchHit[] = []
  for (const [file, v] of byFile) {
    out.push({
      file,
      termsMatched: v.terms.size,
      pathMatches: countPathMatches(file, terms),
      hits: v.hits,
      snippets: v.snippets,
    })
  }
  return out
}

export interface SearchResult {
  terms: string[]
  hits: SearchHit[]
  engine: "ripgrep" | "node"
  /** Files matching every term. */
  fullMatches: number
  truncated: boolean
  totalFiles: number
}

/** Run a ranked search. Never throws; an unusable query yields an empty result. */
export function searchText(query: string, options: SearchOptions, stopWords?: ReadonlySet<string>): SearchResult {
  const terms = extractTerms(query, stopWords)
  const engine: "ripgrep" | "node" = hasRipgrep() ? "ripgrep" : "node"

  if (terms.length === 0) {
    return { terms, hits: [], engine, fullMatches: 0, truncated: false, totalFiles: 0 }
  }

  const opts: Required<SearchOptions> = {
    roots: options.roots,
    extensions: options.extensions ?? [],
    excludeDirs: options.excludeDirs ?? DEFAULT_EXCLUDES,
    maxFiles: options.maxFiles ?? 12,
    snippetsPerFile: options.snippetsPerFile ?? 3,
    maxFileBytes: options.maxFileBytes ?? 1_000_000,
  }

  const all = rankHits(engine === "ripgrep" ? searchWithRipgrep(terms, opts) : searchWithNode(terms, opts))
  const fullMatches = all.filter((h) => h.termsMatched === terms.length).length

  return {
    terms,
    hits: all.slice(0, opts.maxFiles),
    engine,
    fullMatches,
    truncated: all.length > opts.maxFiles,
    totalFiles: all.length,
  }
}

/** Render a SearchResult as the plain text a tool returns to the model. */
export function formatSearchResult(result: SearchResult, opts: { relativeTo?: string; label: string }): string {
  const { note } = searchAvailability()

  if (result.terms.length === 0) {
    return `No usable search terms in that query. Give me a filename, component name, or identifier.`
  }
  if (result.hits.length === 0) {
    return [
      `No ${opts.label} matched: ${result.terms.join(", ")}`,
      note ? `(${note})` : "",
      `Searched with the ${result.engine} engine — this is a real empty result, not a failed search.`,
    ]
      .filter(Boolean)
      .join("\n")
  }

  const rel = (f: string) => (opts.relativeTo ? path.relative(opts.relativeTo, f) || f : f)
  const lines: string[] = []

  lines.push(
    `Found ${result.totalFiles} ${opts.label} for: ${result.terms.join(", ")}` +
      (result.fullMatches > 0 ? ` — ${result.fullMatches} match every term` : " — none match every term, showing best partial matches") +
      (result.truncated ? ` (showing top ${result.hits.length})` : ""),
  )
  if (note) lines.push(`(${note})`)
  lines.push("")

  for (const h of result.hits) {
    lines.push(`${rel(h.file)}  [${h.termsMatched}/${result.terms.length} terms · ${h.hits} hit${h.hits === 1 ? "" : "s"}]`)
    for (const s of h.snippets) lines.push(`    ${s.line}: ${s.text}`)
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}
