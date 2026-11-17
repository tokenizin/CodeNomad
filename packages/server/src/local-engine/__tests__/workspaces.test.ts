import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { gitWorktrees, workspaceProblem } from "../workspaces.js"

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-C", cwd, ...args], { stdio: "pipe" })

describe("the workspace of a scope", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-workspace-")))
  const folder = path.join(root, "work")
  const api = path.join(root, "work-api")
  fs.mkdirSync(folder)
  git(folder, "init", "-q")
  fs.writeFileSync(path.join(folder, "README.md"), "# work\n")
  git(folder, "add", ".")
  git(folder, "commit", "-q", "-m", "init")
  git(folder, "worktree", "add", "-q", api, "-b", "api")

  test("the worktrees of the repository are listed as real paths", () => {
    expect(gitWorktrees(folder).sort()).toEqual([folder, api].sort())
  })

  test("a worktree of the manager's repository can be a workspace, however it is spelled", () => {
    expect(workspaceProblem(folder, api)).toBeNull()
    expect(workspaceProblem(folder, `${api}/../work-api`)).toBeNull()
    const link = path.join(root, "link-to-api")
    fs.symlinkSync(api, link)
    expect(workspaceProblem(folder, link)).toBeNull() // the real folder is what counts
  })

  test("anything else says what is wrong", () => {
    expect(workspaceProblem(folder, "relative/dir")).toBe("it is not an absolute path")
    expect(workspaceProblem(folder, path.join(root, "nope"))).toBe("it does not exist")
    const file = path.join(root, "a-file")
    fs.writeFileSync(file, "x")
    expect(workspaceProblem(folder, file)).toBe("it is not a folder")
    expect(workspaceProblem(folder, folder)).toContain("it is the manager's own worktree")
    expect(workspaceProblem(folder, path.join(folder, "."))).toContain("it is the manager's own worktree")
    const stranger = fs.mkdtempSync(path.join(root, "stranger-"))
    expect(workspaceProblem(folder, stranger)).toBe(`it is not a git worktree of ${folder}`)
    // A folder that is a repository of its own is not a worktree of this one.
    git(stranger, "init", "-q")
    expect(workspaceProblem(folder, stranger)).toBe(`it is not a git worktree of ${folder}`)
  })

  test("when the manager's folder is not a repository, git's own words are given", () => {
    const loose = fs.mkdtempSync(path.join(root, "loose-"))
    const target = fs.mkdtempSync(path.join(root, "target-"))
    expect(workspaceProblem(loose, target)).toMatch(/^git could not list the worktrees of .+: /)
  })
})
