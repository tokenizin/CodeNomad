/**
 * Prompt Recommendations for CodeNomad — predictive next-prompt suggestions
 * shown in the input prompt header after the agent finishes responding.
 *
 * The engine analyzes the last assistant message for task-completion patterns
 * and suggests the most likely next actions to keep the user progressing
 * toward their overall goal.
 *
 * Architecture:
 *   - `generateRecommendations()` scans the last assistant message for keywords
 *   - Pattern rules map detected intents to suggestion templates
 *   - Suggestions are ranked by relevance and recency
 *   - The PromptRecommendationBar component renders the top 1-3 suggestions
 *   - Clicking a suggestion populates the textarea via PromptInputApi
 *
 * Integration:
 *   - PromptInput watches `isSessionBusy` prop for busy→idle transitions
 *   - On transition, it calls `generateRecommendations()` with the session's
 *     last messages
 *   - Recommendations are shown in the toolbar area above the input field
 */

import { createSignal } from "solid-js"

// ── Types ───────────────────────────────────────────────────────────

export type RecommendationCategory =
  | "review"
  | "test"
  | "deploy"
  | "fix"
  | "document"
  | "investigate"
  | "optimize"
  | "git"
  | "continue"

export interface PromptRecommendation {
  id: string
  label: string
  prompt: string
  icon: string
  category: RecommendationCategory
  priority: number // 1 = highest
}

// ── Pattern Rules ───────────────────────────────────────────────────

interface PatternRule {
  keywords: string[]
  excludeKeywords?: string[]
  suggestions: Omit<PromptRecommendation, "id">[]
}

const PATTERN_RULES: PatternRule[] = [
  // Code generation / feature implementation
  {
    keywords: ["created", "implemented", "added", "generated", "wrote", "built", "new file", "new component", "new function", "new page", "new route"],
    suggestions: [
      {
        label: "Review the changes",
        prompt: "Review the changes you just made. Check for:\n1. Code quality and consistency with project patterns\n2. Potential bugs or edge cases\n3. Missing error handling\n4. Opportunities for simplification",
        icon: "Eye",
        category: "review",
        priority: 1,
      },
      {
        label: "Add tests",
        prompt: "Write tests for the code you just created. Cover:\n1. Happy path — normal expected inputs\n2. Edge cases — empty, null, boundary values\n3. Error cases — what should throw or fail\n4. Integration — how it interacts with collaborators",
        icon: "FileText",
        category: "test",
        priority: 2,
      },
      {
        label: "Deploy it",
        prompt: "Deploy the changes. Steps:\n1. Run type-check and lint to verify no errors\n2. Run the test suite\n3. Commit with a descriptive message\n4. Push and trigger deployment\n5. Verify the deployment succeeded",
        icon: "Rocket",
        category: "deploy",
        priority: 3,
      },
    ],
  },
  // Investigation / analysis
  {
    keywords: ["found", "discovered", "analyzed", "investigated", "searched", "reviewed", "scanned", "examined", "identified"],
    suggestions: [
      {
        label: "Summarize findings",
        prompt: "Summarize the key findings from your investigation in a structured format:\n1. What you found (bullet points)\n2. Severity/criticality of each finding\n3. Recommended next actions\n4. Any blockers or risks",
        icon: "List",
        category: "investigate",
        priority: 1,
      },
      {
        label: "Fix the issues",
        prompt: "Fix the issues you found. For each one:\n1. Explain the root cause\n2. Implement the fix\n3. Verify it doesn't break anything\n4. Note any remaining risks",
        icon: "Shield",
        category: "fix",
        priority: 2,
      },
    ],
  },
  // Test execution
  {
    keywords: ["test", "passed", "failed", "failing", "assertion", "spec", "coverage", "vitest", "jest"],
    excludeKeywords: ["write test", "add test", "create test"],
    suggestions: [
      {
        label: "Fix failing tests",
        prompt: "Fix the failing tests. For each failure:\n1. Read the error message and identify the root cause\n2. Determine if the test or the code is wrong\n3. Fix the appropriate side\n4. Run the tests again to verify",
        icon: "Shield",
        category: "fix",
        priority: 1,
      },
      {
        label: "Add more coverage",
        prompt: "Add more test coverage for the areas that are untested:\n1. Identify untested code paths\n2. Write tests for edge cases\n3. Add integration tests where missing\n4. Verify all tests pass",
        icon: "FileText",
        category: "test",
        priority: 2,
      },
    ],
  },
  // Deployment
  {
    keywords: ["deployed", "deploy", "pushed", "released", "published", "shipped", "production", "vercel"],
    suggestions: [
      {
        label: "Verify deployment",
        prompt: "Verify the deployment succeeded:\n1. Check the deployment URL is accessible\n2. Run smoke tests on the live site\n3. Check for console errors\n4. Verify key user flows work\n5. Monitor error logs for the first few minutes",
        icon: "CheckCircle",
        category: "deploy",
        priority: 1,
      },
      {
        label: "Monitor logs",
        prompt: "Monitor the application logs and metrics after deployment:\n1. Check for any new errors or warnings\n2. Verify performance metrics are normal\n3. Look for any user-facing issues\n4. Set up alerts if not already configured",
        icon: "Activity",
        category: "review",
        priority: 2,
      },
    ],
  },
  // Bug fix
  {
    keywords: ["fixed", "bug", "issue", "resolved", "patched", "hotfix", "workaround", "error", "crash", "exception"],
    suggestions: [
      {
        label: "Verify the fix",
        prompt: "Verify the bug fix works correctly:\n1. Reproduce the original bug scenario to confirm it's fixed\n2. Test edge cases around the fix\n3. Check for any regressions in related functionality\n4. Run the full test suite",
        icon: "CheckCircle",
        category: "review",
        priority: 1,
      },
      {
        label: "Add regression test",
        prompt: "Add a regression test to prevent this bug from recurring:\n1. Write a test that reproduces the original bug\n2. Verify it fails before the fix and passes after\n3. Add edge case variations\n4. Run the test suite to confirm everything passes",
        icon: "FileText",
        category: "test",
        priority: 2,
      },
      {
        label: "Check for similar issues",
        prompt: "Scan the codebase for similar patterns that could cause the same bug:\n1. Look for the same anti-pattern in other files\n2. Check for related edge cases\n3. Fix any similar issues found\n4. Add tests for each",
        icon: "Search",
        category: "investigate",
        priority: 3,
      },
    ],
  },
  // Documentation
  {
    keywords: ["documented", "documentation", "readme", "comment", "jsdoc", "api doc", "changelog"],
    suggestions: [
      {
        label: "Review the docs",
        prompt: "Review the documentation you just wrote:\n1. Check for accuracy against the actual code\n2. Verify formatting and consistency\n3. Add any missing sections\n4. Ensure examples are correct and runnable",
        icon: "Eye",
        category: "review",
        priority: 1,
      },
      {
        label: "Add examples",
        prompt: "Add practical examples to the documentation:\n1. Basic usage example\n2. Common use cases\n3. Edge case handling\n4. Integration with other components",
        icon: "FileText",
        category: "document",
        priority: 2,
      },
    ],
  },
  // Refactoring
  {
    keywords: ["refactored", "refactor", "restructured", "cleaned", "simplified", "extracted", "renamed", "reorganized"],
    suggestions: [
      {
        label: "Test the refactored code",
        prompt: "Verify the refactored code still works correctly:\n1. Run the full test suite\n2. Check for any behavior changes\n3. Verify performance hasn't regressed\n4. Review the changes for consistency",
        icon: "CheckCircle",
        category: "test",
        priority: 1,
      },
      {
        label: "Check performance",
        prompt: "Check if the refactoring affected performance:\n1. Benchmark critical paths before/after\n2. Check for unnecessary re-renders or allocations\n3. Verify bundle size hasn't increased\n4. Run performance tests if available",
        icon: "TrendingUp",
        category: "optimize",
        priority: 2,
      },
    ],
  },
  // Git operations
  {
    keywords: ["commit", "branch", "merge", "pull request", "pr", "rebase", "stash"],
    suggestions: [
      {
        label: "Check git status",
        prompt: "Check the current git status:\n1. Show modified/staged files\n2. Show recent commits\n3. Check for untracked files\n4. Verify the working tree is clean",
        icon: "GitBranch",
        category: "git",
        priority: 1,
      },
      {
        label: "Create a PR",
        prompt: "Create a pull request for the current branch:\n1. Push the branch if not already pushed\n2. Generate a PR title and description from the commits\n3. Open the PR creation page\n4. Note any reviewers to add",
        icon: "GitBranch",
        category: "git",
        priority: 2,
      },
    ],
  },
  // Optimization
  {
    keywords: ["optimized", "performance", "speed", "faster", "cache", "lazy", "bundle", "memory"],
    suggestions: [
      {
        label: "Benchmark the improvement",
        prompt: "Benchmark the performance improvement:\n1. Measure before/after metrics\n2. Check for any regressions in functionality\n3. Verify the improvement is significant\n4. Document the results",
        icon: "TrendingUp",
        category: "optimize",
        priority: 1,
      },
    ],
  },
  // Fallback — general continuation
  {
    keywords: [], // Always matches (lowest priority)
    suggestions: [
      {
        label: "What's next?",
        prompt: "Based on what we've been working on, what should I do next? Consider:\n1. Any incomplete tasks or TODOs\n2. Logical next steps in the workflow\n3. Potential issues or risks to address\n4. Tests or documentation that might be missing",
        icon: "Sparkles",
        category: "continue",
        priority: 10,
      },
    ],
  },
]

// ── Store ───────────────────────────────────────────────────────────

const [recommendations, setRecommendations] = createSignal<PromptRecommendation[]>([])
const [visible, setVisible] = createSignal(false)
const [dismissedIds, setDismissedIds] = createSignal<Set<string>>(new Set())

// ── Helpers ─────────────────────────────────────────────────────────

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[*_`#]/g, " ").replace(/\s+/g, " ").trim()
}

function matchScore(message: string, keywords: string[]): number {
  if (keywords.length === 0) return 1 // Fallback rule
  let score = 0
  for (const kw of keywords) {
    if (message.includes(kw.toLowerCase())) {
      score += 1
      // Bonus for keyword appearing multiple times
      const regex = new RegExp(kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
      const matches = message.match(regex)
      if (matches && matches.length > 1) {
        score += matches.length * 0.5
      }
    }
  }
  return score
}

function isExcluded(message: string, excludeKeywords?: string[]): boolean {
  if (!excludeKeywords) return false
  return excludeKeywords.some((kw) => message.includes(kw.toLowerCase()))
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Generate recommendations based on the last assistant message.
 * Returns top 3 unique suggestions sorted by priority.
 */
export function generateRecommendations(lastAssistantMessage: string | undefined): PromptRecommendation[] {
  if (!lastAssistantMessage || lastAssistantMessage.trim().length === 0) {
    setRecommendations([])
    setVisible(false)
    return []
  }

  const normalized = normalizeText(lastAssistantMessage)
  const dismissed = dismissedIds()
  const scored: PromptRecommendation[] = []

  for (const rule of PATTERN_RULES) {
    // Skip excluded patterns
    if (isExcluded(normalized, rule.excludeKeywords)) continue

    const score = matchScore(normalized, rule.keywords)
    if (score <= 0) continue

    for (const suggestion of rule.suggestions) {
      const id = `${suggestion.category}-${suggestion.label.toLowerCase().replace(/\s+/g, "-")}`
      if (dismissed.has(id)) continue

      scored.push({
        ...suggestion,
        id,
        // Adjust priority by match score (higher score = lower priority number = shown first)
        priority: suggestion.priority - score * 0.1,
      })
    }
  }

  // Sort by priority (ascending) and deduplicate by category (keep highest priority per category)
  scored.sort((a, b) => a.priority - b.priority)

  const seenCategories = new Set<string>()
  const unique: PromptRecommendation[] = []
  for (const rec of scored) {
    if (seenCategories.has(rec.category)) continue
    seenCategories.add(rec.category)
    unique.push(rec)
  }

  // Take top 3
  const top = unique.slice(0, 3)

  setRecommendations(top)
  setVisible(top.length > 0)
  return top
}

/** Get current recommendations. */
export function getRecommendations(): PromptRecommendation[] {
  return recommendations()
}

/** Whether the recommendation bar should be visible. */
export function isRecommendationVisible(): boolean {
  return visible()
}

/** Dismiss a specific recommendation (won't show again this session). */
export function dismissRecommendation(id: string) {
  setDismissedIds((prev) => {
    const next = new Set(prev)
    next.add(id)
    return next
  })
  setRecommendations((prev) => prev.filter((r) => r.id !== id))
  if (recommendations().length === 0) {
    setVisible(false)
  }
}

/** Dismiss all current recommendations. */
export function dismissAllRecommendations() {
  setRecommendations([])
  setVisible(false)
}

/** Reset dismissed recommendations (e.g., on new session). */
export function resetRecommendations() {
  setRecommendations([])
  setVisible(false)
  setDismissedIds(new Set())
}
