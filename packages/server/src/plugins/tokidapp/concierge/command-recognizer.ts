/**
 * Command Recognizer — Guided-mode voice command matching for TokiDAPP.
 *
 * Matches voice transcripts against predefined command lists using a
 * three-tier fuzzy matching pipeline (exact → keyword overlap → edit distance).
 * Only unmatched transcripts fall through to the LLM, reducing latency and
 * cost for known commands.
 *
 * Inspired by whisper.cpp's `command` example with constrained transcription.
 *
 * @module command-recognizer
 */

// ── Types ──────────────────────────────────────────────────────

/** Definition of a voice command with alternative phrase forms. */
export interface CommandDef {
  /** Unique command identifier (e.g. 'scan_member') */
  id: string
  /** Alternative ways to say this command */
  phrases: string[]
  /** API endpoint or tool name to invoke */
  action: string
  /** Parameter names to extract from the transcript (e.g. 'quantity', 'agent') */
  params?: string[]
}

/** Result of a successful command match. */
export interface CommandMatch {
  /** The matched command id */
  command: string
  /** Confidence score (0.0 – 1.0) */
  confidence: number
  /** Extracted parameters from the transcript */
  params: Record<string, string | number>
  /** The action to invoke */
  action: string
}

/** Internal scoring entry used during matching. */
interface ScoredCandidate {
  def: CommandDef
  confidence: number
}

// ── Normalization ──────────────────────────────────────────────

/**
 * Normalize a transcript for matching: lowercase, collapse whitespace,
 * strip punctuation (keep alphanumerics, spaces, and hash/colon for branches).
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Split a normalized string into a set of unique words.
 */
function wordSet(text: string): Set<string> {
  return new Set(text.split(" ").filter(Boolean))
}

// ── Edit Distance (Levenshtein) ────────────────────────────────

/**
 * Compute Levenshtein edit distance between two strings.
 * O(n*m) time, O(min(n,m)) space.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) {
    const temp = a; a = b; b = temp
  }

  const aLen = a.length
  const bLen = b.length

  // Previous row of distances
  const prev = new Uint16Array(aLen + 1)
  for (let i = 0; i <= aLen; i++) prev[i] = i

  const curr = new Uint16Array(aLen + 1)

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[i] = Math.min(
        prev[i] + 1,       // deletion
        curr[i - 1] + 1,   // insertion
        prev[i - 1] + cost, // substitution
      )
    }
    prev.set(curr)
  }

  return prev[aLen]
}

// ── Parameter Extraction ───────────────────────────────────────

/** Patterns for extracting parameters from transcripts. */
const NUMBER_PATTERN = /\b(\d+)\b/
const QUANTITY_PATTERNS = [
  /\b(\d+)\s*(?:drinks?|beverages?|orders?|items?|pcs?|pieces?)\b/i,
  /\bpour\s+(\d+)\b/i,
  /\bserve\s+(\d+)\b/i,
  /\bgive\s+(\d+)\b/i,
  /\border\s+(\d+)\b/i,
]

/**
 * Extract numeric parameters from a transcript.
 * Looks for quantity patterns and bare numbers.
 */
function extractNumbers(transcript: string): Record<string, number> {
  const result: Record<string, number> = {}

  // Check structured quantity patterns first
  for (const pattern of QUANTITY_PATTERNS) {
    const match = transcript.match(pattern)
    if (match) {
      result.quantity = parseInt(match[1], 10)
      return result
    }
  }

  // Fallback: bare number
  const bareMatch = transcript.match(NUMBER_PATTERN)
  if (bareMatch) {
    result.quantity = parseInt(bareMatch[1], 10)
  }

  return result
}

/**
 * Extract name-like parameters from a transcript.
 * Looks for "hand to <Name>", "give to <Name>", "assign <Name>", etc.
 */
function extractNames(transcript: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lower = transcript.toLowerCase()

  const namePatterns: [RegExp, string][] = [
    [/\b(?:hand|give|pass|assign|deliver)\s+(?:to\s+)?([A-Z][a-z]+)\b/i, "agent"],
    [/\b(?:to|for)\s+([A-Z][a-z]+)\b/i, "agent"],
    [/\b(?:approve|reject|escalate)\s+(?:for\s+)?([A-Z][a-z]+)\b/i, "agent"],
    [/\bmember\s+([A-Z][a-z]+)\b/i, "member"],
    [/\b(?:check|scan)\s+(?:member\s+)?([A-Z][a-z]+)\b/i, "member"],
  ]

  for (const [pattern, paramName] of namePatterns) {
    const match = transcript.match(pattern)
    if (match) {
      result[paramName] = match[1]
      return result
    }
  }

  // Also try lower-case patterns on the original transcript
  const lowerPatterns: [RegExp, string][] = [
    [/\bhand(?:ed)?\s+to\s+(\w+)\b/i, "agent"],
    [/\bgive(?:n)?\s+to\s+(\w+)\b/i, "agent"],
    [/\bpass(?:ed)?\s+to\s+(\w+)\b/i, "agent"],
    [/\bfor\s+(\w+)\b/i, "agent"],
  ]

  for (const [pattern, paramName] of lowerPatterns) {
    const match = lower.match(pattern)
    if (match) {
      result[paramName] = match[1]
      return result
    }
  }

  return result
}

/**
 * Extract branch/path parameters from a transcript.
 * Looks for "for main", "to staging", branch names, etc.
 */
function extractBranches(transcript: string): Record<string, string> {
  const result: Record<string, string> = {}

  const branchPatterns: [RegExp, string][] = [
    [/\bfor\s+(?:branch\s+)?(\w+)\b/i, "branch"],
    [/\bto\s+(?:branch\s+)?(\w+)\b/i, "branch"],
    [/\bon\s+(?:branch\s+)?(\w+)\b/i, "branch"],
    [/\bbranch\s+(\w+)\b/i, "branch"],
  ]

  for (const [pattern, paramName] of branchPatterns) {
    const match = transcript.match(pattern)
    if (match) {
      result[paramName] = match[1]
      return result
    }
  }

  return result
}

/**
 * Extract all parameters from a transcript for a given command definition.
 */
function extractParams(
  transcript: string,
  commandDef: CommandDef,
): Record<string, string | number> {
  const params: Record<string, string | number> = {}
  const requestedParams = commandDef.params ?? []

  // Always try all extraction strategies
  const numbers = extractNumbers(transcript)
  const names = extractNames(transcript)
  const branches = extractBranches(transcript)

  // Merge requested params only
  for (const paramName of requestedParams) {
    if (paramName in numbers) {
      params[paramName] = numbers[paramName]
    } else if (paramName in names) {
      params[paramName] = names[paramName]
    } else if (paramName in branches) {
      params[paramName] = branches[paramName]
    }
  }

  // Also include any extracted params that match the command's param list
  // even if not explicitly listed (auto-detect)
  for (const [key, value] of Object.entries(numbers)) {
    if (!(key in params) && requestedParams.includes(key)) {
      params[key] = value
    }
  }

  return params
}

// ── Matching Strategies ────────────────────────────────────────

/**
 * Tier 1: Exact phrase match.
 * Returns confidence 1.0 if the normalized transcript exactly matches any phrase.
 */
function exactMatch(transcriptNorm: string, def: CommandDef): number {
  for (const phrase of def.phrases) {
    if (normalize(phrase) === transcriptNorm) {
      return 1.0
    }
  }
  return 0
}

/**
 * Tier 2: Keyword overlap match.
 * Returns confidence = overlap_ratio * 0.9 when words overlap significantly.
 * Phrases with more words in common score higher.
 */
function keywordOverlap(transcriptNorm: string, def: CommandDef): number {
  const transcriptWords = wordSet(transcriptNorm)
  let bestOverlap = 0

  for (const phrase of def.phrases) {
    const phraseWords = wordSet(normalize(phrase))
    if (phraseWords.size === 0) continue

    let overlap = 0
    for (const word of transcriptWords) {
      if (phraseWords.has(word)) overlap++
    }

    const ratio = overlap / phraseWords.size
    if (ratio > bestOverlap) bestOverlap = ratio
  }

  // Weight by coverage of both sides for better discrimination
  if (bestOverlap > 0) {
    return bestOverlap * 0.9
  }
  return 0
}

/**
 * Tier 3: Edit distance match.
 * Returns confidence = 1 - (distance / max_length) * 0.8
 * Best for catching typos and slight mis-transcriptions.
 */
function editDistanceMatch(transcriptNorm: string, def: CommandDef): number {
  let bestConfidence = 0

  for (const phrase of def.phrases) {
    const phraseNorm = normalize(phrase)
    const maxLen = Math.max(transcriptNorm.length, phraseNorm.length, 1)
    const distance = editDistance(transcriptNorm, phraseNorm)
    const confidence = 1 - (distance / maxLen) * 0.8

    if (confidence > bestConfidence) bestConfidence = confidence
  }

  return bestConfidence
}

// ── CommandRecognizer Class ────────────────────────────────────

/** Default confidence threshold — matches below this are rejected. */
const DEFAULT_THRESHOLD = 0.7

/**
 * Guided-mode command recognizer for TokiDAPP voice input.
 *
 * Matches voice transcripts against predefined command lists using a
 * three-tier pipeline:
 * 1. Exact phrase match (confidence 1.0)
 * 2. Keyword overlap (confidence = overlap × 0.9)
 * 3. Edit distance (confidence = 1 - (dist/max) × 0.8)
 *
 * Returns null if no match exceeds the confidence threshold (default 0.7).
 *
 * @example
 * ```typescript
 * const recognizer = new CommandRecognizer(VENUE_STAFF_COMMANDS)
 * const match = recognizer.match("scan member")
 * if (match) {
 *   await executeCommand(match.action, match.params)
 * } else {
 *   await callLLM(transcript)
 * }
 * ```
 */
export class CommandRecognizer {
  private readonly commands: CommandDef[]
  private readonly threshold: number
  private readonly phraseIndex: Map<string, CommandDef>

  constructor(commands: CommandDef[], threshold = DEFAULT_THRESHOLD) {
    this.commands = commands
    this.threshold = threshold

    // Pre-build phrase index for O(1) exact lookups
    this.phraseIndex = new Map()
    for (const def of commands) {
      for (const phrase of def.phrases) {
        this.phraseIndex.set(normalize(phrase), def)
      }
    }
  }

  /**
   * Match a voice transcript against the command list.
   *
   * @param transcript - Raw voice transcript text
   * @returns Match result with confidence and params, or null if below threshold
   */
  match(transcript: string): CommandMatch | null {
    const transcriptNorm = normalize(transcript)
    if (!transcriptNorm) return null

    // Tier 1: Check phrase index for exact match (O(1))
    const exactMatchDef = this.phraseIndex.get(transcriptNorm)
    if (exactMatchDef) {
      return {
        command: exactMatchDef.id,
        confidence: 1.0,
        params: extractParams(transcript, exactMatchDef),
        action: exactMatchDef.action,
      }
    }

    // Tier 2 & 3: Score all commands
    let best: ScoredCandidate | null = null

    for (const def of this.commands) {
      // Skip if exact already matched (handled above)

      // Tier 2: keyword overlap
      const kwScore = keywordOverlap(transcriptNorm, def)

      // Tier 3: edit distance
      const edScore = editDistanceMatch(transcriptNorm, def)

      // Take the best of the two for this command
      const score = Math.max(kwScore, edScore)

      if (score > (best?.confidence ?? 0)) {
        best = { def, confidence: score }
      }
    }

    if (best && best.confidence >= this.threshold) {
      return {
        command: best.def.id,
        confidence: Math.round(best.confidence * 1000) / 1000,
        params: extractParams(transcript, best.def),
        action: best.def.action,
      }
    }

    return null
  }

  /**
   * List all registered command ids.
   */
  listCommands(): string[] {
    return this.commands.map((d) => d.id)
  }

  /**
   * Get the definition for a specific command.
   */
  getCommand(id: string): CommandDef | undefined {
    return this.commands.find((d) => d.id === id)
  }
}

// ── Pre-built Command Sets ─────────────────────────────────────

/** Venue staff commands: door entry, bar scanning, menu, fulfillment. */
export const VENUE_STAFF_COMMANDS: CommandDef[] = [
  {
    id: "scan_member",
    phrases: ["scan member", "scan qr", "member check", "check member"],
    action: "POST /api/staff/bar/scan",
    params: ["member"],
  },
  {
    id: "pour_drink",
    phrases: ["pour drink", "redeem drink", "serve drink", "give drink"],
    action: "POST /api/staff/bar/redeem",
    params: ["quantity", "agent"],
  },
  {
    id: "check_balance",
    phrases: ["check balance", "starxp balance", "how many points", "what balance"],
    action: "GET /api/staff/bar/pending",
  },
  {
    id: "fulfill_order",
    phrases: ["fulfill order", "complete order", "order done", "mark done"],
    action: "PUT /api/staff/bar/fulfill/:id",
    params: ["quantity"],
  },
  {
    id: "door_entry",
    phrases: ["door entry", "let in", "admit", "allow entry"],
    action: "POST /api/staff/door/scan",
  },
  {
    id: "show_menu",
    phrases: ["show menu", "what drinks", "drink list", "menu please"],
    action: "GET /api/staff/bar/menu",
  },
]

/** Concierge commands: deploy, test, git, status. */
export const CONCIERGE_COMMANDS: CommandDef[] = [
  {
    id: "deploy",
    phrases: ["deploy", "ship it", "push to production", "go live"],
    action: "triggerVercelDeploy",
    params: ["branch"],
  },
  {
    id: "run_tests",
    phrases: ["run tests", "test suite", "check tests", "run all tests"],
    action: "runTests",
  },
  {
    id: "git_status",
    phrases: ["git status", "check status", "what changed", "show changes"],
    action: "gitStatus",
  },
  {
    id: "commit",
    phrases: ["commit", "save changes", "git commit", "commit changes", "save my work"],
    action: "gitCommitPush",
  },
  {
    id: "check_deploy",
    phrases: ["check deploy", "deploy status", "is it live", "deployment status", "check deploy status"],
    action: "checkDeployStatus",
  },
]

/** Admin commands: approval workflows. */
export const ADMIN_COMMANDS: CommandDef[] = [
  {
    id: "approve",
    phrases: ["approve", "accept", "confirm"],
    action: "approve",
    params: ["agent"],
  },
  {
    id: "reject",
    phrases: ["reject", "deny", "decline"],
    action: "reject",
    params: ["agent"],
  },
  {
    id: "escalate",
    phrases: ["escalate", "raise issue", "priority"],
    action: "escalate",
    params: ["agent"],
  },
]

/** All command sets combined for convenience. */
export const ALL_COMMANDS: CommandDef[] = [
  ...VENUE_STAFF_COMMANDS,
  ...CONCIERGE_COMMANDS,
  ...ADMIN_COMMANDS,
]
