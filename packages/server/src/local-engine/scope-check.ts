/**
 * The acceptance check for a scope of a scope contract (docs/core/workflow-scope-contract.md in the StarWorld repository, §7).
 *
 * A scope's lease says which paths its runner may write (`paths` in the scope contract's normalized copy). Nothing can stop a
 * shell command writing elsewhere while the runner works (the agent only sees its own `Write` tool), so the check is made when
 * the run is over: the files the scope's workspace has changed since the run started are compared with the lease, and the manager
 * is told, in the notification it evaluates the handover from, about any outside it. A clean scope adds nothing to the notification.
 *
 * The scope's own task file and the handover it filed are always allowed: the runner has to write them.
 * Only a scope with a workspace of its own can be checked: in the manager's shared worktree its changes cannot be told from other work.
 */

import { execFile } from "child_process"
import fs from "fs"
import path from "path"
import picomatch from "picomatch"
import { promisify } from "util"

const git = promisify(execFile)

/** Reads of the normalized copy and git are bounded: a check must not hold up a notification for long. */
const GIT_TIMEOUT_MS = 30_000
const LISTED = 20

export type ScopeRecord = { scopeId: string; track: string; taskPath: string; workspace: string | null; paths: string[] }

/** Whether `file` (a path relative to the repository root) is covered by `pattern`, with the lease guard's semantics (`src/lib/workflow/path-glob.vectors.json` in the StarWorld repository is the shared table of cases). */
export function matchesPattern(pattern: string, file: string): boolean {
  const strip = (p: string) => (p.startsWith("/") ? p.slice(1) : p)
  return picomatch.isMatch(strip(file), strip(pattern), { dot: true })
}

/** One scope from the contract's normalized copy, `<manager folder>/.codenomad/runtime/scope-contracts/<contract>.json`. */
export function readScope(managerFolder: string, contract: string, scopeId: string): { scope: ScopeRecord } | { error: string } {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(contract) || contract.includes("..")) return { error: `\`${contract}\` is not a contract id` }
  const file = path.join(managerFolder, ".codenomad", "runtime", "scope-contracts", `${contract}.json`)
  let doc: any
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return { error: `the contract's normalized copy (${path.relative(managerFolder, file)}) cannot be read; run \`bun run scope:check\`` }
  }
  const raw = Array.isArray(doc?.scopes) ? doc.scopes.find((s: any) => s?.scope_id === scopeId) : undefined
  if (!raw) return { error: `scope \`${scopeId}\` is not in the contract's normalized copy` }
  const paths: string[] = Array.isArray(raw.paths) ? raw.paths.filter((p: unknown) => typeof p === "string") : []
  if (paths.length === 0) return { error: `scope \`${scopeId}\` has no lease paths in the contract's normalized copy; run \`bun run scope:check\`` }
  return {
    scope: {
      scopeId,
      track: String(raw.track ?? ""),
      taskPath: String(raw.task_path ?? ""),
      workspace: raw.workspace && raw.workspace !== "shared" ? String(raw.workspace) : null,
      paths,
    },
  }
}

/** The commit a workspace is at now. */
export async function headCommit(workspace: string): Promise<string> {
  const { stdout } = await git("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS })
  return stdout.trim()
}

/**
 * Every file the workspace has changed since `base`, as paths relative to its root: tracked files that differ from `base` (committed
 * since, staged or not; renames count as a delete and an add) and untracked files that are not ignored. Sorted.
 */
export async function changedFiles(workspace: string, base: string): Promise<string[]> {
  const opts = { encoding: "utf8" as const, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }
  const [tracked, untracked] = await Promise.all([
    git("git", ["-C", workspace, "diff", "--name-only", "--no-renames", "-z", base], opts),
    git("git", ["-C", workspace, "ls-files", "--others", "--exclude-standard", "-z"], opts),
  ])
  const names = `${tracked.stdout}\0${untracked.stdout}`.split("\0").filter(Boolean)
  return [...new Set(names)].sort()
}

export type ScopeCheckInput = {
  managerFolder: string
  /** Where the runner worked; none for a scope in the manager's shared worktree. */
  workspace?: string
  contract: string
  scopeId: string
  /** The commit the workspace was at when the scope started. */
  baseRef?: string
  /** The handover the runner filed in this run (relative to its workspace), which it may always write. */
  handoverPath?: string
}

/** What the manager's notification says about the files a scope changed outside its lease; null when there is nothing to say. */
export async function scopeCheckText(input: ScopeCheckInput): Promise<string | null> {
  const prefix = `SCOPE CHECK (scope \`${input.scopeId}\` of contract ${input.contract})`
  const read = readScope(input.managerFolder, input.contract, input.scopeId)
  if ("error" in read) return `${prefix}: could not be made: ${read.error}.`
  const { scope } = read
  if (scope.workspace === null) {
    return scope.track === "implementation"
      ? `${prefix}: not made: the scope works in the manager's shared worktree, where its changes cannot be told from other work.`
      : null
  }
  if (!input.workspace) return `${prefix}: could not be made: the contract gives the scope a workspace of its own, but its runner had none.`
  if (!input.baseRef) return `${prefix}: could not be made: the commit its workspace started from was not recorded.`
  let changed: string[]
  try {
    changed = await changedFiles(input.workspace, input.baseRef)
  } catch (error) {
    const why = error instanceof Error ? error.message.split("\n")[0] : String(error)
    return `${prefix}: could not be made: git failed in ${input.workspace} (${why}).`
  }
  const allowed = [...scope.paths, scope.taskPath, input.handoverPath ?? ""].filter(Boolean)
  const outside = changed.filter((file) => !allowed.some((pattern) => matchesPattern(pattern, file)))
  if (outside.length === 0) return null
  const shown = outside.slice(0, LISTED).map((file) => `  - ${file}`)
  if (outside.length > LISTED) shown.push(`  … and ${outside.length - LISTED} more`)
  return [
    `${prefix}: ${outside.length} file(s) changed in ${input.workspace} are outside its lease (${scope.paths.join(", ")}):`,
    ...shown,
    "Another scope's files go through a forward request, not a direct change. Send the workflow back to undo them, or ask the owner of those files to take them over.",
  ].join("\n")
}
