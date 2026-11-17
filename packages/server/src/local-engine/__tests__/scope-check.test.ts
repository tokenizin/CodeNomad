import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { changedFiles, headCommit, matchesPattern, readScope, scopeCheckText } from "../scope-check.js"

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-C", cwd, ...args], { stdio: "pipe" })
const vectors = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", "path-glob.vectors.json"), "utf8")) as { match: Array<[string, string, boolean]> }

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-check-")))
  git(dir, "init", "-q")
  fs.mkdirSync(path.join(dir, "src"))
  fs.writeFileSync(path.join(dir, "src", "keep.ts"), "keep")
  fs.writeFileSync(path.join(dir, "src", "old name.ts"), "to rename")
  fs.writeFileSync(path.join(dir, "gone.txt"), "to delete")
  git(dir, "add", ".")
  git(dir, "commit", "-q", "-m", "init")
  return { dir, base: execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() }
}

describe("the glob matcher", () => {
  // The lease guard's own cases (src/lib/workflow/path-glob.vectors.json in the StarWorld repository): the acceptance check has to agree
  // with the lease guard about what a lease path covers, or a scope could pass one and fail the other.
  test.each(vectors.match)("%j matches %j: %p", (pattern, file, expected) => {
    expect(matchesPattern(pattern, file)).toBe(expected)
  })
})

describe("what a workspace has changed since a commit", () => {
  test("tracked changes (staged or not, committed since or not), deletions, renames as both names, and untracked files; not ignored ones; sorted", async () => {
    const { dir, base } = repo()
    fs.writeFileSync(path.join(dir, ".gitignore"), "*.log\n")
    fs.writeFileSync(path.join(dir, "src", "keep.ts"), "changed, unstaged")
    fs.writeFileSync(path.join(dir, "added.ts"), "new, staged")
    git(dir, "add", "added.ts")
    fs.writeFileSync(path.join(dir, "committed.ts"), "new, committed")
    git(dir, "add", "committed.ts")
    git(dir, "commit", "-q", "-m", "later")
    git(dir, "mv", "src/old name.ts", "src/new name.ts")
    fs.rmSync(path.join(dir, "gone.txt"))
    fs.writeFileSync(path.join(dir, "untracked ünïcode.md"), "x")
    fs.writeFileSync(path.join(dir, "debug.log"), "ignored")
    expect(await changedFiles(dir, base)).toEqual([".gitignore", "added.ts", "committed.ts", "gone.txt", "src/keep.ts", "src/new name.ts", "src/old name.ts", "untracked ünïcode.md"])
    expect(await changedFiles(dir, await headCommit(dir))).toContain("src/new name.ts")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("nothing changed is an empty list, and a commit that does not exist is an error", async () => {
    const { dir, base } = repo()
    expect(await changedFiles(dir, base)).toEqual([])
    await expect(changedFiles(dir, "0".repeat(40))).rejects.toThrow()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("the scope in the contract's normalized copy", () => {
  function copy(scopes: unknown[]) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "scope-copy-"))
    const dir = path.join(folder, ".codenomad", "runtime", "scope-contracts")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "TASK-P.json"), JSON.stringify({ scope_contract_version: 1, parent_task: "TASK-P", scopes }))
    return folder
  }

  test("a scope is read with its lease paths and workspace (`shared` as none)", () => {
    const folder = copy([
      { scope_id: "api", track: "implementation", task_path: "t/api.md", workspace: "/w/api", paths: ["src/api/**"] },
      { scope_id: "ui", track: "spec", task_path: "t/ui.md", workspace: "shared", paths: ["src/ui/**", "docs/ui.md"] },
    ])
    expect(readScope(folder, "TASK-P", "api")).toEqual({ scope: { scopeId: "api", track: "implementation", taskPath: "t/api.md", workspace: "/w/api", paths: ["src/api/**"] } })
    expect(readScope(folder, "TASK-P", "ui")).toMatchObject({ scope: { workspace: null, paths: ["src/ui/**", "docs/ui.md"] } })
  })

  test("a missing copy, an unknown scope, a scope with no paths and an unsafe contract id each say what is wrong", () => {
    const folder = copy([{ scope_id: "bare", track: "spec", task_path: "t", workspace: "shared" }])
    expect(readScope(folder, "TASK-NONE", "api")).toMatchObject({ error: expect.stringContaining("bun run scope:check") })
    expect(readScope(folder, "TASK-P", "nope")).toMatchObject({ error: "scope `nope` is not in the contract's normalized copy" })
    expect(readScope(folder, "TASK-P", "bare")).toMatchObject({ error: expect.stringContaining("has no lease paths") })
    expect(readScope(folder, "../escape", "api")).toMatchObject({ error: expect.stringContaining("is not a contract id") })
  })

  test("a long list of files is cut, and says how many more there were", async () => {
    const { dir, base } = repo()
    for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(dir, `stray-${String(i).padStart(2, "0")}.ts`), "x")
    const folder = copy([{ scope_id: "api", track: "implementation", task_path: "t/api.md", workspace: dir, paths: ["src/api/**"] }])
    const text = (await scopeCheckText({ managerFolder: folder, workspace: dir, contract: "TASK-P", scopeId: "api", baseRef: base }))!
    expect(text).toContain("25 file(s) changed in")
    expect(text.split("\n").filter((l) => l.startsWith("  - "))).toHaveLength(20)
    expect(text).toContain("  … and 5 more")
    expect(text).toContain("forward request")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("git failing in the workspace is reported, not thrown", async () => {
    const { dir } = repo()
    const folder = copy([{ scope_id: "api", track: "implementation", task_path: "t/api.md", workspace: dir, paths: ["src/api/**"] }])
    const text = await scopeCheckText({ managerFolder: folder, workspace: dir, contract: "TASK-P", scopeId: "api", baseRef: "0".repeat(40) })
    expect(text).toContain("could not be made: git failed in")
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
