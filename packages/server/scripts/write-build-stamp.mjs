#!/usr/bin/env node
// Write packages/server/build-stamp.json: which CodeNomad commit this build came from and when.
//
// Every instance (Tokenizin, Prestix, per-user copies) reads the file once at startup and reports it on the
// loopback-only GET /api/build-stamp. The deploy scripts compare a running instance with the stamp of the build
// they just made, so an instance that missed the sync or failed to restart is reported as stale instead of looking
// healthy. `dirty` means tracked files had uncommitted changes (untracked build output is ignored on purpose).
//
// A per-user copy has no .git: there the existing stamp (copied from the source) is kept untouched.
//
// Usage: node write-build-stamp.mjs [--root <git checkout>] [--out <file>]
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const args = { root: path.resolve(here, "../../.."), out: path.resolve(here, "../build-stamp.json") }
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if ((key !== "--root" && key !== "--out") || process.argv[i + 1] === undefined) {
    console.error("Usage: write-build-stamp.mjs [--root <git checkout>] [--out <file>]")
    process.exit(1)
  }
  args[key.slice(2)] = path.resolve(process.argv[i + 1])
}

function git(...gitArgs) {
  return execFileSync("git", ["-C", args.root, ...gitArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

let stamp
try {
  const id = git("rev-parse", "HEAD")
  let branch = ""
  try {
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
  } catch {
    /* detached or unborn */
  }
  const dirty = git("status", "--porcelain", "--untracked-files=no").length > 0
  stamp = { id, short: id.slice(0, 8), branch: branch === "HEAD" ? "" : branch, dirty, builtAt: new Date().toISOString() }
} catch {
  if (fs.existsSync(args.out)) {
    console.log(`[build-stamp] no git checkout at ${args.root}; keeping existing ${args.out}`)
    process.exit(0)
  }
  stamp = { id: "unknown", short: "unknown", branch: "", dirty: false, builtAt: new Date().toISOString() }
}

fs.writeFileSync(args.out, `${JSON.stringify(stamp, null, 2)}\n`)
console.log(`[build-stamp] ${stamp.short}${stamp.dirty ? " (uncommitted changes)" : ""} built ${stamp.builtAt} -> ${args.out}`)
