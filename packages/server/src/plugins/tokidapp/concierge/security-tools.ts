import * as fs from "fs"
import * as path from "path"
import { apiGet } from "../orchestrator/starguard-client"

const LUNANAO_API_URL = process.env.LUNANAO_API_URL || "http://127.0.0.1:8080"

// ── Contract Discovery ────────────────────────────────────────

/** List all Solidity contracts in the workspace's solidity/contracts/ directory.
 *  Returns an array of { name, path } for each .sol file found. */
export async function listSolidityContracts(workspaceRoot?: string): Promise<{ name: string; path: string }[]> {
  const root = workspaceRoot || process.cwd()
  const contractsDir = path.join(root, "solidity", "contracts")

  try {
    if (!fs.existsSync(contractsDir)) return []
    const entries = fs.readdirSync(contractsDir)
    return entries
      .filter((f) => f.endsWith(".sol"))
      .map((f) => ({
        name: f.replace(/\.sol$/, ""),
        path: path.join(contractsDir, f),
      }))
  } catch {
    return []
  }
}

// ── Docker Scanner ───────────────────────────────────────────

/** Scan a Solidity contract for security vulnerabilities using
 *  the LuaN1aoAgent Docker container.
 *
 *  1. Verifies the contract exists in solidity/contracts/
 *  2. Sends it to the Docker scanner at LUNANAO_API_URL/scan
 *  3. Polls for completion (every 5s), streaming progress via send()
 *  4. Returns formatted findings grouped by severity */
export async function scanContract(
  contractName: string,
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  // 1. Find the contract
  const contracts = await listSolidityContracts(workspaceRoot)
  const contract = contracts.find(
    (c) => c.name.toLowerCase() === contractName.toLowerCase(),
  )
  if (!contract) {
    const available = contracts.map((c) => `  \u2022 ${c.name}`).join("\n") || "  (none)"
    return [
      `Contract "${contractName}" not found in solidity/contracts/.`,
      "",
      "Available contracts:",
      available,
    ].join("\n")
  }

  if (send) {
    send(
      JSON.stringify({
        type: "stream",
        delta: `Reading ${contract.name}.sol...`,
      }),
    )
  }

  // 2. Read contract source
  let source: string
  try {
    source = fs.readFileSync(contract.path, "utf-8")
  } catch (err) {
    return `Error reading ${contract.name}.sol: ${(err as Error).message}`
  }

  if (send) {
    send(
      JSON.stringify({
        type: "stream",
        delta: `Sending ${contract.name}.sol to security scanner...`,
      }),
    )
  }

  // 3. POST to Docker scanner
  let scanId: string
  try {
    const scanRes = await fetch(`${LUNANAO_API_URL}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contract: contract.name,
        source,
        goal: `Audit ${contract.name} for security vulnerabilities. Focus on: reentrancy, access control, integer overflow, timestamp dependence, gas griefing, and business logic flaws.`,
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!scanRes.ok) {
      const errText = await scanRes.text().catch(() => "unknown error")
      return `Scanner returned error ${scanRes.status}: ${errText.slice(0, 300)}`
    }

    const scanBody = (await scanRes.json()) as { scanId?: string; id?: string }
    scanId = (scanBody.scanId || scanBody.id) as string
    if (!scanId) {
      return "Scanner did not return a scan ID."
    }
  } catch (err) {
    const msg = (err as Error).message
    // Detect connection refused / DNS failure
    if (
      msg.includes("fetch") ||
      msg.includes("connect") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("aborted")
    ) {
      return [
        "**Security scanner is offline.**",
        "",
        "Make sure the Docker container is running on port 8080.",
        `Scanner URL: \`${LUNANAO_API_URL}\``,
      ].join("\n")
    }
    return `Failed to start scan: ${msg}`
  }

  if (send) {
    send(
      JSON.stringify({
        type: "stream",
        delta: `Scan started (ID: ${scanId}). Polling for results...`,
      }),
    )
  }

  // 4. Poll for completion
  const startTime = Date.now()
  const POLL_INTERVAL = 5_000 // 5 seconds
  const MAX_DURATION = 300_000 // 5 minutes
  let lastProgressUpdate = 0

  while (Date.now() - startTime < MAX_DURATION) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))

    try {
      const pollRes = await fetch(`${LUNANAO_API_URL}/scan/${scanId}`, {
        signal: AbortSignal.timeout(10_000),
      })

      if (!pollRes.ok) {
        if (pollRes.status === 404) {
          return `Scan ${scanId} not found. It may have expired or been cancelled.`
        }
        const errText = await pollRes.text().catch(() => "unknown error")
        // If still 202, keep polling
        if (pollRes.status === 202) continue
        return `Status check error (${pollRes.status}): ${errText.slice(0, 200)}`
      }

      const result = (await pollRes.json()) as {
        status?: string
        state?: string
        risk_score?: number
        findings?: Array<{
          severity?: string
          title?: string
          description?: string
          location?: string
        }>
        duration?: number
        summary?: string
      }

      const status = (result.state || result.status || "").toLowerCase()

      // Stream progress every 30 seconds
      if (send) {
        const now = Date.now()
        if (now - lastProgressUpdate > 30_000) {
          lastProgressUpdate = now
          send(
            JSON.stringify({
              type: "stream",
              delta: `Still scanning... (${Math.round((now - startTime) / 1000)}s elapsed)`,
            }),
          )
        }
      }

      if (status === "completed" || status === "complete" || status === "done") {
        return formatScanResults(contract.name, result, startTime)
      }

      // Also treat non-empty findings array as completion
      if (result.findings && result.findings.length > 0) {
        return formatScanResults(contract.name, result, startTime)
      }

      if (status === "failed" || status === "error") {
        const findings = result.findings
        const errSummary = findings && findings.length > 0
          ? findings.map((f) => `  \u2022 ${f.title || f.description || "(no detail)"}`).join("\n")
          : result.summary || "No details provided."
        return [
          `**Scan of ${contract.name} failed.**`,
          "",
          errSummary,
        ].join("\n")
      }

      // Otherwise still running — continue polling
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes("aborted") || msg.includes("timeout")) {
        // Timeout on the poll request — the scanner might still be running
        if (send) {
          send(
            JSON.stringify({
              type: "stream",
              delta: `Poll request timed out — retrying...`,
            }),
          )
        }
        continue
      }
      return `Error polling scan status: ${msg}`
    }
  }

  // Timeout reached
  return [
    `**Scan timed out after ${MAX_DURATION / 1000}s.**`,
    "",
    `Scan ID: \`${scanId}\``,
    "The scanner may still be processing. Check status with 'scan status'.",
  ].join("\n")
}

/** Format scan results into a human-readable markdown string. */
function formatScanResults(
  contractName: string,
  result: {
    status?: string
    state?: string
    risk_score?: number
    findings?: Array<{
      severity?: string
      title?: string
      description?: string
      location?: string
    }>
    duration?: number
    summary?: string
  },
  startTime: number,
): string {
  const findings = result.findings || []
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const riskScore = result.risk_score ?? 0
  const scanDuration = result.duration ?? 0

  // Count by severity
  const severityCount: Record<string, number> = {}
  for (const f of findings) {
    const sev = (f.severity || "info").toLowerCase()
    severityCount[sev] = (severityCount[sev] || 0) + 1
  }

  const severityLabels: Record<string, string> = {
    critical: "\u{1F525} Critical",
    high: "\u{1F534} High",
    medium: "\u{1F7E0} Medium",
    low: "\u{1F7E1} Low",
    info: "\u2139\uFE0F Info",
    gas: "\u26A1 Gas",
  }

  const severityOrder = ["critical", "high", "medium", "low", "info", "gas"]
  const severityLines = severityOrder
    .filter((s) => severityCount[s])
    .map((s) => `  ${severityLabels[s] || s}: ${severityCount[s]}`)

  // Top 10 critical/high findings first, then medium, truncated to 200 chars
  const severityRank: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
    gas: 5,
  }

  const topFindings = [...findings]
    .sort((a, b) => {
      const ra = severityRank[a.severity?.toLowerCase() || ""] ?? 99
      const rb = severityRank[b.severity?.toLowerCase() || ""] ?? 99
      return ra - rb
    })
    .slice(0, 10)

  const findingLines = topFindings.map((f, i) => {
    const sev = f.severity || "info"
    const title = f.title || "Untitled finding"
    const desc = (f.description || "").slice(0, 200)
    const loc = f.location ? ` (${f.location})` : ""
    return `  ${i + 1}. [${sev.toUpperCase()}] ${title}${loc}\n     ${desc}`
  })

  const header = result.summary
    ? `**${contractName}** \u2014 ${result.summary}`
    : `**Scan Results: ${contractName}**`

  return [
    header,
    "",
    `Risk Score: **${riskScore}/10** | Scan time: ${scanDuration ? `${scanDuration}s` : `${elapsed}s`}`,
    "",
    "**Findings by severity:**",
    ...severityLines,
    "",
    `**Top Findings** (${topFindings.length} of ${findings.length}):`,
    ...findingLines,
    "",
    findings.length > 10
      ? `_... and ${findings.length - 10} more findings. Use Dashboard for full report._`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

// ── StarGuard Proxy Queries ───────────────────────────────────

/** Get the status of a previously submitted security scan. */
export async function getScanStatus(scanId: string): Promise<string> {
  try {
    const res = await apiGet(`/api/security/scan/${scanId}`)
    if (!res.ok) {
      if (res.status === 404) {
        return `Scan \`${scanId}\` not found.`
      }
      return `Failed to fetch scan status (${res.status}).`
    }

    const data = (await res.json()) as {
      status?: string
      risk_score?: number
      findings_count?: number
      contract_name?: string
      duration?: number
    }

    return [
      `**Scan Status: \`${scanId}\`**`,
      "",
      `Contract: ${data.contract_name || "(unknown)"}`,
      `Status: ${data.status || "(unknown)"}`,
      data.risk_score !== undefined ? `Risk Score: **${data.risk_score}/10**` : "",
      data.findings_count !== undefined ? `Findings: ${data.findings_count}` : "",
      data.duration ? `Duration: ${data.duration}s` : "",
    ]
      .filter(Boolean)
      .join("\n")
  } catch (err) {
    return `Error fetching scan status: ${(err as Error).message}`
  }
}

/** List recent security scans from the StarGuard proxy. */
export async function listSecurityScans(): Promise<string> {
  try {
    const res = await apiGet("/api/security/scans", { limit: "10" })
    if (!res.ok) {
      return `Failed to fetch scans (${res.status}).`
    }

    const data = (await res.json()) as {
      scans?: Array<{
        id?: string
        contract_name?: string
        status?: string
        risk_score?: number
        created_at?: string
      }>
    }

    const scans = data.scans || []
    if (scans.length === 0) {
      return "No recent security scans found."
    }

    return [
      "**Recent Security Scans:**",
      "",
      ...scans.map((s, i) => {
        const id = s.id || "(no id)"
        const name = s.contract_name || "(unknown)"
        const status = s.status || "(unknown)"
        const score = s.risk_score !== undefined ? ` | Risk: ${s.risk_score}/10` : ""
        const date = s.created_at
          ? ` | ${new Date(s.created_at).toLocaleDateString()}`
          : ""
        return `  ${i + 1}. \`${id.slice(0, 8)}…\` — ${name} (${status})${score}${date}`
      }),
    ].join("\n")
  } catch (err) {
    return `Error listing scans: ${(err as Error).message}`
  }
}
