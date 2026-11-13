import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { FileSystemBrowser, MAX_READABLE_FILE_BYTES } from "../browser"
import { runContentSearchProcess, scoreFileName, searchFileContents, searchFileNames } from "../discovery"

const tempRoots: string[] = []

function createTempRoot(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-discovery-")))
  tempRoots.push(directory)
  return directory
}

function write(root: string, relativePath: string, contents = "x") {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}

describe("attach-dialog discovery", () => {
  afterEach(() => {
    for (const directory of tempRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  })

  it("finds a file by name in a nested folder and says which folder it is in", async () => {
    const root = createTempRoot()
    write(root, "docs/guides/invoice-template.md")
    write(root, "src/invoice.ts")
    write(root, "src/other.ts")
    const result = await searchFileNames(new FileSystemBrowser({ rootDir: root }), "invoice")

    assert.deepEqual(result.entries.map((entry) => entry.path), ["src/invoice.ts", "docs/guides/invoice-template.md"])
    assert.equal(result.entries[0].crumbPath, "src")
    assert.equal(result.entries[1].crumbPath, "docs/guides")
    assert.equal(result.entries[0].absolutePath, path.join(root, "src/invoice.ts"))
    assert.equal(typeof result.entries[0].size, "number")
    assert.equal(result.truncated, false)
  })

  it("needs every word, and searches only below the folder it is given", async () => {
    const root = createTempRoot()
    write(root, "a/report-2026.pdf")
    write(root, "a/report-2025.pdf")
    write(root, "b/report-2026.txt")
    const browser = new FileSystemBrowser({ rootDir: root })

    const both = await searchFileNames(browser, "report 2026")
    assert.deepEqual(both.entries.map((entry) => entry.path).sort(), ["a/report-2026.pdf", "b/report-2026.txt"])

    const scoped = await searchFileNames(browser, "report 2026", { path: "a" })
    assert.deepEqual(scoped.entries.map((entry) => entry.path), ["a/report-2026.pdf"])
    assert.equal(scoped.entries[0].crumbPath, "")
  })

  it("respects the depth and the limit, and reports that it cut the list", async () => {
    const root = createTempRoot()
    write(root, "note.txt")
    write(root, "one/note.txt")
    write(root, "one/two/note.txt")
    const browser = new FileSystemBrowser({ rootDir: root })

    assert.deepEqual((await searchFileNames(browser, "note", { depth: 0 })).entries.map((e) => e.path), ["note.txt"])
    assert.equal((await searchFileNames(browser, "note", { depth: 1 })).entries.length, 2)
    const limited = await searchFileNames(browser, "note", { limit: 2 })
    assert.equal(limited.entries.length, 2)
    assert.equal(limited.truncated, true)
  })

  it("skips vendored folders and never follows a link out of the root", async () => {
    const root = createTempRoot()
    const outside = createTempRoot()
    write(outside, "secret-plan.txt")
    write(root, "node_modules/pkg/secret-plan.txt")
    write(root, "kept/secret-plan.txt")
    fs.symlinkSync(outside, path.join(root, "link-out"), "dir")
    fs.symlinkSync(path.join(outside, "secret-plan.txt"), path.join(root, "linked-file.txt"))

    const result = await searchFileNames(new FileSystemBrowser({ rootDir: root }), "secret")
    assert.deepEqual(result.entries.map((entry) => entry.path), ["kept/secret-plan.txt"])
  })

  it("refuses to search outside the root, also when the root is unrestricted", async () => {
    const root = createTempRoot()
    const outside = createTempRoot()
    write(outside, "a.txt")
    await assert.rejects(searchFileNames(new FileSystemBrowser({ rootDir: root }), "a", { path: "../" }), /outside of root|workspace root/)
    await assert.rejects(searchFileNames(new FileSystemBrowser({ rootDir: root }), "a", { path: outside }), /outside of root|workspace root/)
    await assert.rejects(
      searchFileNames(new FileSystemBrowser({ rootDir: root, unrestricted: true }), "a", { path: outside }),
      /workspace root/,
    )
    // Inside the root an unrestricted server answers with absolute paths, like its listings do.
    write(root, "in/a.txt")
    const inside = await searchFileNames(new FileSystemBrowser({ rootDir: root, unrestricted: true }), "a.txt", { path: path.join(root, "in") })
    assert.deepEqual(inside.entries.map((entry) => entry.path), [path.join(root, "in/a.txt")])
  })

  it("rejects an empty or oversized query", async () => {
    const browser = new FileSystemBrowser({ rootDir: createTempRoot() })
    await assert.rejects(searchFileNames(browser, "   "), /required/)
    await assert.rejects(searchFileNames(browser, "x".repeat(201)), /too long/)
  })

  it("ranks a match in the file name above one in a folder name", () => {
    assert.equal(scoreFileName(["budget"], "notes.md", "docs/readme.md"), 0)
    assert.ok(scoreFileName(["budget"], "budget.xlsx", "finance/budget.xlsx") > scoreFileName(["budget"], "notes.md", "budget/notes.md"))
  })

  it("finds files by their content, with the matching lines, through the real child process", async () => {
    const root = createTempRoot()
    write(root, "docs/pricing.md", "# Pricing\nThe enterprise tier includes pineapple support.\n")
    write(root, "src/unrelated.ts", "export const nothing = 1\n")
    const result = await searchFileContents(new FileSystemBrowser({ rootDir: root }), "pineapple")

    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0].entry.path, "docs/pricing.md")
    assert.equal(result.hits[0].entry.crumbPath, "docs")
    assert.equal(result.hits[0].snippets[0].line, 2)
    assert.match(result.hits[0].snippets[0].text, /pineapple/)
    assert.deepEqual(result.terms, ["pineapple"])
    assert.ok(result.engine === "ripgrep" || result.engine === "node")
  })

  it("leaves out content hits that are over the attach limit or outside the root", async () => {
    const root = createTempRoot()
    const outside = createTempRoot()
    write(root, "small.txt", "needle")
    write(root, "huge.txt", "needle")
    fs.truncateSync(path.join(root, "huge.txt"), MAX_READABLE_FILE_BYTES + 1)
    write(outside, "elsewhere.txt", "needle")
    const fake = async () => ({
      terms: ["needle"],
      engine: "node" as const,
      fullMatches: 3,
      truncated: false,
      totalFiles: 3,
      hits: ["small.txt", "huge.txt"].map((name) => ({ file: path.join(root, name), termsMatched: 1, pathMatches: 0, hits: 1, snippets: [{ line: 1, text: "needle" }] }))
        .concat([{ file: path.join(outside, "elsewhere.txt"), termsMatched: 1, pathMatches: 0, hits: 1, snippets: [{ line: 1, text: "needle" }] }]),
    })
    const result = await searchFileContents(new FileSystemBrowser({ rootDir: root }), "needle", { runSearch: fake })

    assert.deepEqual(result.hits.map((hit) => hit.entry.path), ["small.txt"])
    assert.equal(result.skippedTooLarge, 1)
  })

  it("stops the child process when the search is cancelled", async () => {
    const root = createTempRoot()
    write(root, "a.txt", "needle")
    const controller = new AbortController()
    const pending = runContentSearchProcess({ query: "needle", root, maxFiles: 5, snippetsPerFile: 1 }, controller.signal)
    controller.abort()
    await assert.rejects(pending, /cancelled/)
  })
})
