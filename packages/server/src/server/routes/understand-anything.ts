/**
 * Understand-Anything API routes — integrates the Understand-Anything
 * knowledge-graph plugin into the CodeNomad/StarWorld server.
 *
 * Endpoints:
 *   POST /api/understand/analyze   — Build or refresh the knowledge graph
 *   GET  /api/understand/graph     — Retrieve the current knowledge graph
 *   POST /api/understand/chat      — Ask a question against the knowledge graph
 *   POST /api/understand/domain    — Extract business domains
 *   POST /api/understand/explain  — Deep-dive into a file
 *   POST /api/understand/diff     — Impact analysis of changes
 *   POST /api/understand/onboard  — Generate onboarding guide
 *   GET  /api/understand/status   — Check knowledge-graph availability
 *   GET  /knowledge-graph.json    — Serve the knowledge graph for the dashboard
 *   GET  /api/understand/dashboard — Serve the Understand-Anything dashboard UI
 *
 * @module understand-anything-routes
 */

import { FastifyInstance } from 'fastify'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

// ── Helpers ─────────────────────────────────────

function resolveUADir(projectRoot: string): string {
  const legacy = path.join(projectRoot, '.understand-anything')
  const modern = path.join(projectRoot, '.ua')
  if (fs.existsSync(legacy)) return legacy
  return modern
}

function resolvePluginRoot(): string {
  const candidates = [
    process.env.UNDERSTAND_PLUGIN_ROOT ?? '',
    path.join(os.homedir(), '.understand-anything', 'repo', 'understand-anything-plugin'),
    path.join(os.homedir(), '.understand-anything-plugin'),
  ]
  for (const cand of candidates) {
    if (cand && fs.existsSync(path.join(cand, 'package.json'))) return cand
  }
  return ''
}

async function runUnderstandAnalyzer(projectRoot: string, args: string[]): Promise<string> {
  const pluginRoot = resolvePluginRoot()
  if (!pluginRoot) {
    throw new Error(
      'Understand-Anything plugin not found. Install it: npx @understand-anything/init',
    )
  }
  const uaDir = resolveUADir(projectRoot)
  const cmd = `node "${path.join(pluginRoot, 'packages/core/dist/index.js')}" analyze "${projectRoot}" --output "${uaDir}" ${args.join(' ')}`
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024 })
  } catch (err: any) {
    throw new Error(`Understand-Anything analyze failed: ${err.stderr ?? err.message}`)
  }
}

async function readKnowledgeGraph(projectRoot: string): Promise<any> {
  const uaDir = resolveUADir(projectRoot)
  const graphPath = path.join(uaDir, 'knowledge-graph.json')
  if (!fs.existsSync(graphPath)) {
    throw new Error(
      `No knowledge graph found at ${graphPath}. Run /understand first.`,
    )
  }
  return JSON.parse(fs.readFileSync(graphPath, 'utf-8'))
}

// ── Route Registration ──────────────────────────────────

export function registerUnderstandAnythingRoutes(app: FastifyInstance): void {
  const pluginRoot = resolvePluginRoot()
  const dashboardDir = pluginRoot ? path.join(pluginRoot, 'packages/dashboard/dist') : ''

  // POST /api/understand/analyze
  app.post('/api/understand/analyze', async (request, reply) => {
    const body = request.body as { projectRoot?: string; args?: string[] }
    const projectRoot = body?.projectRoot ?? process.cwd()
    const args = body?.args ?? []

    if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
      return reply.code(400).send({ error: `No package.json found in ${projectRoot}` })
    }

    try {
      const result = await runUnderstandAnalyzer(projectRoot, args)
      return reply.send({ status: 'analyzed', projectRoot, output: result })
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // GET /api/understand/graph
  app.get('/api/understand/graph', async (request, reply) => {
    const projectRoot = (request.query as { projectRoot?: string })?.projectRoot ?? process.cwd()
    try {
      const graph = await readKnowledgeGraph(projectRoot)
      return reply.send(graph)
    } catch (err: any) {
      return reply.code(404).send({ error: err.message })
    }
  })

  // GET /knowledge-graph.json — serve the knowledge graph for the dashboard
  app.get('/knowledge-graph.json', async (request, reply) => {
    const projectRoot = (request.query as { projectRoot?: string })?.projectRoot ?? process.cwd()
    try {
      const graph = await readKnowledgeGraph(projectRoot)
      reply.header('Content-Type', 'application/json')
      return reply.send(graph)
    } catch (err: any) {
      return reply.code(404).send({ error: err.message })
    }
  })

  // POST /api/understand/chat
  app.post('/api/understand/chat', async (request, reply) => {
    const body = request.body as { projectRoot?: string; query: string }
    const projectRoot = body?.projectRoot ?? process.cwd()
    const query = body?.query?.trim()

    if (!query) {
      return reply.code(400).send({ error: 'Missing query parameter' })
    }

    try {
      const graph = await readKnowledgeGraph(projectRoot)
      const corePath = path.join(pluginRoot, 'packages/core/dist/index.js')
      const { SearchEngine } = await import(corePath)
      const engine = new SearchEngine(graph)
      const results = engine.search(query, 5)
      return reply.send({ query, results })
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /api/understand/domain
  app.post('/api/understand/domain', async (request, reply) => {
    const body = request.body as { projectRoot?: string; full?: boolean }
    const projectRoot = body?.projectRoot ?? process.cwd()
    const full = body?.full ?? false

    try {
      const args = full ? ['--full'] : []
      const result = await runUnderstandAnalyzer(projectRoot, ['domain', ...args])
      return reply.send({ status: 'domain-extracted', projectRoot, output: result })
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // GET /api/understand/dashboard — serve the Understand-Anything dashboard UI
  app.get('/api/understand/dashboard', async (_request, reply) => {
    if (!pluginRoot || !dashboardDir) {
      return reply.code(503).send('<h1>Understand-Anything not installed</h1><p>Run: npx @understand-anything/init</p>')
    }
    const indexHtml = path.join(dashboardDir, 'index.html')
    if (!fs.existsSync(indexHtml)) {
      return reply.code(503).send('<h1>Dashboard not built</h1><p>Run: cd packages/dashboard && npm run build</p>')
    }
    // Rewrite asset paths from /assets/ to /api/understand/dashboard/assets/
    let html = fs.readFileSync(indexHtml, 'utf-8')
    html = html.replace(/src="\/assets\//g, 'src="/api/understand/dashboard/assets/')
    html = html.replace(/href="\/assets\//g, 'href="/api/understand/dashboard/assets/')
    reply.header('Content-Type', 'text/html; charset=utf-8')
    reply.send(html)
  })

  // Serve dashboard static assets
  app.get('/api/understand/dashboard/assets/*', async (request, reply) => {
    if (!dashboardDir) return reply.code(404).send('Not found')
    const assetPath = path.join(dashboardDir, (request.params as any)['*'])
    if (!fs.existsSync(assetPath)) return reply.code(404).send('Not found')
    const ext = path.extname(assetPath)
    const contentType = ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : ext === '.ico' ? 'image/x-icon' : 'application/octet-stream'
    reply.header('Content-Type', contentType)
    reply.send(fs.readFileSync(assetPath))
  })

  // POST /api/understand/explain
  app.post('/api/understand/explain', async (request, reply) => {
    const body = request.body as { projectRoot?: string; filePath: string }
    const projectRoot = body?.projectRoot ?? process.cwd()
    const filePath = body?.filePath

    if (!filePath) {
      return reply.code(400).send({ error: 'Missing filePath parameter' })
    }

    try {
      const graph = await readKnowledgeGraph(projectRoot)
      const absPath = path.resolve(projectRoot, filePath)
      const nodeId = `file:${absPath}`
      const node = graph.nodes?.find((n: any) => n.id === nodeId || n.filePath === absPath)
      if (!node) {
        return reply.code(404).send({ error: `No knowledge-graph entry for ${filePath}` })
      }
      return reply.send({ file: filePath, node })
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /api/understand/diff
  app.post('/api/understand/diff', async (request, reply) => {
    const body = request.body as { projectRoot?: string; range?: string }
    const projectRoot = body?.projectRoot ?? process.cwd()
    const range = body?.range ?? 'HEAD~3..HEAD'

    try {
      const result = await runUnderstandAnalyzer(projectRoot, ['diff', range])
      return reply.send({ status: 'diff-analyzed', range, output: result })
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /api/understand/onboard
  app.post('/api/understand/onboard', async (request, reply) => {
    const body = request.body as { projectRoot?: string }
    const projectRoot = body?.projectRoot ?? process.cwd()

    try {
      const result = await runUnderstandAnalyzer(projectRoot, ['onboard'])
      return reply.send({ status: 'onboard-generated', projectRoot, output: result })
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // GET /api/understand/status
  app.get('/api/understand/status', async (request, reply) => {
    const projectRoot = (request.query as { projectRoot?: string })?.projectRoot ?? process.cwd()
    const uaDir = resolveUADir(projectRoot)
    const graphPath = path.join(uaDir, 'knowledge-graph.json')
    const exists = fs.existsSync(graphPath)
    const pluginAvailable = !!pluginRoot

    if (exists) {
      const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'))
      return reply.send({
        available: true,
        pluginInstalled: pluginAvailable,
        projectRoot,
        dataDir: uaDir,
        nodeCount: graph.nodes?.length ?? 0,
        edgeCount: graph.edges?.length ?? 0,
        analyzedAt: graph.project?.analyzedAt ?? null,
      })
    }

    return reply.send({
      available: false,
      pluginInstalled: pluginAvailable,
      projectRoot,
      dataDir: uaDir,
      message: 'No knowledge graph found. Run /understand to analyze this project.',
    })
  })
}
