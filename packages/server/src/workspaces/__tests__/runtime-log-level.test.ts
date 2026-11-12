import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { WorkspaceRuntime, logLevelRetry } from "../runtime"

const quietLogger: any = {
  info() {}, debug() {}, trace() {}, warn() {}, error() {}, isLevelEnabled: () => false, child() { return quietLogger },
}
const fakeBus: any = { publish() {} }

/** A stand-in for an OpenCode build that wants a lower-case level: it refuses "DEBUG" like the Effect CLI does, accepts "debug". */
function fakeOpencode(dir: string, wants: "lower" | "upper" | "none"): string {
  const bin = join(dir, `fake-opencode-${wants}`)
  const argsFile = join(dir, `args-${wants}.txt`)
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
require("fs").appendFileSync(${JSON.stringify(argsFile)}, args.join(" ") + "\\n")
const level = args[args.indexOf("--log-level") + 1]
const wants = ${JSON.stringify(wants)}
const ok = wants === "lower" ? level === level.toLowerCase() : wants === "upper" ? level === level.toUpperCase() : false
if (!ok) {
  console.error('Invalid value for flag --log-level: "' + level + '". Expected: "all", "trace", "debug", "info", "warning", "error", "fatal", "none"')
  process.exit(1)
}
console.log("opencode server listening on http://127.0.0.1:4096")
setInterval(() => {}, 1000)
`,
  )
  chmodSync(bin, 0o755)
  return bin
}

describe("logLevelRetry", () => {
  const refusal = new Error('Error Stream\n~effect/cli/CliError/InvalidValue: Invalid value for flag --log-level: "DEBUG". Expected: "all"')

  it("asks for the lower-case spelling after that refusal", () => {
    assert.equal(logLevelRetry(refusal, { logLevel: "DEBUG" }), "debug")
    assert.equal(logLevelRetry(refusal, {}), "debug", "no level given: the default")
    assert.equal(logLevelRetry(refusal, { logLevel: "Warn" }), "warn")
  })

  it("does not retry another failure, or a retry that failed again", () => {
    assert.equal(logLevelRetry(new Error("Process exited with code 1"), { logLevel: "DEBUG" }), null)
    assert.equal(logLevelRetry(new Error("spawn opencode ENOENT"), {}), null)
    assert.equal(logLevelRetry(refusal, { logLevel: "debug", exactLogLevel: true }), null)
  })
})

describe("WorkspaceRuntime.launch", () => {
  const run = async (wants: "lower" | "upper" | "none") => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-log-level-"))
    const binaryPath = fakeOpencode(dir, wants)
    const runtime = new WorkspaceRuntime(fakeBus, quietLogger)
    const attempt = runtime.launch({ workspaceId: `w-${wants}`, folder: dir, binaryPath, logLevel: "DEBUG" })
    const calls = () => readFileSync(join(dir, `args-${wants}.txt`), "utf8").trim().split("\n")
    return { runtime, attempt, calls, id: `w-${wants}` }
  }

  it("starts an OpenCode that wants lower case by retrying once with it", async () => {
    const { runtime, attempt, calls, id } = await run("lower")
    const started = await attempt
    try {
      assert.equal(started.port, 4096)
      const lines = calls()
      assert.equal(lines.length, 2, "one refused try, one retry")
      assert.ok(lines[0].includes("--log-level DEBUG"))
      assert.ok(lines[1].includes("--log-level debug"))
    } finally {
      await runtime.stop(id)
    }
  })

  it("starts an OpenCode that wants upper case on the first try", async () => {
    const { runtime, attempt, calls, id } = await run("upper")
    const started = await attempt
    try {
      assert.equal(started.port, 4096)
      assert.equal(calls().length, 1, "no retry when the first try works")
    } finally {
      await runtime.stop(id)
    }
  })

  it("gives up after one retry when neither spelling is accepted", async () => {
    const { attempt, calls } = await run("none")
    await assert.rejects(attempt, /Invalid value for flag --log-level/)
    assert.equal(calls().length, 2, "exactly one retry, no loop")
  })
})
