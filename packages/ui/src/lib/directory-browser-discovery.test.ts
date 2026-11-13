import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { FileSystemEntry } from "@codenomad/api-types"
import { formatFileSize, formatModifiedAt, isOverAttachLimit, sortDirectoryEntries } from "./directory-browser-discovery"

const file = (name: string, size?: number, modifiedAt?: string): FileSystemEntry => ({ name, path: name, type: "file", size, modifiedAt })
const folder = (name: string, modifiedAt?: string): FileSystemEntry => ({ name, path: name, type: "directory", modifiedAt })

describe("sortDirectoryEntries", () => {
  const entries = [
    file("b.txt", 10, "2026-01-02T00:00:00Z"),
    folder("zeta", "2026-03-01T00:00:00Z"),
    file("a.txt", 500, "2026-01-05T00:00:00Z"),
    file("c.txt", undefined, undefined),
    folder("alpha", "2026-01-01T00:00:00Z"),
  ]
  const names = (mode: Parameters<typeof sortDirectoryEntries>[1]) => sortDirectoryEntries(entries, mode).map((e) => e.name)

  it("by name: folders first, then A to Z", () => {
    assert.deepEqual(names("name"), ["alpha", "zeta", "a.txt", "b.txt", "c.txt"])
  })
  it("by modified date: folders first, newest first, unknown dates last", () => {
    assert.deepEqual(names("modified"), ["zeta", "alpha", "a.txt", "b.txt", "c.txt"])
  })
  it("by size: folders first, largest first, unknown sizes last", () => {
    assert.deepEqual(names("size"), ["alpha", "zeta", "a.txt", "b.txt", "c.txt"])
  })
  it("does not change the list it is given", () => {
    const before = entries.map((e) => e.name)
    sortDirectoryEntries(entries, "size")
    assert.deepEqual(entries.map((e) => e.name), before)
  })
})

describe("labels", () => {
  it("formats sizes", () => {
    assert.equal(formatFileSize(912), "912 B")
    assert.equal(formatFileSize(1536), "1.5 KB")
    assert.equal(formatFileSize(5 * 1024 * 1024), "5.0 MB")
    assert.equal(formatFileSize(undefined), "")
  })
  it("formats a date, and nothing for a missing or broken one", () => {
    assert.ok(formatModifiedAt("2026-01-05T10:30:00Z", "en-US").includes("2026"))
    assert.equal(formatModifiedAt(undefined), "")
    assert.equal(formatModifiedAt("not a date"), "")
  })
  it("knows a file over the attach limit", () => {
    assert.equal(isOverAttachLimit(file("big", 6_000_000), 5 * 1024 * 1024), true)
    assert.equal(isOverAttachLimit(file("small", 100), 5 * 1024 * 1024), false)
    assert.equal(isOverAttachLimit(file("unknown"), 5 * 1024 * 1024), false)
    assert.equal(isOverAttachLimit(file("big", 6_000_000), undefined), false)
  })
})
