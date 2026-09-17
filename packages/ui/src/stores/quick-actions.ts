/**
 * Quick Action Cards for CodeNomad — prompt templates shown in the empty
 * message state. Clicking a card populates the prompt input so the user can
 * customize before sending.
 *
 * Store uses SolidJS signals so both the card grid (rendered inside the
 * VirtualFollowList empty state) and the PromptInput (rendered separately)
 * can communicate without prop drilling.
 */

import { createSignal } from "solid-js"

// ── Types ───────────────────────────────────────────────────────────

export type QuickActionCategory =
  | 'code'
  | 'debug'
  | 'explain'
  | 'refactor'
  | 'docs'
  | 'ecosystem'
  | '3d'
  | 'design'
  | 'understand'

export interface QuickActionCard {
  id: string
  title: string
  description: string
  icon: string
  category: QuickActionCategory
  tags: string[]
  promptTemplate: string
}

// ── Catalog ─────────────────────────────────────────────────────────

export const QUICK_ACTIONS: QuickActionCard[] = [
  {
    id: 'review-codebase',
    title: 'Review my codebase',
    description: 'Scan the project and surface architecture, risks, and quick wins',
    icon: 'Search',
    category: 'code',
    tags: ['Review', 'Architecture'],
    promptTemplate: `Review the codebase in this workspace. I need:

1. **Architecture overview** — what are the main modules / layers and how do they connect?
2. **Tech stack** — languages, frameworks, key dependencies
3. **Potential risks** — security, performance, or maintainability concerns
4. **Quick wins** — 3-5 high-impact improvements I can make right now

Be specific — reference actual file paths and patterns you find.`,
  },
  {
    id: 'explain-file',
    title: 'Explain how something works',
    description: 'Pick a file or function and get a clear walkthrough',
    icon: 'BookOpen',
    category: 'explain',
    tags: ['Explain', 'Learn'],
    promptTemplate: `Explain how the following works in my codebase — assume I'm a developer who's new to this project.

TARGET: [file path, function name, or module]

Please cover:
1. **What it does** — purpose and role in the project
2. **How it works** — key logic, data flow, state transitions
3. **Dependencies** — what it calls and what calls it
4. **Edge cases** — what could go wrong or surprise someone

Use references to actual code with file paths.`,
  },
  {
    id: 'fix-bug',
    title: 'Fix a bug',
    description: 'Describe the issue and get a targeted fix with explanation',
    icon: 'Shield',
    category: 'debug',
    tags: ['Debug', 'Fix'],
    promptTemplate: `I have a bug in my codebase. Help me find and fix it.

SYMPTOM: [what's going wrong — error message, wrong behavior, unexpected output]
EXPECTED: [what should happen]
ACTUAL: [what actually happens]

STEPS TO REPRODUCE:
1. [step]
2. [step]

Please:
1. Identify the root cause
2. Explain why it's happening
3. Propose a minimal, safe fix
4. Note any side effects or regressions to watch for`,
  },
  {
    id: 'write-tests',
    title: 'Write tests',
    description: 'Generate unit or integration tests for a module',
    icon: 'FileText',
    category: 'code',
    tags: ['Testing', 'Quality'],
    promptTemplate: `Write tests for the following module or function.

TARGET: [file path or function]
FRAMEWORK: [vitest / jest / mocha / pytest / etc. — pick what's already in the project]

Cover:
1. **Happy path** — the normal, expected inputs
2. **Edge cases** — empty input, null, boundary values, large payloads
3. **Error cases** — what should throw or return errors
4. **Integration** — how it interacts with collaborators (if applicable)

Match the existing test style in the project.`,
  },
  {
    id: 'refactor',
    title: 'Refactor for clarity',
    description: 'Clean up a messy function or module with better structure',
    icon: 'Code',
    category: 'refactor',
    tags: ['Refactor', 'Clean up'],
    promptTemplate: `Refactor the following code to improve readability and maintainability.

TARGET: [file path or function]
GOALS: [what to improve — e.g. reduce nesting, extract helpers, clarify naming, improve types]

CONSTRAINTS:
- Preserve existing behavior — don't change what it does
- Keep the public API the same unless I say otherwise
- Match the project's existing style and patterns

Show the before/after and explain each change.`,
  },
  {
    id: 'add-feature',
    title: 'Implement a feature',
    description: 'Describe what you want and get an implementation plan + code',
    icon: 'Lightbulb',
    category: 'code',
    tags: ['Feature', 'Build'],
    promptTemplate: `Help me implement a feature in this workspace.

FEATURE: [what you want to build]
CONTEXT: [where it fits — existing modules, APIs, user flow]

Please:
1. **Plan first** — outline the approach, files to create/modify, key decisions
2. **Implement** — write the code, matching the project's patterns
3. **Verify** — suggest how to test it (manual or automated)
4. **Note risks** — what could break or need attention

Wait for my approval on the plan before writing code.`,
  },
  {
    id: 'security-audit',
    title: 'Security audit',
    description: 'Scan for vulnerabilities, secrets, and unsafe patterns',
    icon: 'Shield',
    category: 'debug',
    tags: ['Security', 'Audit'],
    promptTemplate: `Run a security audit of this workspace.

CHECK FOR:
• Hardcoded secrets (API keys, tokens, passwords) in code or config
• Injection vulnerabilities (SQL, command, XSS, path traversal)
• Insecure dependencies (known CVEs, outdated packages)
• Missing input validation or sanitization
• Broken access control (missing auth checks, privilege escalation)
• Insecure crypto (weak algorithms, hardcoded IVs/secrets)

SEVERITY: Critical / High / Medium / Low

For each finding, show the file, explain the risk, and suggest a fix.`,
  },
  {
    id: 'optimize',
    title: 'Optimize performance',
    description: 'Find bottlenecks and suggest targeted improvements',
    icon: 'TrendingUp',
    category: 'refactor',
    tags: ['Performance', 'Speed'],
    promptTemplate: `Find performance bottlenecks in this codebase and suggest improvements.

FOCUS AREA: [specific module / API endpoint / query / or "whole project"]

For each issue found:
1. **What** — the specific bottleneck (N+1 query, unnecessary re-render, large bundle, etc.)
2. **Where** — file path and function
3. **Impact** — how bad it is (rough estimate)
4. **Fix** — concrete code change with explanation

Prioritize by impact. Start with the biggest wins.`,
  },
  {
    id: 'generate-docs',
    title: 'Generate documentation',
    description: 'Write README, API docs, or inline comments from code',
    icon: 'FileText',
    category: 'docs',
    tags: ['Docs', 'README'],
    promptTemplate: `Generate documentation for this codebase.

TYPE: [README / API docs / inline JSDoc / architecture overview / CONTRIBUTING guide]

Please:
1. Analyze the codebase to understand its purpose, structure, and usage
2. Write clear, accurate documentation based on actual code (not assumptions)
3. Include setup instructions, usage examples, and key configuration
4. Note any gaps you found (missing env vars, unclear setup steps, etc.)

Match the tone and style of any existing docs in the project.`,
  },
  {
    id: 'smart-contract',
    title: 'Write a smart contract',
    description: 'Draft Solidity with OpenZeppelin patterns and security checks',
    icon: 'Coins',
    category: 'ecosystem',
    tags: ['Solidity', 'Web3'],
    promptTemplate: `Help me write a smart contract for this project.

REQUIREMENTS:
• What it should do: [describe]
• Blockchain: [Ethereum / BSC / etc.]
• Standards needed: [ERC-20 / ERC-721 / ERC-1155 / custom]
• Key features: [minting / burning / access control / vesting / etc.]

Please:
1. **Design** — outline the contract structure, state variables, and key functions
2. **Implement** — write Solidity using OpenZeppelin where possible
3. **Security** — note any reentrancy, overflow, or access control concerns
4. **Tests** — suggest key test cases

Use the project's existing Solidity version and patterns.`,
  },
  {
    id: 'explain-error',
    title: 'Decode an error',
    description: 'Paste a stack trace or error message and get a clear explanation',
    icon: 'Shield',
    category: 'debug',
    tags: ['Error', 'Debug'],
    promptTemplate: `Help me understand and fix this error.

ERROR MESSAGE / STACK TRACE:
\`\`\`
[paste the error here]
\`\`\`

CONTEXT: [what you were doing when it happened]

Please explain:
1. **What it means** — in plain language
2. **Why it happened** — the root cause
3. **How to fix it** — concrete steps
4. **How to prevent it** — patterns to avoid this in the future`,
  },
  {
    id: 'git-history',
    title: 'Understand git history',
    description: 'Analyze recent commits or a specific change',
    icon: 'GitBranch',
    category: 'explain',
    tags: ['Git', 'History'],
    promptTemplate: `Help me understand the recent git history of this repo.

FOCUS: [last N commits / a specific file / a specific feature / merge conflict]

Please:
1. **Summarize** — what changed and why (read the commit messages + diffs)
2. **Spot patterns** — recurring issues, refactoring directions, tech debt accumulation
3. **Flag concerns** — anything that looks risky, incomplete, or contradictory
4. **Suggest next** — what should happen based on the trajectory`,
  },

  // ── Understand-Anything ──────────────────────────────────────

  {
    id: 'understand-module',
    title: 'Understand any module',
    description: 'Deep-dive into a module — architecture, data flow, risks, and hidden logic',
    icon: 'Search',
    category: 'understand',
    tags: ['Analyze', 'Module', 'Deep-dive'],
    promptTemplate: `Analyze this module in the workspace using the Understand-Anything knowledge graph.

MODULE: [file path, directory, or module name]

Please:
1. **Architecture** — what this module does, its layers, and how it connects to the rest of the codebase
2. **Data flow** — inputs, outputs, state changes, and key function call chains
3. **Logic audit** — flag any unconventional logic, literal contradictions, dead code, or red flags
4. **Risks** — security, performance, maintainability concerns
5. **Quick wins** — 3-5 high-impact improvements

Use the knowledge graph to cross-reference related files and dependencies.`,
  },
  {
    id: 'understand-monorepo',
    title: 'Understand a monorepo',
    description: 'Scan an entire monorepo and map all inter-package dependencies',
    icon: 'Layers',
    category: 'understand',
    tags: ['Monorepo', 'Dependencies', 'Map'],
    promptTemplate: `Analyze this monorepo using the Understand-Anything knowledge graph.

SCOPE: [root directory or package name — defaults to workspace root]

Please:
1. **Package map** — every package/module and its role
2. **Dependency graph** — how packages depend on each other (imports, shared libs, circular deps)
3. **Cross-cutting concerns** — auth, DB, logging, config — where are they handled?
4. **Logic audit** — flag contradictions, duplicated logic, unconventional patterns across packages
5. **Red flags** — security gaps, missing tests, outdated deps, fragile couplings

Generate a visual dependency graph and highlight any problematic edges.`,
  },
  {
    id: 'understand-platform',
    title: 'Understand the full platform',
    description: 'Scan the entire build and release — full platform analysis with dashboard',
    icon: 'LayoutDashboard',
    category: 'understand',
    tags: ['Platform', 'Full Scan', 'Dashboard'],
    promptTemplate: `Run a full platform analysis using the Understand-Anything knowledge graph.

SCOPE: entire workspace — all modules, packages, configs, and build artifacts

Please:
1. **Full architecture map** — every module, layer, and how they connect
2. **Build & release analysis** — build config, CI/CD, deployment pipeline, versioning
3. **Logic audit** — scan for contradictions, dead code, unconventional patterns, literal logic errors
4. **Security & risk** — secrets, injection, access control, dependency vulnerabilities
5. **Performance** — bottlenecks, N+1 patterns, bundle size, slow imports
6. **Dashboard** — generate a comprehensive visual dashboard summarizing all findings with severity ratings

Output a structured report with: summary, findings by severity, dependency graph, and recommended actions.`,
  },
  {
    id: 'understand-diagnose',
    title: 'Diagnose logic errors',
    description: 'Find logic contradictions, unconventional patterns, and literal bugs',
    icon: 'Shield',
    category: 'understand',
    tags: ['Debug', 'Logic', 'Contradictions'],
    promptTemplate: `Diagnose logic errors in this codebase using the Understand-Anything knowledge graph.

FOCUS: [specific module / function / or "whole project"]

Please:
1. **Contradiction scan** — find any logic that contradicts itself (e.g., a condition that can never be true, unreachable branches, inverted guards)
2. **Unconventional patterns** — flag code that works but is dangerously unclear or non-obvious
3. **Dead code** — functions, branches, or variables that are never reached or used
4. **Type/contract mismatches** — places where the code violates its own types or API contracts
5. **Risk severity** — rate each finding: Critical / High / Medium / Low with explanation

For each finding, show the file, line, the exact logic problem, and the fix.`,
  },

  // ── 3D ───────────────────────────────────────────────────────────────

  {
    id: '3d-model-materials',
    title: '3D model with materials',
    description: 'Create a 3D model with PBR materials, textures, and structural properties',
    icon: 'Box',
    category: '3d',
    tags: ['3D', 'Materials', 'Model'],
    promptTemplate: `Create a 3D model with materials for this project.

ASSET: [what to model — character / object / environment / brand asset]
STYLE: [realistic / stylized / low-poly / cinematic]
MATERIALS: [metal / glass / fabric / organic / custom — specify PBR maps needed]

Please:
1. **Mesh** — topology, poly count target, LOD strategy
2. **Materials** — PBR workflow (albedo, normal, roughness, metallic, AO)
3. **UVs** — unwrap strategy, texel density, tiling vs unique
4. **Export** — format (glTF / FBX / USD) and integration path for the target engine`,
  },
  {
    id: '3d-animate',
    title: 'Animate a 3D mesh',
    description: 'Build skeletal or keyframe animations for a 3D model',
    icon: 'PlayCircle',
    category: '3d',
    tags: ['3D', 'Animation', 'Rig'],
    promptTemplate: `Animate a 3D mesh for this project.

ASSET: [model to animate]
ANIMATION TYPE: [skeletal / procedural / physics-based / morph-target / keyframe]
ACTION: [walk cycle / idle / interaction / cinematic sequence / loop]

Please:
1. **Rig** — bone hierarchy, IK/FK setup, control rig design
2. **Animation** — keyframe breakdown, easing curves, timing
3. **Export** — animation clips, blend shapes, engine integration
4. **Optimization** — bone count, compression, runtime considerations`,
  },
  {
    id: '3d-scene',
    title: 'Build a 3D scene',
    description: 'Compose an optimized 3D scene with lighting, LOD, and spatial arrangement',
    icon: 'Layers',
    category: '3d',
    tags: ['3D', 'Scene', 'Lighting'],
    promptTemplate: `Build a 3D scene for this project.

PURPOSE: [brand environment / product viz / game level / AR/VR / presentation]
STYLE: [photorealistic / stylized / abstract / technical]
ASSETS NEEDED: [list key objects / environments / characters]

Please:
1. **Composition** — spatial layout, camera angles, focal points
2. **Lighting** — HDRI setup, key/fill/rim, shadows, mood
3. **Optimization** — LOD strategy, occlusion culling, draw call budget
4. **Render** — engine choice (StarRender / Three.js / WebGPU), output format`,
  },
  {
    id: '3d-capture',
    title: 'Capture 3D animation',
    description: 'Record 3D viewport output and generate video clips or rendered sequences',
    icon: 'Video',
    category: '3d',
    tags: ['3D', 'Video', 'Render'],
    promptTemplate: `Capture a 3D animation for this project.

SOURCE: [viewport recording / rendered sequence / real-time capture]
OUTPUT: [video clip / GIF / image sequence / social media / presentation]
DURATION: [length in seconds]
QUALITY: [draft / production / broadcast]

Please:
1. **Setup** — camera path, resolution, frame rate, codec
2. **Capture** — viewport recording vs offline render, anti-aliasing
3. **Post** — color grading, compositing, audio sync if needed
4. **Deliver** — export format, compression, platform targeting`,
  },

  // ── Design ───────────────────────────────────────────────────────────

  {
    id: 'design-landing',
    title: 'Design a landing page',
    description: 'Create a brand-consistent landing page layout with visual hierarchy',
    icon: 'LayoutDashboard',
    category: 'design',
    tags: ['Design', 'UI', 'Landing'],
    promptTemplate: `Design a landing page for this project.

AUDIENCE: [who is this for]
GOAL: [conversion / awareness / signup / showcase]
SECTIONS: [hero / features / social proof / CTA / footer — specify]

Please:
1. **Layout** — section order, visual hierarchy, whitespace strategy
2. **Brand** — color tokens, typography, iconography aligned to Tokenizin brand
3. **Components** — reusable MUI v9 / Tailwind patterns
4. **Responsive** — mobile-first breakpoints, tablet adaptation`,
  },
  {
    id: 'design-system',
    title: 'Create a design system',
    description: 'Build a component design system with design tokens and style guides',
    icon: 'Palette',
    category: 'design',
    tags: ['Design', 'System', 'Tokens'],
    promptTemplate: `Create a design system for this project.

SCOPE: [full system / component library / token set / pattern library]
BRAND: [Tokenizin / StarWorld / custom — specify brand context]

Please:
1. **Tokens** — color, typography, spacing, elevation, motion design tokens
2. **Components** — core component inventory (buttons, cards, inputs, navigation)
3. **Guidelines** — usage rules, do/don't examples, accessibility requirements
4. **Implementation** — MUI v9 theme structure, Tailwind config, CSS custom properties`,
  },
  {
    id: 'design-component',
    title: 'Style a component',
    description: 'Apply brand-aligned styling to a specific UI component',
    icon: 'Paintbrush',
    category: 'design',
    tags: ['Design', 'Component', 'Style'],
    promptTemplate: `Style a component for this project.

COMPONENT: [what to style — button / card / modal / nav / form / custom]
VARIANTS: [default / hover / active / disabled / error / loading]

Please:
1. **Visual design** — color, typography, spacing, borders, shadows
2. **States** — all interaction states, transitions, animations
3. **Accessibility** — focus indicators, contrast, ARIA attributes
4. **Code** — MUI v9 sx prop or Tailwind classes matching project patterns`,
  },
]

// ── Derived data ────────────────────────────────────────────────────

export const QUICK_ACTION_CATEGORIES: { id: QuickActionCategory; label: string }[] = [
  { id: 'code', label: 'Code' },
  { id: 'debug', label: 'Debug' },
  { id: 'explain', label: 'Explain' },
  { id: 'refactor', label: 'Refactor' },
  { id: 'docs', label: 'Docs' },
  { id: 'ecosystem', label: 'Web3' },
  { id: '3d', label: '3D' },
  { id: 'design', label: 'Design' },
  { id: 'understand', label: 'Analyze' },
]

// ── Signal store ────────────────────────────────────────────────────

/** Pending prompt template selected from a quick-action card. */
const [quickActionPrompt, setQuickActionPromptSignal] = createSignal<string | null>(null)

export function setQuickActionPrompt(template: string) {
  setQuickActionPromptSignal(template)
}

export function getQuickActionPrompt() {
  return quickActionPrompt()
}

export function clearQuickActionPrompt() {
  setQuickActionPromptSignal(null)
}

/** Filter by category. Returns all if category is null. */
export function getQuickActionsByCategory(category: QuickActionCategory | null): QuickActionCard[] {
  if (!category) return QUICK_ACTIONS
  return QUICK_ACTIONS.filter((a) => a.category === category)
}
