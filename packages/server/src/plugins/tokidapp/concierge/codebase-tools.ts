import { execSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { rollbackToPreviousCommit } from "../orchestrator/rollback"
import { apiGet } from "../orchestrator/starguard-client"

// ── Knowledge Base ─────────────────────────────────────────────

/** Query the StarCARD architecture knowledge base via StarGuard.
 *  Searches entities by keyword, domain, or category. Returns a
 *  human-readable summary of matching entities, relations, and diagrams. */
export async function queryKnowledgeBase(
  query: string,
  domain?: string,
  category?: string,
): Promise<string> {
  const params: Record<string, string> = {}
  if (query?.trim()) params.search = query.trim()
  if (domain?.trim()) params.domain = domain.trim()
  if (category?.trim()) params.category = category.trim()
  params.limit = "10"

  try {
    const res = await apiGet("/api/architecture/entities", params)
    if (!res.ok) {
      return `Knowledge base unavailable (${res.status}). Try investigate_codebase instead.`
    }
    const data = await res.json()
    const entities = data.entities || data || []
    if (!Array.isArray(entities) || entities.length === 0) {
      return "No matching entities found in the architecture knowledge base."
    }

    return entities.map((e: any) => {
      const lines = [
        `• ${e.name || e.stableId || "(unnamed)"}`,
        e.stableId ? `  ID: ${e.stableId}` : undefined,
        e.domain ? `  Domain: ${e.domain}` : undefined,
        e.category ? `  Category: ${e.category}` : undefined,
        e.description ? `  ${e.description.slice(0, 200)}` : undefined,
      ].filter(Boolean).join("\n")
      return lines
    }).join("\n\n")
  } catch (err) {
    return `Knowledge base query failed: ${(err as Error).message}`
  }
}

/** Get a compact digest of key knowledge sources for prompt enrichment.
 *  Includes architecture entities with descriptions + project-intelligence docs,
 *  ecosystem architecture references, domain policies, ZenStack schema summary,
 *  and Solidity contract overview. Returns a plain-text digest (target: ≤4000 chars). */
export async function getArchitectureDigest(): Promise<string> {
  const parts: string[] = []
  const KB = path.resolve(process.cwd(), "..")

  // 0. Core ecosystem identity — always present
  parts.push("## StarWORLD Ecosystem Overview")
  parts.push("StarWORLD is a multi-chain Web3 ecosystem portal with:")
  parts.push("- Smart contracts on Sepolia (testnet) and BSC (mainnet)")
  parts.push("- Membership system with tiers (Free/Standard/Participatory)")
  parts.push("- StarXP reward points for venue purchases")
  parts.push("- Revenue sharing via RevenuePool + DynamicSplitter")
  parts.push("- Cross-chain bridge (Sepolia ↔ BSC)")
  parts.push("- NFT membership cards (StarCard, ERC-4907)")
  parts.push("- AI concierge (TokiDAPP) with voice + text")
  parts.push("- NomadWorks 25-agent SDLC orchestration")
  parts.push("")

  // 1. Architecture entities from StarGuard API — include descriptions
  try {
    const res = await apiGet("/api/architecture/entities", { limit: "30" })
    if (res.ok) {
      const data = await res.json()
      const entities = data.entities || data || []
      if (Array.isArray(entities) && entities.length > 0) {
        parts.push("## Key Architecture Entities")
        const byDomain = new Map<string, Array<{ name: string; stableId: string; description: string; category: string }>>()
        for (const e of entities) {
          const domain = e.domain || "GENERAL"
          if (!byDomain.has(domain)) byDomain.set(domain, [])
          byDomain.get(domain)!.push({
            name: e.name || e.stableId || "(unnamed)",
            stableId: e.stableId || "",
            description: (e.description || "").slice(0, 150),
            category: e.category || "",
          })
        }
        for (const [domain, ents] of byDomain) {
          parts.push(`\n### ${domain}`)
          for (const e of ents.slice(0, 8)) {
            const desc = e.description ? ` — ${e.description}` : ""
            parts.push(`- ${e.name} (${e.stableId}) [${e.category}]${desc}`)
          }
        }
      }
    }
  } catch { /* skip — API unavailable */ }

  // 2. ZenStack schema summary — model names and key relationships
  try {
    const schemaPath = path.resolve(KB, "zenstack/schema.zmodel")
    if (fs.existsSync(schemaPath)) {
      const schemaContent = fs.readFileSync(schemaPath, "utf-8")
      // Extract model names (lines starting with "model ")
      const modelNames = [...schemaContent.matchAll(/^model\s+(\w+)/gm)].map(m => m[1])
      // Extract enum names
      const enumNames = [...schemaContent.matchAll(/^enum\s+(\w+)/gm)].map(m => m[1])
      // Extract procedure names
      const procNames = [...schemaContent.matchAll(/^(?:mutation\s+)?procedure\s+(\w+)/gm)].map(m => m[1])

      if (modelNames.length > 0) {
        parts.push("\n## ZenStack Data Models (66 models)")
        // Group models by domain prefix
        const domainGroups: Record<string, string[]> = {}
        for (const name of modelNames) {
          const prefix = name.match(/^(TokiDAPP|StarXP|Venue|Membership|Capital|SAFT|Ticket|Revenue|Drink|Merchant|Region|Treasury|Linked|VenueAccess|Promoter|Referral|Nonce|Client|Invoice|Contract|Document|Audit|Security|Architecture|Entity|Diagram|NomadWorks|AI|Causal|Node|Tool|Nav|Page)/i)?.[1] || "Core"
          if (!domainGroups[prefix]) domainGroups[prefix] = []
          domainGroups[prefix].push(name)
        }
        for (const [group, names] of Object.entries(domainGroups).slice(0, 10)) {
          parts.push(`- ${group}: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` (+${names.length - 6})` : ""}`)
        }
      }
      if (enumNames.length > 0) {
        parts.push(`- Enums: ${enumNames.slice(0, 10).join(", ")}${enumNames.length > 10 ? ` (+${enumNames.length - 10})` : ""}`)
      }
      if (procNames.length > 0) {
        parts.push(`- Procedures: ${procNames.join(", ")}`)
      }
    }
  } catch { /* skip */ }

  // 3. Solidity contracts overview
  try {
    const contractsDir = path.resolve(KB, "solidity/contracts")
    if (fs.existsSync(contractsDir)) {
      const contractFiles = fs.readdirSync(contractsDir).filter(f => f.endsWith(".sol"))
      if (contractFiles.length > 0) {
        parts.push("\n## Solidity Contracts")
        // Group by directory
        const groups: Record<string, string[]> = {}
        for (const file of contractFiles) {
          const parts2 = file.replace(".sol", "").split(/(?=[A-Z])/)
          const prefix = parts2[0] || "Other"
          if (!groups[prefix]) groups[prefix] = []
          groups[prefix].push(file.replace(".sol", ""))
        }
        for (const [group, names] of Object.entries(groups).slice(0, 8)) {
          parts.push(`- ${group}: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` (+${names.length - 5})` : ""}`)
        }
        parts.push(`- Total: ${contractFiles.length} contract files`)
      }
    }
  } catch { /* skip */ }

  // 4. Project-intelligence files (prioritize critical/high)
  const piDir = path.resolve(KB, ".opencode/context/project-intelligence")
  if (fs.existsSync(piDir)) {
    const piFiles = fs.readdirSync(piDir).filter(f => f.endsWith(".md"))
    const critical: string[] = []
    const high: string[] = []
    for (const file of piFiles) {
      try {
        const content = fs.readFileSync(path.join(piDir, file), "utf-8")
        const prio = content.match(/Priority:\s*(\w+)/i)
        const prioVal = prio ? prio[1].toLowerCase() : "normal"
        const name = file.replace(/\.md$/, "")
        if (prioVal === "critical") critical.push(name)
        else if (prioVal === "high") high.push(name)
      } catch { /* skip */ }
    }
    if (critical.length > 0) {
      parts.push("\n## Project Intelligence (critical)")
      parts.push(critical.join(", "))
    }
    if (high.length > 0) {
      parts.push("## Project Intelligence (high)")
      parts.push(high.slice(0, 8).join(", "))
    }
  }

  // 5. Ecosystem architecture deep-dives
  const ecoDir = path.resolve(KB, "docs/architecture/ecosystem")
  if (fs.existsSync(ecoDir)) {
    const ecoFiles = fs.readdirSync(ecoDir).filter(f => f.endsWith(".md"))
    if (ecoFiles.length > 0) {
      parts.push("\n## Ecosystem Architecture Docs")
      parts.push(ecoFiles.map(f => f.replace(/\.md$/, "")).join(", "))
    }
  }

  // 6. NomadWorks domain policies
  const polDir = path.resolve(KB, ".nomadworks/policies")
  if (fs.existsSync(polDir)) {
    const polFiles = fs.readdirSync(polDir).filter(f => f.endsWith(".md"))
    if (polFiles.length > 0) {
      const polNames = polFiles.map(f => f.replace(/\.md$/, "")).filter(n => n !== "README")
      parts.push("\n## Domain Policies")
      parts.push(polNames.join(", "))
    }
  }

  // 7. NomadWorks agents available
  try {
    const nomadDir = path.resolve(KB, ".nomadworks")
    const agentsFile = path.join(nomadDir, "nomadworks.yaml")
    if (fs.existsSync(agentsFile)) {
      const agentContent = fs.readFileSync(agentsFile, "utf-8")
      const agentSlugs = [...agentContent.matchAll(/slug:\s*(\w+)/g)].map(m => m[1])
      if (agentSlugs.length > 0) {
        parts.push("\n## NomadWorks Agents")
        parts.push(agentSlugs.join(", "))
      }
    }
  } catch { /* skip */ }

  // 8. Key deployment addresses
  try {
    const deployPath = path.resolve(KB, "src/data/sepolia-deployments.ts")
    if (fs.existsSync(deployPath)) {
      const deployContent = fs.readFileSync(deployPath, "utf-8")
      // Extract contract names from the deployment map
      const contractNames = [...deployContent.matchAll(/["']?(\w+)["']?\s*:\s*["']?(0x[a-fA-F0-9]{40})/g)]
        .slice(0, 10)
        .map(m => `${m[1]}: ${m[2].slice(0, 6)}...${m[2].slice(-4)}`)
      if (contractNames.length > 0) {
        parts.push("\n## Sepolia Deployments")
        parts.push(contractNames.join(", "))
      }
    }
  } catch { /* skip */ }

  // 9. Active SCRs — recently approved or in-progress spec changes
  try {
    const scrsDir = path.resolve(KB, "docs/scrs")
    if (fs.existsSync(scrsDir)) {
      const scrFiles = fs.readdirSync(scrsDir)
        .filter(f => f.endsWith(".md") && f !== "current.md" && f !== "done.md")
        .sort()
        .reverse()
        .slice(0, 8)
      if (scrFiles.length > 0) {
        parts.push("\n## Recent Spec Change Requests (SCRs)")
        for (const file of scrFiles) {
          try {
            const content = fs.readFileSync(path.join(scrsDir, file), "utf-8")
            const title = content.match(/^# (.+)$/m)?.[1] || file.replace(".md", "")
            const status = content.match(/status:\s*(\w+)/i)?.[1] || "unknown"
            parts.push(`- ${file} — ${title} [${status}]`)
          } catch { /* skip file */ }
        }
      }
    }
  } catch { /* skip */ }

  // 10. Current active tasks from current.md
  try {
    const currentFile = path.resolve(KB, "tasks/current.md")
    if (fs.existsSync(currentFile)) {
      const content = fs.readFileSync(currentFile, "utf-8")
      // Extract task entries (lines starting with - **TASK)
      const taskLines: string[] = []
      let inActive = false
      for (const line of content.split("\n")) {
        if (line.startsWith("## Active")) inActive = true
        else if (line.startsWith("## ")) inActive = false
        if (inActive && line.includes("**TASK")) {
          taskLines.push(line.replace(/^-\s+/, "").replace(/\*\*/g, "").trim())
        }
      }
      if (taskLines.length > 0) {
        parts.push("\n## Active Tasks")
        for (const t of taskLines.slice(0, 8)) {
          parts.push(`- ${t}`)
        }
      }
    }
  } catch { /* skip */ }

  // 11. Recent discussions
  try {
    const discDir = path.resolve(KB, "tasks/discussions")
    if (fs.existsSync(discDir)) {
      const discFiles = fs.readdirSync(discDir)
        .filter(f => f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, 5)
      if (discFiles.length > 0) {
        parts.push("\n## Recent Discussions")
        for (const file of discFiles) {
          try {
            const content = fs.readFileSync(path.join(discDir, file), "utf-8")
            const title = content.match(/^# (.+)$/m)?.[1] || file.replace(".md", "")
            parts.push(`- ${title}`)
          } catch { /* skip */ }
        }
      }
    }
  } catch { /* skip */ }

  // 12. Git workspace state — branch and uncommitted changes
  try {
    const gitDir = path.resolve(KB, ".git")
    if (fs.existsSync(gitDir)) {
      const branch = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
        cwd: KB, encoding: "utf-8", maxBuffer: 1024 * 16,
      }).trim()
      const changed = execSync("git status --porcelain 2>/dev/null | wc -l", {
        cwd: KB, encoding: "utf-8", maxBuffer: 1024 * 16,
      }).trim()
      const ahead = execSync("git log --oneline @{u}..HEAD 2>/dev/null | wc -l", {
        cwd: KB, encoding: "utf-8", maxBuffer: 1024 * 16,
      }).trim()
      if (branch) {
        parts.push("\n## Workspace State")
        parts.push(`- Branch: ${branch}`)
        parts.push(`- Uncommitted files: ${changed || "0"}`)
        if (ahead && ahead !== "0") parts.push(`- Commits ahead of remote: ${ahead}`)
      }
    }
  } catch { /* skip */ }

  return parts.length > 0 ? parts.join("\n") : ""
}

// ── Helpers ───────────────────────────────────────────────────

export async function captureGitDiff(workspaceRoot: string): Promise<string> {
  try {
    return execSync("git diff --cached --stat 2>/dev/null || echo '(no changes)'", {
      cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 1024 * 1024,
    })
  } catch { return "(could not capture diff)" }
}

export async function checkDeployStatus(
  workspaceRoot: string,
): Promise<string> {
  try {
    const output = execSync("vercel list deployments --project starguard --limit 1 --yes 2>&1 || vercel --scope tokenizin-projects list deployments --limit 1 2>&1", {
      cwd: workspaceRoot,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    })
    const lines = output.trim().split("\n").filter(Boolean)
    const header = lines.find((l) => l.includes("vercel.app"))
    const state = lines.find((l) => l.includes("Ready") || l.includes("Building") || l.includes("Error") || l.includes("Canceled"))
    return [
      header ? `Latest: ${header}` : "",
      state ? `State: ${state.trim()}` : "",
      output.length > 0 ? `\n${output.split("\n").slice(-5).join("\n")}` : "",
    ].filter(Boolean).join("\n").trim() || "Could not fetch deploy status."
  } catch {
    return "Could not fetch deploy status."
  }
}

// ── Tool Functions ────────────────────────────────────────────

// Stop words to filter out when AI passes the full user message verbatim
const STOP_WORDS = new Set([
  'i', 'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been',
  'being', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'need', 'want', 'like', 'just',
  'also', 'very', 'too', 'so', 'if', 'then', 'than', 'that', 'this', 'these',
  'those', 'it', 'its', 'my', 'your', 'our', 'we', 'he', 'she', 'they', 'me',
  'you', 'us', 'no', 'not', 'nor', 'about', 'into', 'over', 'after', 'before',
  'between', 'under', 'above', 'below', 'out', 'off', 'up', 'down', 'how',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'all', 'any', 'each',
  'every', 'both', 'few', 'more', 'most', 'some', 'such', 'only', 'own', 'same',
  'here', 'there', 'now', 'then', 'tell', 'show', 'find', 'look', 'read',
  'please', 'help', 'start', 'begin', 'first', 'next', 'last', 'finally',
  'step', 'through', 'across', 'along', 'around', 'back', 'because', 'been',
  'during', 'end', 'far', 'get', 'going', 'got', 'make', 'made', 'much',
  'must', 'never', 'once', 'other', 'quite', 'rather', 'really', 'still',
  'well', 'yet', 'investigate', 'search', 'examine', 'understand', 'explain',
  'describe', 'check', 'verify', 'confirm', 'ensure', 'guarantee', 'provide',
  'give', 'take', 'use', 'using', 'used', 'via', 'way', 'ways', 'thing',
  'things', 'something', 'anything', 'everything', 'nothing', 'does', 'done',
  'doing', 'going', 'gone', 'goes', 'came', 'come', 'coming', 'bring',
  'brings', 'brought', 'without', 'within', 'whether', 'while', 'whole',
  'though', 'think', 'thanks', 'thank', 'say', 'says', 'said', 'see', 'seen',
  'saw', 'know', 'known', 'knew', 'new', 'old', 'big', 'small', 'large',
  'long', 'short', 'high', 'low', 'good', 'bad', 'best', 'worst', 'better',
  'worse', 'every', 'each', 'either', 'neither', 'enough', 'else', 'ever',
  'always', 'usually', 'often', 'sometimes', 'rarely', 'seldom', 'already',
  'yet', 'just', 'about', 'almost', 'nearly', 'really', 'actually', 'pretty',
  'quite', 'rather', 'somewhat', 'total', 'completely', 'entirely',
  'absolutely', 'perfectly', 'fully', 'partially', 'partly', 'largely',
  'mainly', 'mostly', 'primarily', 'mainly', 'running', 'running',
  'walk', 'walking', 'walked', 'run', 'ran',
])

export async function investigateCodebase(
  query: string,
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Searching the codebase..." }))

  // Extract meaningful keywords: keep capitalized words, identifiers, and short technical terms
  const words = query
    .replace(/[^\w\s-]/g, ' ')      // replace punctuation with space (keep hyphens)
    .split(/\s+/)                     // split on whitespace
    .filter(Boolean)                 // remove empty
    .filter((w) => w.length > 2)     // remove 1-2 char words
    .filter((w) => !STOP_WORDS.has(w.toLowerCase())) // remove stop words
    .filter((w) => !/^\d+$/.test(w)) // remove pure numbers

  // Prioritize capitalized / CamelCase / snake_case / hyphenated terms (identifiers)
  const identifiers = words.filter((w) => /[A-Z]/.test(w) || /[-_]/.test(w) || /^\w+\.\w+$/.test(w))
  const remaining = words.filter((w) => !identifiers.includes(w))

  // Take up to 10 keywords total, prioritizing identifiers
  const keywords = [...identifiers, ...remaining].slice(0, 10)
  if (keywords.length === 0) {
    return "What specific code would you like me to investigate? Try mentioning a filename, component name, or contract address."
  }

  try {
    const pattern = keywords.join("|")
    let results: string
    try {
      results = execSync(
        `rg -l -i --engine auto "${pattern}" --type-add 'web:*.{ts,tsx,js,jsx,css,json}' --type web --glob '!node_modules' --glob '!.next' --glob '!public/codenomad' -m 5 2>/dev/null || true`,
        { cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 1024 * 1024 },
      )
    } catch {
      results = ""
    }

    const fileList = results.trim().split("\n").filter(Boolean).slice(0, 20)
    if (fileList.length === 0) return `No files found matching: ${keywords.join(", ")}`

    const previews: string[] = []
    for (const file of fileList.slice(0, 3)) {
      try {
        const content = execSync(`head -30 "${file}"`, { cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 1024 * 1024 })
        previews.push(`📄 ${file}:\n${content}`)
      } catch {
        previews.push(`📄 ${file}: (could not read)`)
      }
    }

    return [
      `Found ${fileList.length} files matching: ${keywords.join(", ")}`,
      "",
      ...fileList.map((f) => `- ${f}`),
      "",
      "--- Previews ---",
      "",
      ...previews,
    ].join("\n")
  } catch (err) {
    return `Error: ${(err as Error).message}`
  }
}

export async function generateFeature(
  prompt: string,
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Generating feature..." }))

  const filesCreated: string[] = []

  try {
    if (/page|route/i.test(prompt)) {
      const match = prompt.match(/(\w+)\s*page/i) || prompt.match(/add\s+(?:a\s+)?(\w+)/i)
      const pageName = match ? match[1].toLowerCase() : "new-feature"
      const dir = path.join(workspaceRoot, "src", "app", pageName)
      fs.mkdirSync(dir, { recursive: true })

      const pageContent = [
        "'use client'",
        "",
        `export default function ${pageName.charAt(0).toUpperCase() + pageName.slice(1)}Page() {`,
        "  return (",
        `    <div className="p-8">`,
        `      <h1 className="text-2xl font-bold text-white">${pageName.charAt(0).toUpperCase() + pageName.slice(1)}</h1>`,
        `      <p className="text-gray-400 mt-2">Generated by TokiDAPP Concierge</p>`,
        "    </div>",
        "  )",
        "}",
        "",
      ].join("\n")

      fs.writeFileSync(path.join(dir, "page.tsx"), pageContent)
      filesCreated.push(`src/app/${pageName}/page.tsx`)
    }

    if (/component/i.test(prompt)) {
      const match = prompt.match(/(\w+)\s*component/i) || prompt.match(/component\s+(\w+)/i)
      const compName = match ? match[1] : "GeneratedComponent"
      const compPascal = compName.charAt(0).toUpperCase() + compName.slice(1)

      const componentContent = [
        "'use client'",
        "",
        `export function ${compPascal}({ className = "" }: { className?: string }) {`,
        "  return (",
        `    <div className={\`p-4 rounded-xl border border-white/10 bg-white/5 \${className}\`}>`,
        `      <p className="text-gray-400">${compPascal}</p>`,
        "    </div>",
        "  )",
        "}",
        "",
      ].join("\n")

      const compDir = path.join(workspaceRoot, "src", "components")
      fs.mkdirSync(compDir, { recursive: true })
      fs.writeFileSync(path.join(compDir, `${compPascal}.tsx`), componentContent)
      filesCreated.push(`src/components/${compPascal}.tsx`)
    }

    if (filesCreated.length === 0) {
      return "Please be more specific. Try: 'Add a metrics page' or 'Create a Dashboard component'"
    }

    return [
      `Created ${filesCreated.length} file(s):`,
      "",
      ...filesCreated.map((f) => `- ${f}`),
      "",
      "Run `bun run type-check` to verify.",
    ].join("\n")
  } catch (err) {
    return `Error: ${(err as Error).message}`
  }
}

export async function runTests(
  workspaceRoot: string,
  send?: (msg: string) => void,
  timeout?: number,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Running tests..." }))

  try {
    const startTime = Date.now()
    let output: string
    try {
      output = execSync("bun run test 2>&1", {
        cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: timeout ?? 120000,
      })
    } catch (e: any) {
      output = e.stdout || e.message || "Test execution failed"
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    const passMatch = output.match(/(\d+)\s+passed/i)
    const failMatch = output.match(/(\d+)\s+failed/i)
    const passed = passMatch ? passMatch[1] : "?"
    const failed = failMatch ? failMatch[1] : "0"

    return [
      `Tests completed in ${duration}s`,
      `Passed: ${passed} | Failed: ${failed}`,
      failed !== "0" ? "Some tests failed." : "All tests passing!",
      "",
      "--- Last 20 lines ---",
      output.split("\n").slice(-20).join("\n"),
    ].join("\n")
  } catch (err) {
    return `Error: ${(err as Error).message}`
  }
}

export async function gitStatus(workspaceRoot: string): Promise<string> {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceRoot, encoding: "utf-8" }).trim()
    const status = execSync("git status --short", { cwd: workspaceRoot, encoding: "utf-8" }).trim()
    const log = execSync("git log --oneline -5", { cwd: workspaceRoot, encoding: "utf-8" }).trim()
    const filesChanged = status ? status.split("\n").length : 0

    return [
      `Branch: ${branch}`,
      `Uncommitted: ${filesChanged} file(s)`,
      status ? `\n${status}` : "\n   (clean)",
      "",
      "--- Recent commits ---",
      log,
    ].join("\n")
  } catch (err) {
    return `Error: ${(err as Error).message}`
  }
}

export async function gitCommitPush(
  commitMsg: string,
  workspaceRoot: string,
  starguardBase: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Committing changes..." }))

  try {
    const diff = await captureGitDiff(workspaceRoot)
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceRoot, encoding: "utf-8" }).trim()
    execSync("git add -A", { cwd: workspaceRoot, encoding: "utf-8" })
    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: workspaceRoot, encoding: "utf-8" })

    if (send) send(JSON.stringify({ type: "stream", delta: "Pushing to remote..." }))
    execSync(`git push origin ${branch}`, { cwd: workspaceRoot, encoding: "utf-8", timeout: 30000 })

    const hash = execSync("git rev-parse HEAD", { cwd: workspaceRoot, encoding: "utf-8" }).trim()

    // Store diff as blob if starguardBase configured
    try {
      await fetch(`${starguardBase}/api/tokidapp/deploy-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "store_diff",
          commitHash: hash,
          commitMsg,
          diff,
          branch,
        }),
      })
    } catch { /* non-critical */ }

    return `Committed and pushed: ${hash.slice(0, 7)} on ${branch}\n\nFiles changed:\n${diff}`
  } catch (err) {
    return `Git error: ${(err as Error).message}`
  }
}

export async function triggerVercelDeploy(
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Triggering Vercel deploy..." }))

  try {
    const output = execSync("vercel deploy --prod --yes 2>&1", {
      cwd: workspaceRoot,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 300000,
    })
    const urlMatch = output.match(/https:\/\/[^\s]+\.vercel\.app/)
    const url = urlMatch ? urlMatch[0] : "(see build output)"
    return `Deploy triggered. Preview: ${url}\n\nBuild output:\n${output.split("\n").slice(-10).join("\n")}`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Deploy error: ${msg}`
  }
}

export async function spawnAgent(
  prompt: string,
  starguardBase: string,
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Spawning agent workspace..." }))

  if (!starguardBase) return "StarGuard API not configured."

  // Parse agent type from prompt
  const agentType = prompt.includes("opencoder")
    ? "OPENCODER"
    : prompt.includes("openagent")
      ? "OPENAGENT"
      : prompt.includes("buildmate")
        ? "BUILDMATE"
        : "OPENCODE"

  const match = prompt.match(/in\s+([\w/-]+)/i)
  const workspacePath = match ? path.join(workspaceRoot, match[1]) : workspaceRoot

  try {
    const res = await fetch(`${starguardBase}/api/tokidapp/agents/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: `codenomad_${Date.now()}`,
        workspacePath,
        agentType,
        workspaceName: `Agent-${agentType}-${Date.now()}`,
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      return `Failed to spawn agent: ${err}`
    }

    const workspace = await res.json()
    return [
      `✅ **${agentType} agent spawned!**`,
      ``,
      `Workspace ID: \`${workspace.codenomadWorkspaceId || workspace.id}\``,
      workspace.codenomadProxyUrl ? `Proxy URL: ${workspace.codenomadProxyUrl}` : "",
      `Status: ${workspace.status}`,
      ``,
      `The agent is ready. Assign tasks to it using "assign task to <agent>".`,
    ].filter(Boolean).join("\n")
  } catch (err) {
    return `Error spawning agent: ${(err as Error).message}`
  }
}

export async function scheduleTask(
  prompt: string,
  starguardBase: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Creating scheduled task..." }))

  if (!starguardBase) return "StarGuard API not configured."

  // Parse task info from prompt
  const titleMatch = prompt.match(/(?:task|to)\s+[""]?([^""]+?)[""]?\s*(?:for|at|with|$)/i)
  const title = titleMatch ? titleMatch[1].trim() : prompt.replace(/schedule|create|add|task/gi, "").trim()
  const priorityMatch = prompt.match(/priority\s*[:\s]*(\d+)/i)
  const priority = priorityMatch ? parseInt(priorityMatch[1]) : 0

  // Parse scheduled time
  let scheduledFor: string | undefined
  const timeMatch = prompt.match(/(?:at|for)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/i) || prompt.match(/(?:at|for)\s+(\d{4}-\d{2}-\d{2})/i)
  if (timeMatch) scheduledFor = timeMatch[1]

  // Parse agent type
  const agentType = prompt.includes("opencoder")
    ? "OPENCODER" : prompt.includes("openagent")
      ? "OPENAGENT" : "OPENCODE"

  // Parse assignee
  const assignMatch = prompt.match(/(?:assign|to|for)\s+user\s+(\S+@\S+)/i)
  const assignedToUserId = assignMatch ? assignMatch[1] : undefined

  try {
    const body: Record<string, unknown> = {
      sessionId: `codenomad_${Date.now()}`,
      title,
      agentType,
      priority,
    }
    if (scheduledFor) body.scheduledFor = scheduledFor
    if (assignedToUserId) body.assignedToUserId = assignedToUserId

    const res = await fetch(`${starguardBase}/api/tokidapp/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      return `Failed to schedule task: ${err}`
    }

    const task = await res.json()
    return [
      `✅ **Task scheduled!**`,
      ``,
      `Title: ${task.title}`,
      `ID: \`${task.id}\``,
      `Agent: ${task.agentType}`,
      `Priority: ${task.priority}`,
      scheduledFor ? `Scheduled: ${scheduledFor}` : "Status: PENDING (no schedule set)",
      assignedToUserId ? `Assigned to: ${assignedToUserId}` : "",
      ``,
      `Use "list tasks" to see all scheduled tasks.`,
    ].filter(Boolean).join("\n")
  } catch (err) {
    return `Error scheduling task: ${(err as Error).message}`
  }
}

export async function listTasks(
  filter: string,
  starguardBase: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Fetching tasks..." }))

  if (!starguardBase) return "StarGuard API not configured."

  try {
    const params = new URLSearchParams()
    if (filter.includes("pending")) params.set("status", "PENDING")
    else if (filter.includes("assigned")) params.set("status", "ASSIGNED")
    else if (filter.includes("in progress")) params.set("status", "IN_PROGRESS")
    else if (filter.includes("complete")) params.set("status", "COMPLETED")

    const res = await fetch(`${starguardBase}/api/tokidapp/tasks?${params}`, {
      headers: { "Content-Type": "application/json" },
    })

    if (!res.ok) return "Could not fetch tasks."
    const tasks: any[] = await res.json()

    if (tasks.length === 0) return "No tasks found."

    return [
      `📋 **${tasks.length} task(s)**`,
      "",
      ...tasks.map((t, i) =>
        `**${i + 1}. ${t.title}**` +
        `\n   Status: ${t.status} | Agent: ${t.agentType} | Priority: ${t.priority}` +
        (t.assignedToUserId ? `\n   Assigned to: \`${t.assignedToUserId}\`` : "") +
        (t.scheduledFor ? `\n   Scheduled: ${new Date(t.scheduledFor).toISOString()}` : "") +
        (t.resultSummary ? `\n   Result: ${t.resultSummary}` : ""),
      ),
    ].join("\n")
  } catch (err) {
    return `Error listing tasks: ${(err as Error).message}`
  }
}

export async function assignTask(
  prompt: string,
  starguardBase: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Assigning task..." }))

  if (!starguardBase) return "StarGuard API not configured."

  // Parse task ID and assignee
  const taskIdMatch = prompt.match(/task\s+(\S+)/i)
  const userMatch = prompt.match(/(?:to|user)\s+(\S+@\S+|\S+)/i)

  if (!taskIdMatch) return "Please specify a task ID. Example: assign task abc123 to user@example.com"
  if (!userMatch) return "Please specify a user. Example: assign task abc123 to user@example.com"

  const taskId = taskIdMatch[1]
  const assignee = userMatch[1]

  try {
    const res = await fetch(`${starguardBase}/api/tokidapp/tasks/${taskId}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedToUserId: assignee }),
    })

    if (!res.ok) {
      const err = await res.text()
      return `Failed to assign task: ${err}`
    }

    const task = await res.json()
    return [
      `✅ **Task assigned!**`,
      ``,
      `Task: ${task.title}`,
      `Assigned to: ${assignee}`,
      `Status: ${task.status}`,
    ].join("\n")
  } catch (err) {
    return `Error assigning task: ${(err as Error).message}`
  }
}

export async function rollbackDeploy(send?: (msg: string) => void): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Rolling back to previous commit..." }))

  const result = await rollbackToPreviousCommit(true)
  if (!result.success) {
    return `Rollback error: ${result.error}`
  }

  return [
    `⏪ **Rolled back to:** ${result.previousHash}`,
    `Previous commit: ${result.previousMsg}`,
    "",
    "Redeploy triggered.",
  ].join("\n")
}

// ── Accessibility Testing Tools ──────────────────────────────────

export async function runA11yAudit(
  url: string,
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Running accessibility audit..." }))

  try {
    const output = execSync(
      `npx lighthouse "${url}" --quiet --output=json --only-categories=accessibility --chrome-flags="--headless --no-sandbox" 2>/dev/null || true`,
      { cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 60000 },
    )

    // Parse the lighthouse JSON output
    const match = output.match(/\{[^]*\}/)
    if (!match) return "Could not parse lighthouse output. Try running from a directory with a package.json."
    
    const data = JSON.parse(match[0])
    const a11y = data?.categories?.accessibility
    if (!a11y) return "Accessibility audit did not return results."

    const score = Math.round((a11y.score ?? 0) * 100)
    const audits = data?.audits || {}
    const failedAudits: string[] = []

    for (const [key, audit] of Object.entries(audits) as [string, any][]) {
      if (audit.score !== null && audit.score < 1 && audit.score !== undefined) {
        failedAudits.push(`- ${audit.title}: ${audit.description?.split(".")[0] || "issue found"}`)
      }
    }

    return [
      `**Accessibility Score: ${score}/100**`,
      score >= 90 ? "✅ Great! Passes accessibility guidelines." :
      score >= 50 ? "⚠️ Needs improvement." :
      "❌ Significant accessibility issues found.",
      "",
      failedAudits.length > 0
        ? `Issues found (${failedAudits.length}):\n${failedAudits.slice(0, 15).join("\n")}${failedAudits.length > 15 ? `\n... and ${failedAudits.length - 15} more` : ""}`
        : "No critical issues detected.",
    ].join("\n")
  } catch (err) {
    return `Accessibility audit error: ${(err as Error).message}. Ensure lighthouse is available via npx.`
  }
}

export async function checkA11yScan(
  url: string,
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Scanning for accessibility violations..." }))

  try {
    const output = execSync(
      `npx axe "${url}" --show-errors 2>/dev/null || true`,
      { cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
    )

    // Parse axe JSON output (look for JSON block)
    const jsonMatch = output.match(/\{"violations":\[[\s\S]*?"inapplicable":\[[\s\S]*?\]\}/)
    if (!jsonMatch) return "Axe scan did not return results. Try: npx axe <url>"

    const data = JSON.parse(jsonMatch[0])
    const violations = data.violations || []
    const passes = data.passes || []
    const incomplete = data.incomplete || []

    if (violations.length === 0) {
      return [
        "✅ **No accessibility violations found!**",
        `Passed ${passes.length} checks.`,
        incomplete.length > 0 ? `${incomplete.length} items need manual review.` : "",
      ].filter(Boolean).join("\n")
    }

    const summary = violations.map((v: any) =>
      `- **${v.impact.toUpperCase()}**: ${v.help} (${v.nodes.length} nodes)\n  ${v.helpUrl || ""}`
    )

    return [
      `**${violations.length} violation(s) found**`,
      "",
      ...summary,
      "",
      `Passed: ${passes.length} | Incomplete: ${incomplete.length} | Violations: ${violations.length}`,
    ].join("\n")
  } catch (err) {
    return `Axe scan error: ${(err as Error).message}. Install with: npx axe`
  }
}

export async function checkColorContrast(
  filePath: string,
  workspaceRoot: string,
): Promise<string> {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath)
  if (!fs.existsSync(fullPath)) return `File not found: ${filePath}`

  try {
    const content = fs.readFileSync(fullPath, "utf-8")

    // Extract hex/rgb color pairs from common patterns
    const colorPatterns = [
      ...content.matchAll(/(?:color|background|background-color|border-color|outline-color)\s*:\s*([^;]+)/gi),
    ]

    const colors = new Set<string>()
    for (const [, value] of colorPatterns) {
      const hexMatch = value.match(/#([0-9a-fA-F]{3,8})\b/g)
      if (hexMatch) hexMatch.forEach((c) => colors.add(c))
      const rgbMatch = value.match(/rgb[a]?\([^)]+\)/g)
      if (rgbMatch) rgbMatch.forEach((c) => colors.add(c))
    }

    if (colors.size < 2) {
      return `Found ${colors.size} color(s) in ${path.basename(fullPath)}. Need at least 2 for contrast checking.\nColors: ${Array.from(colors).join(", ")}`
    }

    return [
      `**Color Contrast Check**: ${path.basename(fullPath)}`,
      `Found ${colors.size} color value(s).`,
      "",
      "For manual contrast check:",
      "- Use https://webaim.org/resources/contrastchecker/",
      "- Normal text (AA): 4.5:1 | Large text (AA): 3:1 | AAA: 7:1",
      "",
      `Detected colors:\n${Array.from(colors).map((c) => `  - ${c}`).join("\n")}`,
    ].join("\n")
  } catch (err) {
    return `Color contrast check error: ${(err as Error).message}`
  }
}

// ── Read File ────────────────────────────────────────────────────

export async function readFileContent(
  filePath: string,
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath)
  if (!fs.existsSync(fullPath)) return `File not found: ${filePath}`
  
  try {
    const stat = fs.statSync(fullPath)
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(fullPath)
      return [
        `📁 **${filePath}/** (directory, ${entries.length} entries)`,
        "",
        ...entries.map((e) => {
          const isDir = fs.statSync(path.join(fullPath, e)).isDirectory()
          return `${isDir ? "📁" : "📄"} ${e}${isDir ? "/" : ""}`
        }),
      ].join("\n")
    }

    const content = fs.readFileSync(fullPath, "utf-8")
    const lines = content.split("\n")
    
    // Truncate very large files
    const maxLines = 200
    const truncated = lines.length > maxLines
    const display = truncated ? lines.slice(0, maxLines) : lines

    if (send) send(JSON.stringify({ type: "stream", delta: `Reading ${path.basename(fullPath)} (${display.length} of ${lines.length} lines)...` }))

    return [
      `📄 **${filePath}** (${lines.length} lines, ${(stat.size / 1024).toFixed(1)}KB)`,
      "",
      "```",
      ...display,
      truncated ? `... (${lines.length - maxLines} more lines. Use a more specific search to narrow down.)` : "",
      "```",
    ].filter(Boolean).join("\n")
  } catch (err) {
    return `Error reading file: ${(err as Error).message}`
  }
}

// ── Lint & TypeScript ────────────────────────────────────────────

export async function runLint(
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Running linter..." }))

  try {
    let output: string
    try {
      output = execSync("bun run lint 2>&1 || true", {
        cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 60000,
      })
    } catch (e: any) {
      output = e.stdout || e.message || "Lint execution failed"
    }

    const lines = output.split("\n").filter(Boolean)
    const errorCount = lines.filter((l) => l.includes("error")).length
    const warningCount = lines.filter((l) => l.includes("warning")).length

    return [
      `**Lint Results**`,
      `Errors: ${errorCount} | Warnings: ${warningCount}`,
      errorCount + warningCount === 0 ? "✅ Clean!" : "",
      "",
      ...lines.slice(-30),
    ].filter(Boolean).join("\n")
  } catch (err) {
    return `Lint error: ${(err as Error).message}`
  }
}

export async function runTypeCheck(
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Running TypeScript type check..." }))

  try {
    const startTime = Date.now()
    let output: string
    
    // Try bun first, fall back to npx tsc
    try {
      output = execSync("bun run type-check 2>&1 || bunx tsc --noEmit 2>&1 || npx --yes tsc --noEmit 2>&1", {
        cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 120000,
      })
    } catch (e: any) {
      output = e.stdout || e.message || "Type check failed"
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    const errorMatch = output.match(/Found\s+(\d+)\s+error/i) || output.match(/(\d+)\s+error/i)
    const errors = errorMatch ? parseInt(errorMatch[1]) : 0

    const clean = output.includes(" TS") === false || output.trim() === ""
    
    return [
      `**TypeScript Type Check** (${duration}s)`,
      errors > 0 ? `Found ${errors} type error(s).` : "✅ No type errors!",
      "",
      ...(errors > 0 ? output.split("\n").slice(-20) : []),
    ].join("\n")
  } catch (err) {
    return `Type check error: ${(err as Error).message}`
  }
}

// ── Git Branch ───────────────────────────────────────────────────

export async function gitBranchAction(
  action: string,
  branchName: string | undefined,
  workspaceRoot: string,
): Promise<string> {
  try {
    switch (action) {
      case "list": {
        const branches = execSync("git branch", { cwd: workspaceRoot, encoding: "utf-8" })
        const current = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceRoot, encoding: "utf-8" }).trim()
        return [
          `**Branches** (current: ${current})`,
          "",
          branches.split("\n").map((b) => b.trim()).filter(Boolean).map((b) =>
            b.startsWith("*") ? `* **${b.slice(2)}**` : `  ${b}`
          ).join("\n"),
        ].join("\n")
      }

      case "create": {
        if (!branchName) return "Branch name required for create action."
        execSync(`git checkout -b "${branchName}"`, { cwd: workspaceRoot, encoding: "utf-8" })
        return `✅ Created and switched to branch: \`${branchName}\``
      }

      case "switch": {
        if (!branchName) return "Branch name required for switch action."
        execSync(`git checkout "${branchName}"`, { cwd: workspaceRoot, encoding: "utf-8" })
        return `✅ Switched to branch: \`${branchName}\``
      }

      case "delete": {
        if (!branchName) return "Branch name required for delete action."
        execSync(`git branch -d "${branchName}"`, { cwd: workspaceRoot, encoding: "utf-8" })
        return `✅ Deleted branch: \`${branchName}\``
      }

      default:
        return `Unknown git branch action: ${action}. Supported: list, create, switch, delete`
    }
  } catch (err) {
    return `Git branch error: ${(err as Error).message}`
  }
}

// ── Vision (Image Analysis) ─────────────────────────────────────

/** Analyze an image using OpenAI gpt-4o vision. Accepts a direct URL
 *  (Vercel Blob URL or any public image URL). Returns a text description
 *  of what's in the image — usable by the concierge to answer questions
 *  about user-uploaded screenshots, diagrams, logos, etc. */
export async function visionAnalyze(imageUrl: string, prompt?: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return "Vision analysis requires OPENAI_API_KEY."

  const userPrompt = prompt?.trim()
    ? prompt
    : "Describe this image in detail. What do you see? Include colors, objects, text, layout, and any notable elements."

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              { type: "image_url", image_url: { url: imageUrl, detail: "auto" } },
            ],
          },
        ],
        max_tokens: 1024,
      }),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      return `Vision API error (${res.status}): ${errBody.slice(0, 200)}`
    }

    const data = await res.json()
    const content: string = data?.choices?.[0]?.message?.content || "(no description generated)"
    return content.slice(0, 4000)
  } catch (err) {
    return `Vision analysis failed: ${(err as Error).message}`
  }
}

// ── Mermaid Diagram Generation ───────────────────────────────────

/** Generate Mermaid diagram source code from a text description.
 *  Uses gpt-4o-mini to produce valid Mermaid syntax. The caller can
 *  render the returned source on the client using the Mermaid library.
 *  Returns the Mermaid code block (without markdown fences). */
export async function generateMermaidDiagram(
  description: string,
  diagramType?: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return "Mermaid generation requires OPENAI_API_KEY."

  const typeHint = diagramType?.trim()
    ? ` Use diagram type: ${diagramType}.`
    : " Choose the most appropriate diagram type (flowchart, sequence, class, state, gantt, pie, gitgraph, erDiagram, quadrantChart, timeline, etc.)."

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a Mermaid diagram expert. Generate valid Mermaid.js source code based on the user's description. " +
              "Follow these rules strictly:\n" +
              "1. Output ONLY the Mermaid source code — no explanations, no markdown fences (no ```), no extra text.\n" +
              "2. Use correct Mermaid syntax for the chosen diagram type.\n" +
              "3. Keep node labels short and meaningful.\n" +
              "4. For flowcharts, use graph TD or graph LR.\n" +
              "5. For sequence diagrams, use sequenceDiagram with proper participant/actor syntax.\n" +
              "6. For class diagrams, use classDiagram with proper class/relationship syntax.\n" +
              "7. Do NOT use any stylings that require Mermaid configuration directives unless essential.\n" +
              "8. If the description is ambiguous, choose the best diagram type and make reasonable assumptions.",
          },
          {
            role: "user",
            content: `Generate a Mermaid diagram for: ${description}.${typeHint}`,
          },
        ],
        max_tokens: 1024,
        temperature: 0.3,
      }),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      return `Mermaid generation error (${res.status}): ${errBody.slice(0, 200)}`
    }

    const data = await res.json()
    const content: string = data?.choices?.[0]?.message?.content || ""
    // Strip any markdown fences the model might add despite instructions
    const cleaned = content.replace(/^```(?:mermaid)?\s*\n?/gm, "").replace(/```\s*$/gm, "").trim()
    if (!cleaned) return "(no diagram generated)"
    return cleaned
  } catch (err) {
    return `Mermaid generation failed: ${(err as Error).message}`
  }
}

// ── File Generation ─────────────────────────────────────────

// Server public/generated directory — resolved relative to this file's location
// so it works regardless of process.cwd().
// Source: packages/server/src/plugins/tokidapp/concierge/codebase-tools.ts
// 6 levels up → packages/ (root of CodeNomad monorepo)
const CODENOMAD_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "..")
const GENERATED_FILES_DIR = path.resolve(CODENOMAD_ROOT, "public", "generated")
const GENERATED_FILES_BASE = `/api/tokidapp/files/generated`
/** Public tunnel URL — used to build fully-qualified download URLs.
 *  Falls back to the CodeNomad tunnel hostname. */
const TUNNEL_PUBLIC_URL = (process.env.TUNNEL_PUBLIC_URL || "https://codenomad.tokenizin.com").replace(/\/+$/, "")

/** Upload a file buffer to Vercel Blob using direct REST API.
 *  The StarWorld blob store is private — uses access: 'private' and
 *  returns a Vercel Blob URL that can be served via the /api/tokidapp/files/proxy
 *  endpoint. Falls back to null if Blob upload is unavailable.
 *  Requires BLOB_READ_WRITE_TOKEN env var. */
async function uploadToVercelBlob(
  fileBuffer: Buffer,
  fileName: string,
  contentType: string,
): Promise<string | null> {
  const token = process.env.BLOB_READ_WRITE_TOKEN
  if (!token) return null

  try {
    // Vercel Blob REST API — private access is the default when 'access' is omitted
    const res = await fetch("https://api.vercel.com/v1/blob/upload", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: [{ data: fileBuffer.toString("base64"), filename: fileName, content_type: contentType }],
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    // Private store returns a URL that requires a token to read directly.
    // We still return it so the proxy endpoint can serve it.
    return data?.url || data?.blobUrl || data?.blobs?.[0]?.url || null
  } catch {
    return null
  }
}

/** Generate a downloadable file from Mermaid source or other content.
 *
 *  Supported types:
 *  - "mermaid_svg": Renders Mermaid source to SVG and saves it as a file.
 *    Returns a downloadable URL and file metadata.
 *  - "document": Creates a text document file.
 *  - "code": Creates a code snippet file.
 *
 *  The function:
 *  1. Writes the file to the local generated directory
 *  2. Attempts to upload to Vercel Blob (if BLOB_READ_WRITE_TOKEN is set)
 *  3. Returns a fully-qualified HTTPS URL + markdown-wrapped content for chat rendering
 */
export async function generateFile(options: {
  type: "mermaid_svg" | "document" | "code"
  content: string
  fileName?: string
  title?: string
}): Promise<{
  url: string
  fileName: string
  fileSize: number
  mimeType: string
  content: string
  /** Markdown-wrapped content suitable for inline chat rendering.
   *  For mermaid_svg: wraps in ```mermaid block.
   *  For documents/code: wraps in ``` block with appropriate language tag. */
  markdownContent: string
}> {
  const { type, content, title } = options
  const timestamp = Date.now()
  const safeTitle = (title || "file").replace(/[^a-zA-Z0-9_-]/g, "_")
  const sanitized = content.replace(/^```(?:mermaid|svg|typescript|javascript|python|solidity|bash)?\s*\n?/gm, "").replace(/```\s*$/gm, "").trim()

  let fileName: string
  let mimeType: string
  let fileContent: string
  let languageTag: string

  switch (type) {
    case "mermaid_svg": {
      fileName = `${safeTitle}-${timestamp}.mmd`
      mimeType = "text/plain"
      fileContent = sanitized
      languageTag = "mermaid"
      break
    }
    case "document": {
      fileName = options.fileName || `${safeTitle}-${timestamp}.txt`
      mimeType = "text/plain"
      fileContent = sanitized
      languageTag = ""
      break
    }
    case "code": {
      const ext = options.fileName?.includes(".") ? options.fileName.split(".").pop() : "txt"
      fileName = options.fileName || `${safeTitle}-${timestamp}.${ext}`
      mimeType = "text/plain"
      fileContent = sanitized
      languageTag = ext === "txt" ? "" : ext || ""
      break
    }
    default:
      fileName = `${safeTitle}-${timestamp}.txt`
      mimeType = "text/plain"
      fileContent = sanitized
      languageTag = ""
  }

  // Ensure generated directory exists
  fs.mkdirSync(GENERATED_FILES_DIR, { recursive: true })

  // Write the file locally (always — for local serving fallback)
  const filePath = path.join(GENERATED_FILES_DIR, fileName)
  fs.writeFileSync(filePath, fileContent, "utf-8")
  const stat = fs.statSync(filePath)
  const fileBuffer = Buffer.from(fileContent, "utf-8")

  // Attempt to upload to Vercel Blob for a persistent, globally-accessible URL
  let publicUrl: string | null = null
  try {
    publicUrl = await uploadToVercelBlob(fileBuffer, fileName, mimeType)
  } catch {
    // Non-fatal — fall through to tunnel URL
  }

  // Use the tunnel URL as primary (always accessible, no auth required).
  // Blob URL (if available) is used for fallback via proxy endpoint.
  const primaryUrl = `${TUNNEL_PUBLIC_URL}${GENERATED_FILES_BASE}/${fileName}`
  const finalUrl = publicUrl || primaryUrl

  // Build markdown-wrapped content for inline chat rendering
  // Always use the tunnel URL in the download link (it's directly accessible)
  const downloadLine = `📎 [Download ${fileName}](${primaryUrl})`
  let markdownContent: string

  if (type === "mermaid_svg") {
    markdownContent = `\`\`\`mermaid\n${fileContent}\n\`\`\`\n\n---\n${downloadLine}`
  } else if (languageTag) {
    markdownContent = `\`\`\`${languageTag}\n${fileContent}\n\`\`\`\n\n---\n${downloadLine}`
  } else {
    markdownContent = `${fileContent}\n\n---\n${downloadLine}`
  }

  return {
    url: finalUrl,
    fileName,
    fileSize: stat.size,
    mimeType,
    content: fileContent,
    markdownContent,
  }
}

/** Upload a generated file to Vercel Blob and return a proxy URL.
 *  Requires BLOB_READ_WRITE_TOKEN to be set. Falls back to local URL
 *  if Blob token is not available.
 *  @deprecated Use generateFile() which handles Blob upload automatically. */
export async function uploadGeneratedFile(filePath: string): Promise<{
  url: string
  fileName: string
  fileSize: number
  mimeType: string
}> {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN
  if (!blobToken) {
    // Fallback: local file path
    const fileName = path.basename(filePath)
    const stat = fs.statSync(filePath)
    return { url: `${GENERATED_FILES_BASE}/${fileName}`, fileName, fileSize: stat.size, mimeType: "application/octet-stream" }
  }

  try {
    const fileBuffer = fs.readFileSync(filePath)
    const fileName = path.basename(filePath)
    const blob = await fetch("https://api.vercel.com/v1/blob/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${blobToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: [{ data: fileBuffer.toString("base64"), filename: fileName }],
      }),
    })

    if (!blob.ok) {
      throw new Error(`Blob upload failed: ${blob.status}`)
    }

    const data = await blob.json()
    const blobUrl = data?.url || data?.blobUrl || data?.blobs?.[0]?.url || ""

    if (!blobUrl) {
      throw new Error("No URL returned from Blob upload")
    }

    const stat = fs.statSync(filePath)
    return { url: blobUrl, fileName, fileSize: stat.size, mimeType: "application/octet-stream" }
  } catch {
    // Fallback to local path
    const fileName = path.basename(filePath)
    const stat = fs.statSync(filePath)
    return { url: `${GENERATED_FILES_BASE}/${fileName}`, fileName, fileSize: stat.size, mimeType: "application/octet-stream" }
  }
}

// ── Web Search ────────────────────────────────────────────

/** Known venue official websites for site-restricted member searches.
 *  Members searching for venue info will be restricted to these domains.
 *  Admins can search all sites. Add new venue domains here as they onboard. */
const VENUE_SEARCH_DOMAINS: string[] = [
  "redrubyclub.com",
  "tokenizin.com",
  "starworksglobal.com",
  // Add new venue domains below:
  // "example-venue.com",
]

/** Perform a web search using Tavily Search API (AI-optimized, 1000 free queries/month).
 *  Requires TAVILY_API_KEY env var. Get one free at https://tavily.com
 *  Returns a text summary of up to 10 search results with titles, snippets, and URLs.
 *
 *  @param query - The search query
 *  @param numResults - Results to return (1-10, default 5)
 *  @param sites - Search scope: "all" (unrestricted, default), "venues" (venue official sites only),
 *                 or a comma-separated list of domains. Members should use "venues" for venue-related queries. */
export async function googleSearch(
  query: string,
  numResults: number = 5,
  sites?: "all" | "venues" | string,
): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) {
    return "Web search requires TAVILY_API_KEY environment variable. Get a free key at https://tavily.com, add it to .env, and restart the server."
  }

  // Resolve include_domains based on sites parameter
  let includeDomains: string[] = []
  if (sites === "venues") {
    includeDomains = [...VENUE_SEARCH_DOMAINS]
  } else if (sites && sites !== "all") {
    // Custom comma-separated domain list
    includeDomains = sites.split(",").map(s => s.trim()).filter(Boolean)
  }
  // "all" or undefined = empty array = search everything

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: Math.min(Math.max(numResults, 1), 10),
        include_answer: false,
        include_domains: includeDomains,
        exclude_domains: [],
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      return `Web search API error (${res.status}): ${errText.slice(0, 200)}`
    }

    const data = await res.json()
    const results = data.results || []
    if (results.length === 0) return `No search results found for "${query}".`

    const scopeLabel = includeDomains.length > 0
      ? ` (searched within: ${includeDomains.join(", ")})`
      : " (all web)"
    const lines: string[] = [`**Search results for:** ${query}${scopeLabel}\n`]
    for (let i = 0; i < results.length; i++) {
      const item = results[i]
      const title = (item.title || "").trim()
      const snippet = (item.content || item.snippet || "").trim()
      const link = (item.url || "").trim()
      lines.push(`${i + 1}. **${title}**`)
      if (snippet) lines.push(`   ${snippet}`)
      if (link) lines.push(`   ${link}`)
      lines.push("")
    }
    return lines.join("\n").slice(0, 4000)
  } catch (err) {
    return `Web search failed: ${(err as Error).message}`
  }
}

// ── Wiki Tools ──────────────────────────────────────────────

// Server cwd is CodeNomad/; wiki lives in parent contracts/docs/starworld/
const WIKI_ROOT = path.resolve(process.cwd(), "../docs/starworld")
const WIKI_ENTITIES = path.join(WIKI_ROOT, "entities")

// Additional knowledge roots for expanded Realtime KB.
// Search/read flows iterate ALL roots (primary first, then fall through).
// Write/lint/health flows use ONLY WIKI_ROOT (primary vault).
const WIKI_ROOTS = [
  WIKI_ROOT,
  path.resolve(process.cwd(), "../.opencode/context/project-intelligence"),
  path.resolve(process.cwd(), "../docs/architecture/ecosystem"),
  "/Users/alexshapiro/Documents/Obsidian Vault",
]

/** Read a wiki entity page by name. Returns full markdown content.
 *  Searches primary root (vault) first, then falls through to additional
 *  knowledge roots (project-intelligence, ecosystem architecture). */
export async function readWikiPage(pageName: string): Promise<string> {
  const sanitizedName = pageName.replace(/[^\w\s-]/g, "").trim()

  // Build search candidates across all roots
  const candidates: string[] = []

  for (const root of WIKI_ROOTS) {
    // Direct match
    candidates.push(path.join(root, `${sanitizedName}.md`))

    // Sub-directory match (e.g. entities/{pageName}.md in vault)
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          candidates.push(path.join(root, entry.name, `${sanitizedName}.md`))
        }
      }
    } catch { /* skip unreadable */ }

    // Case-insensitive match in the root dir
    try {
      const files = fs.readdirSync(root)
      const match = files.find(f => f.replace(/\.md$/, "").toLowerCase() === sanitizedName.toLowerCase())
      if (match) candidates.push(path.join(root, match))
    } catch { /* skip */ }

    // Case-insensitive match in sub-directories
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        try {
          const subFiles = fs.readdirSync(path.join(root, entry.name))
          const subMatch = subFiles.find(f => f.replace(/\.md$/, "").toLowerCase() === sanitizedName.toLowerCase())
          if (subMatch) candidates.push(path.join(root, entry.name, subMatch))
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // Try all candidates (dedup by resolved path)
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    try {
      const content = fs.readFileSync(resolved, "utf-8")
      return `# ${sanitizedName}\n\n${content}`
    } catch { /* try next */ }
  }

  return `Wiki page "${pageName}" not found. Available pages can be found via search_wiki.`
}

/** Full-text search across all wiki knowledge roots.
 *  Returns matching pages with context, deduplicated by file basename.
 *  Primary root (vault) results appear first. */
export async function searchWiki(query: string): Promise<string> {
  if (!query?.trim()) return "Please provide a search term."

  const terms = query.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return "Please provide a search term."

  try {
    const pattern = terms.join("|")
    const allFiles: string[] = []
    const seenBasenames = new Set<string>()

    // Search each root — primary first
    for (const root of WIKI_ROOTS) {
      try {
        const result = execSync(
          `rg -l -i "${pattern}" "${root}" --glob '*.md' -m 10 2>/dev/null || true`,
          { encoding: "utf-8", maxBuffer: 1024 * 1024 },
        )
        const files = result.trim().split("\n").filter(Boolean)
        for (const file of files) {
          const basename = path.basename(file).toLowerCase()
          // Deduplicate by basename; prefer earlier root (primary first)
          if (!seenBasenames.has(basename)) {
            seenBasenames.add(basename)
            allFiles.push(file)
          }
        }
      } catch { /* skip unsearchable root */ }
    }

    if (allFiles.length === 0) return `No wiki pages found matching: ${query}`

    const previews: string[] = []
    for (const file of allFiles.slice(0, 8)) {
      try {
        const content = fs.readFileSync(file, "utf-8")
        // Determine the best display name: relative to any known root, else basename
        let name = path.basename(file).replace(/\.md$/, "")
        for (const root of WIKI_ROOTS) {
          if (file.startsWith(root)) {
            const rel = path.relative(root, file)
            name = rel.replace(/\.md$/, "").replace(/^.*[/\\]/, "")
            break
          }
        }

        // Extract frontmatter stableId if present
        const stableMatch = content.match(/stableId:\s*(.+)/)
        const stableId = stableMatch ? stableMatch[1].trim() : ""

        // Extract priority from HTML comment (project-intelligence style)
        const priorityMatch = content.match(/Priority:\s*(\w+)/i)
        const priority = priorityMatch ? priorityMatch[1].trim() : ""

        // Get first 3 lines of content after frontmatter
        const bodyLines = content.split("\n").filter(l => l.trim() && !l.startsWith("---")).slice(0, 3)
        const preview = bodyLines.join(" ").slice(0, 200)

        const tags = [stableId, priority].filter(Boolean).join(" · ")
        previews.push(`• ${name}${tags ? ` (${tags})` : ""}: ${preview}`)
      } catch { /* skip unreadable */ }
    }

    const sourceNote = " (vault · project-intelligence · ecosystem)"
    return [
      `Found ${allFiles.length} page(s) matching "${query}"${sourceNote}:`,
      "",
      ...previews,
      "",
      `Use read_wiki_page("pageName") to read a specific page.`,
    ].join("\n")
  } catch (err) {
    return `Wiki search failed: ${(err as Error).message}`
  }
}

/** Search the Obsidian vault via the local MCP server (http://127.0.0.1:5100).
 *  Falls back gracefully if the MCP server is not running. */
export async function searchObsidianVault(query: string): Promise<string> {
  if (!query?.trim()) return "Please provide a search term."

  try {
    const res = await fetch(`http://127.0.0.1:5100/vault/search/${encodeURIComponent(query.trim())}`)
    if (!res.ok) {
      if (res.status === 404) return `No Obsidian vault pages found matching: ${query}`
      return `Obsidian vault search unavailable (MCP server returned ${res.status}).`
    }
    const results: Array<{path: string; size: number}> = await res.json()
    if (!Array.isArray(results) || results.length === 0) {
      return `No Obsidian vault pages found matching: ${query}`
    }
    return [
      `Found ${results.length} page(s) in Obsidian vault matching "${query}":`,
      "",
      ...results.map(r => `• ${r.path} (${(r.size / 1024).toFixed(1)}KB)`),
      "",
      `Use read_obsidian_note("path/to/note.md") to read a specific note.`,
    ].join("\n")
  } catch {
    return "Obsidian vault search unavailable (MCP server not running). Start it with: .opencode/run_obsidian_mcp.sh"
  }
}

/** Read a specific note from the Obsidian vault via the MCP server. */
export async function readObsidianNote(notePath: string): Promise<string> {
  if (!notePath?.trim()) return "Please provide a note path (e.g. Dashboard/Live-Context/Live-Context.md)."

  try {
    const res = await fetch(`http://127.0.0.1:5100/vault/${encodeURIComponent(notePath.trim())}`)
    if (!res.ok) {
      if (res.status === 404) return `Obsidian note not found: ${notePath}`
      return `Could not read Obsidian note (MCP server returned ${res.status}).`
    }
    const data = await res.json()
    const fm = data.frontmatter || {}
    const fmSummary = Object.keys(fm).length > 0
      ? `\n\n**Frontmatter:** ${Object.entries(fm).map(([k,v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' | ')}`
      : ''
    return `# ${notePath}${fmSummary}\n\n${data.content || '(empty)'}`
  } catch {
    return "Obsidian vault unavailable (MCP server not running)."
  }
}

/** Get entity connections from wiki page wikilinks. */
export async function getEntityConnections(pageName: string): Promise<string> {
  const content = await readWikiPage(pageName)
  if (content.startsWith(`Wiki page "${pageName}" not found`)) return content

  const lines = content.split("\n")
  const sections: { heading: string; links: string[] }[] = []
  let currentSection: { heading: string; links: string[] } | null = null

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/)
    if (headingMatch) {
      if (currentSection) sections.push(currentSection)
      currentSection = { heading: headingMatch[1].trim(), links: [] }
      continue
    }

    if (currentSection) {
      const wikiLinks = [...line.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
      for (const match of wikiLinks) {
        currentSection.links.push(match[1].trim())
      }
    }
  }
  if (currentSection) sections.push(currentSection)

  const connectionSections = sections.filter(s =>
    s.heading.toLowerCase().includes("connected") ||
    s.heading.toLowerCase().includes("appears in") ||
    s.links.length > 0
  )

  if (connectionSections.length === 0) {
    return `No connections found for "${pageName}". This page may not have wikilinks.`
  }

  const output: string[] = [`Connections for "${pageName}":`]
  for (const section of connectionSections) {
    output.push(`\n## ${section.heading}`)
    for (const link of section.links) {
      output.push(`  → ${link}`)
    }
  }

  return output.join("\n")
}

/** Write or update a wiki page. Supports full overwrite or section-targeted update. */
export async function writeWiki(
  pageName: string,
  content: string,
  section?: string,
): Promise<string> {
  const sanitizedName = pageName.replace(/[^\w\s-]/g, "").trim()

  // Determine file path
  let filePath = path.join(WIKI_ENTITIES, `${sanitizedName}.md`)
  if (!fs.existsSync(filePath)) {
    filePath = path.join(WIKI_ROOT, `${sanitizedName}.md`)
  }

  if (section) {
    // Section-targeted update
    try {
      const existing = fs.readFileSync(filePath, "utf-8")
      const sectionRegex = new RegExp(
        `(## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n)([\\s\\S]*?)(?=\\n## |$)`,
        "i",
      )
      const match = existing.match(sectionRegex)
      if (!match) {
        return `Section "${section}" not found in page "${pageName}". The page exists but does not have a "## ${section}" heading.`
      }
      const updated = existing.replace(sectionRegex, `$1${content}\n`)
      fs.writeFileSync(filePath, updated, "utf-8")
      return `Updated section "${section}" in wiki page "${pageName}".`
    } catch {
      return `Could not update section "${section}" in "${pageName}". Page may not exist.`
    }
  } else {
    // Full page write
    try {
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(filePath, content, "utf-8")
      return `Wiki page "${pageName}" ${fs.existsSync(filePath) ? "updated" : "created"} successfully.`
    } catch (err) {
      return `Failed to write wiki page "${pageName}": ${(err as Error).message}`
    }
  }
}

// ── Wiki Health Lint ───────────────────────────────────────────

interface LintWikiResult {
  orphanPages: string[]
  brokenLinks: Array<{ from: string; link: string }>
  stalePages: Array<{ page: string; lastModified: string }>
  indexGaps: string[]
  summary: string
}

/** Recursively collect all .md files under a directory, relative to root. */
function collectVaultFiles(root: string, dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "_archive") continue
      collectVaultFiles(root, full, out)
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(path.relative(root, full))
    }
  }
  return out
}

/** Extract wikilink targets from a markdown string, returning {target, alias} pairs. */
function extractWikilinks(content: string): Array<{ target: string; alias?: string }> {
  return [...content.matchAll(/\[\[([^\]]+)\]\]/g)]
    .map((m) => {
      const raw = m[1].trim()
      const [target, ...aliasParts] = raw.split("|")
      const alias = aliasParts.length > 0 ? aliasParts.join("|").split("#")[0].trim() : undefined
      const t = target.split("#")[0].trim()
      return { target: t, alias: alias || undefined }
    })
    .filter((w) => w.target.length > 0)
}

/** Extract `stableId:` value from YAML frontmatter. */
function extractStableId(content: string): string | null {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fm) return null
  const m = fm[1].match(/^stableId:\s*(.+)$/m)
  return m ? m[1].trim() : null
}

/** Normalize a wikilink target to a comparable page name. Strips path prefix and .md suffix. */
function normalizeTarget(target: string): string {
  return target.replace(/\.md$/, "").replace(/^.*\//, "")
}

/** Scan the Obsidian wiki for orphans, broken links, and stale pages. */
export async function lintWiki(): Promise<string> {
  try {
    if (!fs.existsSync(WIKI_ROOT)) {
      return JSON.stringify({ orphanPages: [], brokenLinks: [], stalePages: [], indexGaps: [], summary: "Wiki root not found." })
    }

    // Collect all .md files in the vault
    const relFiles = collectVaultFiles(WIKI_ROOT, WIKI_ROOT)
    if (relFiles.length === 0) {
      return JSON.stringify({ orphanPages: [], brokenLinks: [], stalePages: [], indexGaps: [], summary: "No markdown files found." })
    }

    // Build lookup sets:
    // - existingPages: full relative path without .md (e.g. "entities/RevenuePool")
    // - existingPageNames: just the trailing name (e.g. "RevenuePool") for display-name matching
    // - stableIdToPage: stableId (e.g. "SC.contract.RevenuePool") → page name
    const existingPages = new Set<string>()
    const existingPageNames = new Set<string>()
    const stableIdToPage = new Map<string, string>()
    for (const rel of relFiles) {
      const noExt = rel.replace(/\.md$/, "")
      existingPages.add(noExt)
      const trailing = noExt.split("/").pop()!
      existingPageNames.add(trailing)
      try {
        const content = fs.readFileSync(path.join(WIKI_ROOT, rel), "utf-8")
        const stableId = extractStableId(content)
        if (stableId) stableIdToPage.set(stableId, noExt)
      } catch { /* skip */ }
    }

    /** True if a wikilink target resolves to an existing page. */
    const pageExists = (target: string): boolean => {
      if (existingPages.has(target)) return true
      if (existingPageNames.has(normalizeTarget(target))) return true
      return false
    }

    /** Resolve a wikilink (target + optional alias) to a canonical page-name or null. */
    const resolveLink = (link: { target: string; alias?: string }): string | null => {
      // 1. Exact page path match
      if (existingPages.has(link.target)) return link.target
      // 2. Trailing-name match
      if (existingPageNames.has(normalizeTarget(link.target))) {
        return pageNameByName(normalizeTarget(link.target), relFiles)
      }
      // 3. StableId match (the alias often holds the stableId)
      if (link.alias && stableIdToPage.has(link.alias)) {
        return stableIdToPage.get(link.alias)!
      }
      // 4. The target itself may be a stableId
      if (stableIdToPage.has(link.target)) {
        return stableIdToPage.get(link.target)!
      }
      return null
    }

    const inboundLinks = new Map<string, string[]>()  // page-name → sources
    const outboundLinks = new Map<string, string[]>()  // page-name → targets
    const pageDates = new Map<string, string>()  // page-name → last modified

    // Parse every vault file
    for (const rel of relFiles) {
      const pageName = rel.replace(/\.md$/, "")
      const abs = path.join(WIKI_ROOT, rel)
      const content = fs.readFileSync(abs, "utf-8")

      const links = extractWikilinks(content)
      const resolvedTargets: string[] = []
      for (const link of links) {
        const canonical = resolveLink(link)
        if (canonical) {
          resolvedTargets.push(canonical)
          if (!inboundLinks.has(canonical)) inboundLinks.set(canonical, [])
          if (!inboundLinks.get(canonical)!.includes(pageName)) {
            inboundLinks.get(canonical)!.push(pageName)
          }
        } else {
          // Unresolved — record raw target for broken-link report
          resolvedTargets.push(link.target)
        }
      }
      outboundLinks.set(pageName, links.map((l) => l.target))

      // Stale detection via file mtime
      try {
        const stat = fs.statSync(abs)
        pageDates.set(pageName, stat.mtime.toISOString().split("T")[0])
      } catch { /* skip */ }
    }

    // Orphan pages: entity files (entities/*) that have no inbound links
    const entityFiles = relFiles.filter((f) => f.startsWith("entities/"))
    const orphanPages = entityFiles
      .map((f) => f.replace(/\.md$/, ""))
      .filter((name) => !inboundLinks.has(name) || inboundLinks.get(name)!.length === 0)

    // Broken links: outbound links that don't resolve via any lookup strategy
    const brokenLinks: Array<{ from: string; link: string }> = []
    for (const rel of relFiles) {
      const pageName = rel.replace(/\.md$/, "")
      const content = fs.readFileSync(path.join(WIKI_ROOT, rel), "utf-8")
      const links = extractWikilinks(content)
      for (const link of links) {
        if (!resolveLink(link)) {
          brokenLinks.push({ from: pageName, link: link.target })
        }
      }
    }

    // Stale pages: entity files not modified in 90 days
    const staleDays = 90
    const cutoff = Date.now() - staleDays * 86_400_000
    const stalePages: Array<{ page: string; lastModified: string }> = []
    for (const [page, dateStr] of pageDates) {
      if (!page.startsWith("entities/")) continue
      if (new Date(dateStr).getTime() < cutoff) {
        stalePages.push({ page, lastModified: dateStr })
      }
    }

    // Index gaps: wikilinks in Index.md that don't resolve to any page
    const indexGaps: string[] = []
    const indexPath = path.join(WIKI_ROOT, "Index.md")
    if (fs.existsSync(indexPath)) {
      const indexContent = fs.readFileSync(indexPath, "utf-8")
      const indexLinks = extractWikilinks(indexContent)
      const seen = new Set<string>()
      for (const link of indexLinks) {
        if (!resolveLink(link) && !seen.has(link.target)) {
          indexGaps.push(link.target)
          seen.add(link.target)
        }
      }
    }

    const result: LintWikiResult = {
      orphanPages,
      brokenLinks,
      stalePages,
      indexGaps,
      summary: [
        orphanPages.length ? `${orphanPages.length} orphan(s)` : null,
        brokenLinks.length ? `${brokenLinks.length} broken link(s)` : null,
        stalePages.length ? `${stalePages.length} stale page(s)` : null,
        indexGaps.length ? `${indexGaps.length} index gap(s)` : null,
      ].filter(Boolean).join(", ") || "All clear",
    }

    return JSON.stringify(result)
  } catch (err) {
    return JSON.stringify({ error: `Lint failed: ${(err as Error).message}` })
  }
}

/** Helper: given a display name, return the full page path of the first match. */
function pageNameByName(name: string, relFiles: string[]): string {
  for (const rel of relFiles) {
    const noExt = rel.replace(/\.md$/, "")
    if (noExt.split("/").pop() === name) return noExt
  }
  return name
}

// ── Sepolia Deployments ──────────────────────────────────────────

/** Return known Sepolia testnet contract addresses for the StarCARD ecosystem. */
export async function getSepoliaDeployments(): Promise<string> {
  try {
    const filePath = path.join(__dirname, "../../../../../src/data/sepolia-deployments.ts")
    const absPath = path.resolve(filePath)
    if (!fs.existsSync(absPath)) {
      return "Sepolia deployments file not found."
    }
    const content = fs.readFileSync(absPath, "utf-8")
    // Extract just the deployment map
    const mapMatch = content.match(/(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*({[\s\S]*?})\s*(?:as\s+const)?\s*;?/m)
    if (mapMatch) {
      return `Sepolia deployments:\n\n\`\`\`\n${mapMatch[1].slice(0, 2000)}\n\`\`\``
    }
    return `Sepolia deployments file found but could not parse.\n\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``
  } catch (err) {
    return `Error reading deployments: ${(err as Error).message}`
  }
}

// ── Voice Session → Wiki Update Pipeline ───────────────────

export interface SessionInsights {
  entities: string[]
  facts: Array<{
    entity: string
    content: string
    confidence: "high" | "medium" | "low"
  }>
  connections: Array<{
    from: string
    to: string
    relationship: string
  }>
}

/** Parse a voice session transcript and extract architecture insights. */
export async function extractSessionInsights(transcript: string): Promise<SessionInsights> {
  const entities: string[] = []
  const facts: SessionInsights["facts"] = []
  const connections: SessionInsights["connections"] = []

  if (!transcript?.trim()) return { entities, facts, connections }

  // List available entity names from the wiki directory
  let availableEntities: string[] = []
  try {
    if (fs.existsSync(WIKI_ENTITIES)) {
      availableEntities = fs.readdirSync(WIKI_ENTITIES)
        .filter(f => f.endsWith(".md"))
        .map(f => f.replace(/\.md$/, ""))
    }
  } catch { /* directory may not exist */ }

  // Split into sentences for analysis
  const sentences = transcript
    .split(/[.!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 5)

  // Relationship patterns to detect connections
  const relPatterns: Array<{ regex: RegExp; relationship: string }> = [
    { regex: /(\w+)\s+(?:sends?|transfers?|flows?\s+(?:to|into))\s+(\w+)/i, relationship: "sends to" },
    { regex: /(\w+)\s+(?:connects?|links?)\s+(?:to|with)\s+(\w+)/i, relationship: "connects to" },
    { regex: /(\w+)\s+(?:depends?\s+on|relies?\s+on)\s+(\w+)/i, relationship: "depends on" },
    { regex: /(\w+)\s+(?:distributes?\s+to|pays?|pays?\s+out\s+to)\s+(\w+)/i, relationship: "distributes to" },
    { regex: /(\w+)\s+(?:monitors?|watches?|observes?)\s+(\w+)/i, relationship: "monitors" },
    { regex: /(\w+)\s+(?:calls?|invokes?|interacts?\s+with)\s+(\w+)/i, relationship: "interacts with" },
    { regex: /(\w+)\s+(?:receives?\s+(?:from|tokens?\s+from))\s+(\w+)/i, relationship: "receives from" },
  ]

  for (const sentence of sentences) {
    const lowerSentence = sentence.toLowerCase()

    // Find which entities are mentioned in this sentence
    const mentionedEntities = availableEntities.filter(entity =>
      lowerSentence.includes(entity.toLowerCase())
    )

    // Deduplicate and add to entities list
    for (const entity of mentionedEntities) {
      if (!entities.includes(entity)) {
        entities.push(entity)
      }
    }

    // Extract facts for mentioned entities
    if (mentionedEntities.length > 0) {
      for (const entity of mentionedEntities) {
        // Determine confidence based on specificity
        const confidence: "high" | "medium" | "low" =
          mentionedEntities.length === 1 ? "high" :
          sentence.length > 30 ? "medium" : "low"

        facts.push({
          entity,
          content: sentence,
          confidence,
        })
      }
    }

    // Detect relationships between entities
    for (const pattern of relPatterns) {
      const match = sentence.match(pattern.regex)
      if (match) {
        const [, fromRaw, toRaw] = match
        const fromEntity = availableEntities.find(e => e.toLowerCase() === fromRaw.toLowerCase())
        const toEntity = availableEntities.find(e => e.toLowerCase() === toRaw.toLowerCase())
        if (fromEntity && toEntity) {
          connections.push({
            from: fromEntity,
            to: toEntity,
            relationship: pattern.relationship,
          })
        }
      }
    }
  }

  return { entities, facts, connections }
}

/** Map extracted entity names to existing wiki page filenames using fuzzy matching. */
export async function mapInsightsToEntities(insights: SessionInsights): Promise<Map<string, string>> {
  const mapping = new Map<string, string>()

  let availableFiles: string[] = []
  try {
    if (fs.existsSync(WIKI_ENTITIES)) {
      availableFiles = fs.readdirSync(WIKI_ENTITIES)
        .filter(f => f.endsWith(".md"))
        .map(f => f.replace(/\.md$/, ""))
    }
  } catch { /* directory may not exist */ }

  for (const entity of insights.entities) {
    // 1. Exact match
    const exact = availableFiles.find(f => f === entity)
    if (exact) {
      mapping.set(entity, exact)
      continue
    }

    // 2. Case-insensitive match
    const ciMatch = availableFiles.find(f => f.toLowerCase() === entity.toLowerCase())
    if (ciMatch) {
      mapping.set(entity, ciMatch)
      continue
    }

    // 3. Partial match (entity is substring of filename or vice versa)
    const partialMatch = availableFiles.find(f =>
      f.toLowerCase().includes(entity.toLowerCase()) ||
      entity.toLowerCase().includes(f.toLowerCase())
    )
    if (partialMatch) {
      mapping.set(entity, partialMatch)
      continue
    }

    // 4. Word overlap — check if significant words overlap
    const entityWords = entity.toLowerCase().split(/\W+/).filter(w => w.length > 2)
    const bestMatch = availableFiles
      .map(f => ({
        name: f,
        score: entityWords.filter(w => f.toLowerCase().includes(w)).length,
      }))
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score)[0]

    if (bestMatch) {
      mapping.set(entity, bestMatch.name)
    }
  }

  return mapping
}

/** Orchestrate voice session transcript → wiki update pipeline. */
export async function updateWikiFromSession(sessionId: string, transcript: string): Promise<string> {
  try {
    if (!transcript?.trim()) {
      return "No transcript content to process."
    }

    // Step 1: Extract insights from transcript
    const insights = await extractSessionInsights(transcript)
    if (insights.entities.length === 0) {
      return "No architecture entities detected in session transcript."
    }

    // Step 2: Map entity names to wiki pages
    const entityMap = await mapInsightsToEntities(insights)
    if (entityMap.size === 0) {
      return `Detected entities (${insights.entities.join(", ")}) could not be matched to existing wiki pages.`
    }

    const results: string[] = []
    const now = new Date().toISOString()

    // Step 3: For each mapped entity, append new facts
    for (const [entityName, wikiPageName] of entityMap) {
      const entityFacts = insights.facts.filter(f => f.entity === entityName)
      if (entityFacts.length === 0) continue

      // Read existing page content
      const existingContent = await readWikiPage(wikiPageName)

      // Normalize for dedup
      const normalizeForDedup = (s: string) =>
        s.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim()

      const normalizedExisting = normalizeForDedup(existingContent)

      // Filter out duplicates
      const newFacts = entityFacts.filter(fact => {
        const normalizedFact = normalizeForDedup(fact.content)
        return !normalizedExisting.includes(normalizedFact) &&
               normalizedFact.length > 10 // skip very short facts
      })

      if (newFacts.length === 0) {
        results.push(`${wikiPageName}: all facts already present (deduped).`)
        continue
      }

      // Build the new Session Insights section content
      const insightLines = newFacts.map(fact =>
        `- ${fact.content} _(confidence: ${fact.confidence})_`
      )
      const provenance = `<!-- Source: voice session ${sessionId} ${now} -->`
      const sectionContent = `${provenance}\n${insightLines.join("\n")}\n`

      // Check if Session Insights section already exists
      const sectionExists = existingContent.includes("## Session Insights")

      let writeResult: string
      if (sectionExists) {
        // Append to existing section — read and manually append
        const insertPoint = existingContent.indexOf("## Session Insights")
        // Find next section or end of file
        const afterSection = existingContent.slice(insertPoint)
        const nextSectionMatch = afterSection.match(/\n## (?!Session Insights)/)
        const insertAt = nextSectionMatch
          ? insertPoint + afterSection.indexOf(nextSectionMatch[0])
          : existingContent.length

        const updatedContent =
          existingContent.slice(0, insertAt) +
          sectionContent + "\n" +
          existingContent.slice(insertAt)

        const filePath = path.join(WIKI_ENTITIES, `${wikiPageName}.md`)
        if (fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, updatedContent, "utf-8")
          writeResult = `Appended ${newFacts.length} fact(s) to existing "## Session Insights" in ${wikiPageName}.`
        } else {
          writeResult = `Could not find file for ${wikiPageName} to append insights.`
        }
      } else {
        // Create new section at end of file
        writeResult = await writeWiki(
          wikiPageName,
          `\n## Session Insights\n${sectionContent}`,
        )
      }

      results.push(writeResult)
    }

    // Step 4: Log connections if any
    if (insights.connections.length > 0) {
      const connSummary = insights.connections
        .map(c => `${c.from} → ${c.to} (${c.relationship})`)
        .join("; ")
      results.push(`Connections noted: ${connSummary}`)
    }

    return `Wiki update complete for session ${sessionId}:\n${results.join("\n")}`
  } catch (err) {
    return `Wiki update failed: ${(err as Error).message}`
  }
}

// ── Raw Source Compilation Pipeline ───────────────────────────

/** Directory for unprocessed source material (meeting notes, transcripts, design docs). */
const WIKI_RAW = path.join(WIKI_ROOT, "raw")

export interface ExtractedConcepts {
  entityMentions: Array<{
    name: string
    confidence: "high" | "medium" | "low"
    context: string
  }>
  facts: Array<{
    content: string
    relatedEntities: string[]
  }>
  relationships: Array<{
    from: string
    to: string
    description: string
  }>
}

/** Scan content for wiki entity name mentions, extract facts and relationships. */
export function extractConcepts(content: string): ExtractedConcepts {
  const entityMentions: ExtractedConcepts["entityMentions"] = []
  const facts: ExtractedConcepts["facts"] = []
  const relationships: ExtractedConcepts["relationships"] = []

  if (!content?.trim()) return { entityMentions, facts, relationships }

  // Load entity names from all wiki roots
  const availableEntities: string[] = []
  const seenEntities = new Set<string>()
  for (const root of WIKI_ROOTS) {
    try {
      if (!fs.existsSync(root)) continue
      const entries = fs.readdirSync(root, { withFileTypes: true })
      const files = entries.filter(e => e.isFile() && e.name.endsWith(".md")).map(e => e.name.replace(/\.md$/, ""))
      const subdirFiles: string[] = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        try {
          const subEntries = fs.readdirSync(path.join(root, entry.name))
          subdirFiles.push(
            ...subEntries.filter(f => f.endsWith(".md")).map(f => f.replace(/\.md$/, ""))
          )
        } catch { /* skip */ }
      }
      for (const name of [...files, ...subdirFiles]) {
        const lower = name.toLowerCase()
        if (!seenEntities.has(lower)) {
          seenEntities.add(lower)
          availableEntities.push(name)
        }
      }
    } catch { /* skip unreadable */ }
  }

  // Split into paragraphs for context-aware extraction
  const paragraphs = content
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 10)

  // Relationship patterns to detect connections
  const relPatterns: Array<{ regex: RegExp; description: string }> = [
    { regex: /(\w[\w\s]*\w)\s+(?:sends?|transfers?|flows?\s+(?:to|into))\s+(\w[\w\s]*\w)/i, description: "sends to" },
    { regex: /(\w[\w\s]*\w)\s+(?:connects?|links?)\s+(?:to|with)\s+(\w[\w\s]*\w)/i, description: "connects to" },
    { regex: /(\w[\w\s]*\w)\s+(?:depends?\s+on|relies?\s+on)\s+(\w[\w\s]*\w)/i, description: "depends on" },
    { regex: /(\w[\w\s]*\w)\s+(?:distributes?\s+to|pays?|pays?\s+out\s+to)\s+(\w[\w\s]*\w)/i, description: "distributes to" },
    { regex: /(\w[\w\s]*\w)\s+(?:monitors?|watches?|observes?)\s+(\w[\w\s]*\w)/i, description: "monitors" },
    { regex: /(\w[\w\s]*\w)\s+(?:calls?|invokes?|interacts?\s+with)\s+(\w[\w\s]*\w)/i, description: "interacts with" },
    { regex: /(\w[\w\s]*\w)\s+(?:receives?\s+(?:from|tokens?\s+from))\s+(\w[\w\s]*\w)/i, description: "receives from" },
    { regex: /(\w[\w\s]*\w)\s+(?:→|->)\s+(\w[\w\s]*\w)/i, description: "leads to" },
  ]

  for (const paragraph of paragraphs) {
    const sentences = paragraph
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 5)

    for (const sentence of sentences) {
      const lowerSentence = sentence.toLowerCase()

      // Find which entities are mentioned in this sentence
      const mentionedEntities = availableEntities.filter(entity =>
        lowerSentence.includes(entity.toLowerCase())
      )

      if (mentionedEntities.length > 0) {
        // Record entity mentions
        for (const entity of mentionedEntities) {
          const existing = entityMentions.find(m => m.name === entity && m.context === sentence)
          if (!existing) {
            const confidence: "high" | "medium" | "low" =
              mentionedEntities.length === 1 ? "high" :
              sentence.length > 40 ? "medium" : "low"
            entityMentions.push({ name: entity, confidence, context: sentence })
          }
        }

        // Extract a fact for this sentence
        const relatedEntities = mentionedEntities
        const normalizedFact = sentence.toLowerCase().replace(/\s+/g, " ").trim()
        const isDuplicate = facts.some(f =>
          f.content.toLowerCase().replace(/\s+/g, " ").trim() === normalizedFact
        )
        if (!isDuplicate && sentence.length > 15) {
          facts.push({ content: sentence, relatedEntities })
        }
      }

      // Detect relationships between entities
      for (const pattern of relPatterns) {
        const match = sentence.match(pattern.regex)
        if (match) {
          const [, fromRaw, toRaw] = match
          const fromEntity = availableEntities.find(e =>
            e.toLowerCase() === fromRaw.trim().toLowerCase()
          )
          const toEntity = availableEntities.find(e =>
            e.toLowerCase() === toRaw.trim().toLowerCase()
          )
          if (fromEntity && toEntity && fromEntity !== toEntity) {
            const exists = relationships.some(r =>
              r.from === fromEntity && r.to === toEntity
            )
            if (!exists) {
              relationships.push({
                from: fromEntity,
                to: toEntity,
                description: pattern.description,
              })
            }
          }
        }
      }
    }
  }

  return { entityMentions, facts, relationships }
}

export interface CompilationReport {
  source: string
  entitiesFound: string[]
  factsExtracted: number
  pagesUpdated: string[]
  duplicatesSkipped: number
  newSectionsCreated: string[]
}

/** Compile a raw source file into wiki updates.
 *  Reads a markdown file from the raw directory, extracts concepts,
 *  maps them to wiki entities, and updates pages (or previews in dry-run). */
export async function compileToWiki(
  sourcePath: string,
  dryRun: boolean = false,
): Promise<string> {
  try {
    // Resolve and validate source path
    const fullSourcePath = path.isAbsolute(sourcePath)
      ? sourcePath
      : path.join(WIKI_RAW, sourcePath)

    if (!fs.existsSync(fullSourcePath)) {
      return `Source file not found: ${sourcePath}. Place files in docs/starworld/raw/ subdirectories.`
    }

    const content = fs.readFileSync(fullSourcePath, "utf-8")
    if (!content?.trim()) {
      return "Source file is empty — nothing to compile."
    }

    // Step 1: Extract concepts from raw content
    const concepts = extractConcepts(content)

    if (concepts.entityMentions.length === 0) {
      return "No architecture entities detected in source material. Entities must match filenames in docs/starworld/entities/."
    }

    // Step 2: Map entity mentions to wiki pages (fuzzy match)
    const uniqueEntityNames = [...new Set(concepts.entityMentions.map(m => m.name))]

    // Normalize for dedup (reuse pattern from updateWikiFromSession)
    const normalizeForDedup = (s: string) =>
      s.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim()

    const now = new Date().toISOString()
    const shortSource = sourcePath.split("/").pop() || sourcePath

    const report: CompilationReport = {
      source: sourcePath,
      entitiesFound: uniqueEntityNames,
      factsExtracted: concepts.facts.length,
      pagesUpdated: [],
      duplicatesSkipped: 0,
      newSectionsCreated: [],
    }

    // Step 3: For each entity, update the wiki page
    for (const entityName of uniqueEntityNames) {
      // Find matching wiki page (exact or case-insensitive)
      let wikiPageName = entityName
      try {
        if (fs.existsSync(WIKI_ENTITIES)) {
          const files = fs.readdirSync(WIKI_ENTITIES)
          const match = files
            .filter(f => f.endsWith(".md"))
            .find(f => f.replace(/\.md$/, "").toLowerCase() === entityName.toLowerCase())
          if (match) wikiPageName = match.replace(/\.md$/, "")
        }
      } catch { /* fall back to entityName */ }

      // Get facts for this entity
      const entityFacts = concepts.facts.filter(f => f.relatedEntities.includes(entityName))
      if (entityFacts.length === 0) continue

      // Read existing page content
      const existingContent = await readWikiPage(wikiPageName)
      const normalizedExisting = normalizeForDedup(existingContent)

      // Filter out duplicates
      const newFacts = entityFacts.filter(fact => {
        const normalizedFact = normalizeForDedup(fact.content)
        return !normalizedExisting.includes(normalizedFact) &&
               normalizedFact.length > 10
      })

      report.duplicatesSkipped += entityFacts.length - newFacts.length

      if (newFacts.length === 0) continue

      // Build the new Compiled Insights section content
      const factLines = newFacts.map(fact =>
        `- ${fact.content}`
      )
      const provenance = `<!-- Compiled from: ${shortSource} ${now} -->`
      const sectionContent = `${provenance}\n${factLines.join("\n")}\n`

      if (dryRun) {
        report.pagesUpdated.push(`${wikiPageName} (dry-run: would add ${newFacts.length} fact(s))`)
        continue
      }

      // Check if Compiled Insights section already exists
      const sectionHeading = "## Compiled Insights"
      const sectionExists = existingContent.includes(sectionHeading)

      const filePath = path.join(WIKI_ENTITIES, `${wikiPageName}.md`)
      if (!fs.existsSync(filePath)) {
        // Try wiki root
        const altPath = path.join(WIKI_ROOT, `${wikiPageName}.md`)
        if (!fs.existsSync(altPath)) continue
      }

      const targetPath = fs.existsSync(filePath)
        ? filePath
        : path.join(WIKI_ROOT, `${wikiPageName}.md`)

      try {
        if (sectionExists) {
          // Append to existing Compiled Insights section
          const existing = fs.readFileSync(targetPath, "utf-8")
          const insertPoint = existing.indexOf(sectionHeading)
          const afterSection = existing.slice(insertPoint)
          const nextSectionMatch = afterSection.match(/\n## (?!Compiled Insights)/)
          const insertAt = nextSectionMatch
            ? insertPoint + afterSection.indexOf(nextSectionMatch[0])
            : existing.length

          const updatedContent =
            existing.slice(0, insertAt) +
            sectionContent + "\n" +
            existing.slice(insertAt)

          fs.writeFileSync(targetPath, updatedContent, "utf-8")
          report.pagesUpdated.push(`${wikiPageName} (+${newFacts.length} facts appended)`)
        } else {
          // Create new section at end of file
          const writeResult = await writeWiki(
            wikiPageName,
            `\n${sectionHeading}\n${sectionContent}`,
          )
          if (writeResult.includes("successfully")) {
            report.pagesUpdated.push(`${wikiPageName} (new section created)`)
            report.newSectionsCreated.push(wikiPageName)
          } else {
            report.pagesUpdated.push(`${wikiPageName} (write: ${writeResult})`)
          }
        }
      } catch (err) {
        report.pagesUpdated.push(`${wikiPageName} (error: ${(err as Error).message})`)
      }
    }

    // Step 4: Log relationships if any
    const relSummary = concepts.relationships.length > 0
      ? `\nRelationships detected: ${concepts.relationships.map(r => `${r.from} ${r.description} ${r.to}`).join("; ")}`
      : ""

    const mode = dryRun ? " (dry-run)" : ""
    return `Compilation report${mode} for ${sourcePath}:\n` +
      `• Entities found: ${report.entitiesFound.length} (${report.entitiesFound.join(", ")})\n` +
      `• Facts extracted: ${report.factsExtracted}\n` +
      `• Pages updated: ${report.pagesUpdated.length}${report.pagesUpdated.length > 0 ? "\n  " + report.pagesUpdated.join("\n  ") : ""}\n` +
      `• Duplicates skipped: ${report.duplicatesSkipped}\n` +
      `• New sections created: ${report.newSectionsCreated.length}${report.newSectionsCreated.length > 0 ? " (" + report.newSectionsCreated.join(", ") + ")" : ""}` +
      relSummary
  } catch (err) {
    return `Compilation failed: ${(err as Error).message}`
  }
}

// ── Wiki Health Dashboard ─────────────────────────────────────

interface WikiHealthDashboard {
  totalEntities: number
  orphanCount: number
  brokenLinkCount: number
  staleCount: number
  lastUpdate: string
  healthScore: number
  topIssues: string[]
  summary: string
}

/** Return a health dashboard for the architecture wiki.
 *  Reuses lintWiki() internally and computes a 0-100 health score. */
export async function getWikiHealth(): Promise<string> {
  try {
    const raw = await lintWiki()
    const parsed = JSON.parse(raw)
    if (parsed.error) return raw

    const entityDir = WIKI_ENTITIES
    let totalEntities = 0
    let lastUpdate = "unknown"

    if (fs.existsSync(entityDir)) {
      const files = fs.readdirSync(entityDir).filter(f => f.endsWith(".md"))
      totalEntities = files.length

      let latest = 0
      for (const file of files) {
        try {
          const stat = fs.statSync(path.join(entityDir, file))
          if (stat.mtimeMs > latest) {
            latest = stat.mtimeMs
            lastUpdate = stat.mtime.toISOString().split("T")[0]
          }
        } catch { /* skip */ }
      }
    }

    const orphanCount: number = parsed.orphanPages?.length ?? 0
    const brokenLinkCount: number = parsed.brokenLinks?.length ?? 0
    const staleCount: number = parsed.stalePages?.length ?? 0

    const orphanPenalty = Math.min(orphanCount, 30)
    const brokenPenalty = Math.min(brokenLinkCount * 2, 40)
    const stalePenalty = Math.min(staleCount, 20)
    const healthScore = Math.max(0, 100 - orphanPenalty - brokenPenalty - stalePenalty)

    const topIssues: string[] = []
    if (parsed.orphanPages?.length) topIssues.push(`${orphanCount} orphan page(s): ${parsed.orphanPages.slice(0, 3).join(", ")}${orphanCount > 3 ? "..." : ""}`)
    if (parsed.brokenLinks?.length) topIssues.push(`${brokenLinkCount} broken link(s): ${parsed.brokenLinks.slice(0, 3).map((l: { from: string; link: string }) => `${l.link} (from ${l.from})`).join(", ")}${brokenLinkCount > 3 ? "..." : ""}`)
    if (parsed.stalePages?.length) topIssues.push(`${staleCount} stale page(s): ${parsed.stalePages.slice(0, 3).map((p: { page: string; lastModified: string }) => `${p.page} (${p.lastModified})`).join(", ")}${staleCount > 3 ? "..." : ""}`)

    const dashboard: WikiHealthDashboard = {
      totalEntities,
      orphanCount,
      brokenLinkCount,
      staleCount,
      lastUpdate,
      healthScore,
      topIssues,
      summary: healthScore >= 90
        ? `Healthy (${healthScore}/100) — ${totalEntities} entities, ${parsed.summary}`
        : healthScore >= 70
          ? `Needs attention (${healthScore}/100) — ${parsed.summary}`
          : `Poor health (${healthScore}/100) — ${parsed.summary}`,
    }

    return JSON.stringify(dashboard)
  } catch (err) {
    return JSON.stringify({ error: `Health check failed: ${(err as Error).message}` })
  }
}

/** Compute Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[])
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

/** Analyze broken wikilinks and suggest likely fixes via fuzzy name matching. */
export async function suggestRepairLinks(): Promise<string> {
  try {
    const raw = await lintWiki()
    const parsed = JSON.parse(raw)
    if (parsed.error) return raw

    const brokenLinks: Array<{ from: string; link: string }> = parsed.brokenLinks ?? []
    if (brokenLinks.length === 0) {
      return JSON.stringify({ suggestions: [], summary: "No broken links found." })
    }

    // Collect existing entity names for fuzzy matching
    const entityDir = WIKI_ENTITIES
    const existingNames: string[] = []
    if (fs.existsSync(entityDir)) {
      existingNames.push(
        ...fs.readdirSync(entityDir)
          .filter(f => f.endsWith(".md"))
          .map(f => f.replace(/\.md$/, "")),
      )
    }

    const suggestions: Array<{ broken: string; from: string; suggestion: string; confidence: "high" | "medium" }> = []

    for (const { from, link } of brokenLinks) {
      let bestMatch = ""
      let bestDistance = Infinity

      for (const name of existingNames) {
        const dist = levenshtein(link.toLowerCase(), name.toLowerCase())
        if (dist < bestDistance) {
          bestDistance = dist
          bestMatch = name
        }
      }

      if (bestDistance <= 3) {
        suggestions.push({
          broken: link,
          from,
          suggestion: bestMatch,
          confidence: bestDistance <= 1 ? "high" : "medium",
        })
      }
    }

    return JSON.stringify({
      suggestions,
      summary: suggestions.length > 0
        ? `Found ${suggestions.length} likely fix(es) for ${brokenLinks.length} broken link(s).`
        : `No close matches found for ${brokenLinks.length} broken link(s). Manual review needed.`,
    })
  } catch (err) {
    return JSON.stringify({ error: `Repair suggestions failed: ${(err as Error).message}` })
  }
}

/** Check if a specific wiki page is stale (older than N days, default 90). */
export async function isStale(pageName: string, days: number = 90): Promise<string> {
  try {
    // Try entities dir first, then wiki root
    let filePath = path.join(WIKI_ENTITIES, `${pageName}.md`)
    if (!fs.existsSync(filePath)) {
      filePath = path.join(WIKI_ROOT, `${pageName}.md`)
    }
    if (!fs.existsSync(filePath)) {
      return JSON.stringify({ page: pageName, error: "Page not found." })
    }

    const stat = fs.statSync(filePath)
    const lastModified = stat.mtime.toISOString().split("T")[0]
    const ageDays = Math.floor((Date.now() - stat.mtimeMs) / 86_400_000)
    const isStaleResult = ageDays > days

    return JSON.stringify({
      page: pageName,
      lastModified,
      isStale: isStaleResult,
      ageDays,
      message: isStaleResult
        ? `${pageName} was last modified ${ageDays} days ago (${lastModified}) — may be outdated.`
        : `${pageName} is current (${ageDays} days old, modified ${lastModified}).`,
    })
  } catch (err) {
    return JSON.stringify({ page: pageName, error: `Staleness check failed: ${(err as Error).message}` })
  }
}
