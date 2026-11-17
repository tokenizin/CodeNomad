/**
 * The folder a scope's runner works in (docs/core/workflow-scope-contract.md in the StarWorld repository, §5 rule 4).
 *
 * A scope of a scope contract may work in a git worktree of its own, so that several implementation workflows can run at
 * once. The Rust agent checks the workspace when the Product Manager starts the workflow; the host checks it again before
 * every run, because a run can be a follow-up sent long after the start, and the folder may be gone or changed by then.
 * Worktrees are created and removed by a person (decision D1): this only looks, it never creates anything.
 *
 * A workspace is trusted only if it is a worktree of the manager's own repository. That is what keeps a task file, which a
 * model can write, from pointing a runner at an arbitrary folder.
 */

import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"

function real(folder: string): string {
  try {
    return fs.realpathSync(folder)
  } catch {
    return path.resolve(folder)
  }
}

/** The worktrees of the repository `folder` is in, as real paths. Throws when git cannot say. */
export function gitWorktrees(folder: string): string[] {
  const out = execFileSync("git", ["-C", folder, "worktree", "list", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 })
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => real(line.slice("worktree ".length).trim()))
}

/**
 * Why `workspace` cannot be the working folder of a scope started by a manager working in `folder`, or null when it can:
 * an absolute path to an existing folder that is a git worktree of the manager's repository and is not the manager's own.
 */
export function workspaceProblem(folder: string, workspace: string): string | null {
  if (!path.isAbsolute(workspace)) return "it is not an absolute path"
  let target: string
  try {
    target = fs.realpathSync(workspace)
  } catch {
    return "it does not exist"
  }
  if (!fs.statSync(target).isDirectory()) return "it is not a folder"
  const root = real(folder)
  if (target === root) return "it is the manager's own worktree; a scope that works there has the workspace `shared`"
  let known: string[]
  try {
    known = gitWorktrees(root)
  } catch (error) {
    const why = error instanceof Error ? error.message.split("\n")[0] : String(error)
    return `git could not list the worktrees of ${root}: ${why}`
  }
  return known.includes(target) ? null : `it is not a git worktree of ${root}`
}
