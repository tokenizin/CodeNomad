/**
 * Command Recognizer — Unit Tests
 *
 * Tests the three-tier fuzzy matching pipeline (exact → keyword overlap → edit distance)
 * across all 14 commands in VENUE_STAFF, CONCIERGE, and ADMIN sets.
 *
 * Acceptance Criteria:
 *   AC-S6-1: All 14 commands match with correct confidence
 */

import { describe, test, expect } from "bun:test"
import {
  CommandRecognizer,
  VENUE_STAFF_COMMANDS,
  CONCIERGE_COMMANDS,
  ADMIN_COMMANDS,
  ALL_COMMANDS,
  type CommandDef,
} from "../command-recognizer"

// ── Helper ──────────────────────────────────────────────────────

function createRecognizer(commands: CommandDef[] = ALL_COMMANDS) {
  return new CommandRecognizer(commands)
}

// ── Venue Staff Commands (AC-S6-1) ─────────────────────────────

describe("VENUE_STAFF_COMMANDS — exact match (confidence 1.0)", () => {
  const r = createRecognizer(VENUE_STAFF_COMMANDS)

  test("scan_member — exact phrase", () => {
    const m = r.match("scan member")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("scan_member")
    expect(m!.confidence).toBe(1.0)
    expect(m!.action).toBe("POST /api/staff/bar/scan")
  })

  test("scan_member — alternative phrase 'scan qr'", () => {
    const m = r.match("scan qr")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("scan_member")
    expect(m!.confidence).toBe(1.0)
  })

  test("pour_drink — exact phrase", () => {
    const m = r.match("pour drink")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("pour_drink")
    expect(m!.confidence).toBe(1.0)
    expect(m!.action).toBe("POST /api/staff/bar/redeem")
  })

  test("pour_drink — alternative phrase 'redeem drink'", () => {
    const m = r.match("redeem drink")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("pour_drink")
    expect(m!.confidence).toBe(1.0)
  })

  test("check_balance — exact phrase", () => {
    const m = r.match("check balance")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("check_balance")
    expect(m!.confidence).toBe(1.0)
  })

  test("check_balance — 'how many points'", () => {
    const m = r.match("how many points")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("check_balance")
    expect(m!.confidence).toBe(1.0)
  })

  test("fulfill_order — exact phrase", () => {
    const m = r.match("fulfill order")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("fulfill_order")
    expect(m!.confidence).toBe(1.0)
  })

  test("door_entry — exact phrase", () => {
    const m = r.match("door entry")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("door_entry")
    expect(m!.confidence).toBe(1.0)
  })

  test("door_entry — 'admit'", () => {
    const m = r.match("admit")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("door_entry")
    expect(m!.confidence).toBe(1.0)
  })

  test("show_menu — exact phrase", () => {
    const m = r.match("show menu")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("show_menu")
    expect(m!.confidence).toBe(1.0)
  })

  test("show_menu — 'what drinks'", () => {
    const m = r.match("what drinks")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("show_menu")
    expect(m!.confidence).toBe(1.0)
  })
})

// ── Concierge Commands ─────────────────────────────────────────

describe("CONCIERGE_COMMANDS — exact match", () => {
  const r = createRecognizer(CONCIERGE_COMMANDS)

  test("deploy — 'ship it'", () => {
    const m = r.match("ship it")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("deploy")
    expect(m!.confidence).toBe(1.0)
  })

  test("deploy — 'push to production'", () => {
    const m = r.match("push to production")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("deploy")
    expect(m!.confidence).toBe(1.0)
  })

  test("run_tests — 'run tests'", () => {
    const m = r.match("run tests")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("run_tests")
    expect(m!.confidence).toBe(1.0)
  })

  test("git_status — 'what changed'", () => {
    const m = r.match("what changed")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("git_status")
    expect(m!.confidence).toBe(1.0)
  })

  test("commit — 'save changes'", () => {
    const m = r.match("save changes")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("commit")
    expect(m!.confidence).toBe(1.0)
  })

  test("check_deploy — 'is it live'", () => {
    const m = r.match("is it live")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("check_deploy")
    expect(m!.confidence).toBe(1.0)
  })
})

// ── Admin Commands ─────────────────────────────────────────────

describe("ADMIN_COMMANDS — exact match", () => {
  const r = createRecognizer(ADMIN_COMMANDS)

  test("approve — exact", () => {
    const m = r.match("approve")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("approve")
    expect(m!.confidence).toBe(1.0)
  })

  test("reject — exact", () => {
    const m = r.match("reject")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("reject")
    expect(m!.confidence).toBe(1.0)
  })

  test("escalate — exact", () => {
    const m = r.match("escalate")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("escalate")
    expect(m!.confidence).toBe(1.0)
  })
})

// ── Fuzzy Match — Typo / Mis-transcription (AC-S6-1) ──────────

describe("fuzzy match — edit distance catches typos", () => {
  const r = createRecognizer(ALL_COMMANDS)

  test("'scn member' matches scan_member (typo in 'scan')", () => {
    const m = r.match("scn member")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("scan_member")
    expect(m!.confidence).toBeGreaterThan(0.7)
  })

  test("'pur drink' matches pour_drink (missing 'o')", () => {
    const m = r.match("pur drink")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("pour_drink")
    expect(m!.confidence).toBeGreaterThan(0.7)
  })

  test("'deplo' matches deploy (truncated)", () => {
    const m = r.match("deplo")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("deploy")
    expect(m!.confidence).toBeGreaterThan(0.7)
  })
})

// ── Keyword Overlap (AC-S6-1) ──────────────────────────────────

describe("keyword overlap — partial phrase matching", () => {
  const r = createRecognizer(ALL_COMMANDS)

  test("'pour drinks' overlaps with pour_drink", () => {
    const m = r.match("pour drinks")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("pour_drink")
    expect(m!.confidence).toBeGreaterThan(0.7)
  })

  test("'member check' matches scan_member via keyword overlap", () => {
    const m = r.match("member check")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("scan_member")
    expect(m!.confidence).toBeGreaterThan(0.7)
  })

  test("'deploy status' matches check_deploy via keyword overlap", () => {
    const m = r.match("deploy status")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("check_deploy")
    expect(m!.confidence).toBeGreaterThan(0.7)
  })
})

// ── No Match (AC-S6-1) ─────────────────────────────────────────

describe("no match — returns null for unrecognized input", () => {
  const r = createRecognizer(ALL_COMMANDS)

  test("'hello world how are you today' → null", () => {
    const m = r.match("hello world how are you today")
    expect(m).toBeNull()
  })

  test("empty string → null", () => {
    const m = r.match("")
    expect(m).toBeNull()
  })

  test("whitespace only → null", () => {
    const m = r.match("   ")
    expect(m).toBeNull()
  })

  test("'the quick brown fox jumps' → null", () => {
    const m = r.match("the quick brown fox jumps")
    expect(m).toBeNull()
  })
})

// ── Parameter Extraction (AC-S6-1) ─────────────────────────────

describe("parameter extraction", () => {
  const r = createRecognizer(ALL_COMMANDS)

  test("'pour 2 drinks' extracts quantity: 2", () => {
    const m = r.match("pour 2 drinks")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("pour_drink")
    expect(m!.params.quantity).toBe(2)
  })

  test("'pour 5 drinks' extracts quantity: 5", () => {
    const m = r.match("pour 5 drinks")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("pour_drink")
    expect(m!.params.quantity).toBe(5)
  })

  test("'give 2 drinks' extracts quantity: 2", () => {
    const m = r.match("give 2 drinks")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("pour_drink")
    expect(m!.params.quantity).toBe(2)
  })

  test("'approve for John' extracts agent: John", () => {
    const m = r.match("approve for John")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("approve")
    expect(m!.params.agent).toBe("John")
  })

  test("'reject for Alice' extracts agent: Alice", () => {
    const m = r.match("reject for Alice")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("reject")
    expect(m!.params.agent).toBe("Alice")
  })

  test("'escalate for Bob' extracts agent: Bob", () => {
    const m = r.match("escalate for Bob")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("escalate")
    expect(m!.params.agent).toBe("Bob")
  })

  test("'scan member Alice' extracts member: Alice", () => {
    const m = r.match("scan member Alice")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("scan_member")
    expect(m!.params.member).toBe("Alice")
  })

  test("'deploy to main' extracts branch: main", () => {
    const m = r.match("deploy to main")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("deploy")
    expect(m!.params.branch).toBe("main")
  })
})

// ── Threshold Boundary (AC-S6-1) ───────────────────────────────

describe("threshold boundary — 0.7 cutoff", () => {
  test("custom threshold rejects low-confidence matches", () => {
    const r = new CommandRecognizer(ALL_COMMANDS, 0.95)
    // 'scn member' is a fuzzy match but probably below 0.95
    const m = r.match("scn member")
    // Either null or very high confidence — depends on edit distance
    if (m) {
      expect(m.confidence).toBeGreaterThanOrEqual(0.95)
    }
  })

  test("low threshold accepts more matches", () => {
    const r = new CommandRecognizer(ALL_COMMANDS, 0.3)
    const m = r.match("pur drink")
    expect(m).not.toBeNull()
  })
})

// ── Utility Methods ────────────────────────────────────────────

describe("CommandRecognizer utility methods", () => {
  const r = createRecognizer(ALL_COMMANDS)

  test("listCommands returns all 14 command ids", () => {
    const cmds = r.listCommands()
    expect(cmds).toHaveLength(14)
    expect(cmds).toContain("scan_member")
    expect(cmds).toContain("pour_drink")
    expect(cmds).toContain("check_balance")
    expect(cmds).toContain("fulfill_order")
    expect(cmds).toContain("door_entry")
    expect(cmds).toContain("show_menu")
    expect(cmds).toContain("deploy")
    expect(cmds).toContain("run_tests")
    expect(cmds).toContain("git_status")
    expect(cmds).toContain("commit")
    expect(cmds).toContain("check_deploy")
    expect(cmds).toContain("approve")
    expect(cmds).toContain("reject")
    expect(cmds).toContain("escalate")
  })

  test("getCommand returns definition for known command", () => {
    const def = r.getCommand("deploy")
    expect(def).toBeDefined()
    expect(def!.id).toBe("deploy")
    expect(def!.phrases).toContain("ship it")
  })

  test("getCommand returns undefined for unknown command", () => {
    const def = r.getCommand("nonexistent")
    expect(def).toBeUndefined()
  })
})

// ── Normalization Edge Cases ────────────────────────────────────

describe("normalization — case and punctuation handling", () => {
  const r = createRecognizer(ALL_COMMANDS)

  test("uppercase input matches ('SCAN MEMBER')", () => {
    const m = r.match("SCAN MEMBER")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("scan_member")
    expect(m!.confidence).toBe(1.0)
  })

  test("mixed case input matches ('Pour Drink')", () => {
    const m = r.match("Pour Drink")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("pour_drink")
    expect(m!.confidence).toBe(1.0)
  })

  test("extra whitespace matches ('  scan   member  ')", () => {
    const m = r.match("  scan   member  ")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("scan_member")
    expect(m!.confidence).toBe(1.0)
  })

  test("punctuation stripped ('scan-member!')", () => {
    const m = r.match("scan-member!")
    expect(m).not.toBeNull()
    expect(m!.command).toBe("scan_member")
    expect(m!.confidence).toBe(1.0)
  })
})
