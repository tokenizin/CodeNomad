/**
 * Understand-Anything dashboard data endpoints.
 *
 * The plugin's dashboard SPA fetches these from the site root (the paths are hardcoded in its
 * bundle) with `?token=`. CodeNomad's session gate protects them instead (see http-server.ts), so
 * the token is ignored. They mirror the plugin's own dev server (packages/dashboard/vite.config.ts)
 * but read from the project chosen for the request rather than a single GRAPH_DIR.
 *
 *   GET /knowledge-graph.json  Knowledge graph (absolute node paths made project-relative)
 *   GET /domain-graph.json     Domain graph (same sanitising)
 *   GET /diff-overlay.json     Changed/affected node ids from the last diff analysis
 *   GET /meta.json             Theme and other project metadata
 *   GET /config.json           Project config; defaults when the project has none
 *   GET /code-lessons.json     Optional per-project lessons (404 when absent)
 *   GET /file-content.json     ?path=<relative> source preview, restricted to files in the graph
 *   GET /staleness.json        Whether the graphs lag behind the project's git history
 *
 * @module understand-dashboard-data-routes
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { resolvePluginRoot, resolveUADir } from './understand-anything.js'

export const DASHBOARD_DATA_PATHS: ReadonlySet<string> = new Set([
  '/knowledge-graph.json',
  '/domain-graph.json',
  '/diff-overlay.json',
  '/meta.json',
  '/config.json',
  '/code-lessons.json',
  '/file-content.json',
  '/staleness.json',
])

const MAX_SOURCE_FILE_BYTES = 1024 * 1024

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: 'bash', c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css', go: 'go', h: 'c',
  hpp: 'cpp', html: 'markup', java: 'java', js: 'javascript', jsx: 'jsx', json: 'json',
  md: 'markdown', mjs: 'javascript', py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash',
  ts: 'typescript', tsx: 'tsx', txt: 'text', yaml: 'yaml', yml: 'yaml',
}

type GraphNode = Record<string, unknown>
type JsonObject = { nodes?: GraphNode[]; [key: string]: unknown }

interface Failure {
  statusCode: number
  error: string
}

// ── Path helpers ────────────────────────────────

/** True when `candidate` is `root` itself or a descendant of it. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * Project-relative, forward-slash form of a graph path, or null if it escapes the project.
 * Accepts absolute paths inside the project and already-relative paths.
 */
function normalizeGraphPath(filePath: string, projectRoot: string): string | null {
  if (filePath.includes('\0')) return null
  let relative = filePath
  if (path.isAbsolute(filePath)) {
    if (!isInside(projectRoot, filePath)) return null
    relative = path.relative(projectRoot, filePath)
  }
  const normalized = path.normalize(relative)
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('..' + path.sep) || path.isAbsolute(normalized)) {
    return null
  }
  return normalized.split(path.sep).join('/')
}

function readJsonObject(file: string): JsonObject {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as JsonObject
}

/**
 * Nodes can carry absolute paths such as /Users/alice/company/src/auth.ts. Make them
 * project-relative so the code viewer can request them and the host's directory layout is not
 * sent to the browser. Absolute paths outside the project are reduced to their file name.
 */
function relativizeNodePaths(graph: JsonObject, projectRoot: string): JsonObject {
  if (!Array.isArray(graph.nodes)) return graph
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (typeof node.filePath !== 'string' || !path.isAbsolute(node.filePath)) return node
      const relative = isInside(projectRoot, node.filePath)
        ? path.relative(projectRoot, node.filePath).split(path.sep).join('/')
        : path.basename(node.filePath)
      return { ...node, filePath: relative }
    }),
  }
}

function graphFilePathSet(graph: JsonObject, projectRoot: string): Set<string> {
  const allowed = new Set<string>()
  for (const node of graph.nodes ?? []) {
    if (typeof node.filePath !== 'string') continue
    const normalized = normalizeGraphPath(node.filePath, projectRoot)
    if (normalized) allowed.add(normalized)
  }
  return allowed
}

// ── Endpoint logic ──────────────────────────────

function readSourceFile(projectRoot: string, requestedPath: string): { ok: true; payload: unknown } | ({ ok: false } & Failure) {
  const fail = (error: string, statusCode = 400) => ({ ok: false as const, statusCode, error })
  if (!requestedPath) return fail('Missing path')
  if (requestedPath.includes('\0')) return fail('Invalid path')
  if (path.isAbsolute(requestedPath)) return fail('Absolute paths are not allowed')

  const absoluteFile = path.resolve(projectRoot, requestedPath)
  if (absoluteFile === projectRoot || !isInside(projectRoot, absoluteFile)) {
    return fail('Path must stay inside the project')
  }

  const graphFile = path.join(resolveUADir(projectRoot), 'knowledge-graph.json')
  if (!fs.existsSync(graphFile)) return fail('No knowledge graph found. Run /understand first.', 404)
  let allowed: Set<string>
  try {
    allowed = graphFilePathSet(readJsonObject(graphFile), projectRoot)
  } catch {
    return fail('Failed to read graph file', 500)
  }
  const safeRelativePath = path.relative(projectRoot, absoluteFile).split(path.sep).join('/')
  if (!allowed.has(safeRelativePath)) return fail('File is not in the knowledge graph', 404)

  // Resolve symlinks so a link inside the project cannot expose files outside it.
  let realFile: string
  try {
    realFile = fs.realpathSync(absoluteFile)
    if (!isInside(fs.realpathSync(projectRoot), realFile)) return fail('Path must stay inside the project')
  } catch {
    return fail('File not found', 404)
  }

  const stat = fs.statSync(realFile)
  if (!stat.isFile()) return fail('Path is not a file')
  if (stat.size > MAX_SOURCE_FILE_BYTES) return fail('File is too large to preview', 413)

  const buffer = fs.readFileSync(realFile)
  if (buffer.includes(0)) return fail('Binary files cannot be previewed', 415)

  const content = buffer.toString('utf8')
  return {
    ok: true,
    payload: {
      path: safeRelativePath,
      language: LANGUAGE_BY_EXTENSION[path.extname(safeRelativePath).slice(1).toLowerCase()] ?? 'text',
      content,
      sizeBytes: buffer.byteLength,
      lineCount: content.length === 0 ? 0 : content.split(/\r\n|\n|\r/).length,
    },
  }
}

function readGraphGitMetadata(file: string): { graphCommitHash?: string; lastAnalyzedAt?: string } {
  const project = (readJsonObject(file).project ?? {}) as Record<string, unknown>
  return {
    graphCommitHash: typeof project.gitCommitHash === 'string' ? project.gitCommitHash : undefined,
    lastAnalyzedAt: typeof project.analyzedAt === 'string' ? project.analyzedAt : undefined,
  }
}

async function readFreshness(projectRoot: string): Promise<{ ok: true; payload: unknown } | ({ ok: false } & Failure)> {
  const uaDir = resolveUADir(projectRoot)
  const graphFile = path.join(uaDir, 'knowledge-graph.json')
  if (!fs.existsSync(graphFile)) {
    return { ok: false, statusCode: 404, error: 'No knowledge graph found. Run /understand first.' }
  }

  const pluginRoot = resolvePluginRoot()
  const corePath = pluginRoot ? path.join(pluginRoot, 'packages/core/dist/index.js') : ''
  if (!corePath || !fs.existsSync(corePath)) {
    return { ok: false, statusCode: 503, error: 'Understand-Anything plugin core is not available' }
  }
  const core = await import(pathToFileURL(corePath).href)
  if (typeof core.getGraphFreshnessBatch !== 'function') {
    // Older plugin builds predate the freshness report; the dashboard just omits the banner.
    return { ok: false, statusCode: 501, error: 'Installed Understand-Anything plugin does not support freshness checks' }
  }

  try {
    const inputs: Record<string, unknown> = { knowledge: readGraphGitMetadata(graphFile) }
    const domainFile = path.join(uaDir, 'domain-graph.json')
    if (fs.existsSync(domainFile)) inputs.domain = readGraphGitMetadata(domainFile)
    return { ok: true, payload: { graphs: await core.getGraphFreshnessBatch(projectRoot, inputs) } }
  } catch {
    return { ok: false, statusCode: 500, error: 'Failed to read graph freshness' }
  }
}

// ── Route registration ──────────────────────────

export function registerUnderstandDashboardDataRoutes(
  app: FastifyInstance,
  resolveProjectRoot: (request: FastifyRequest) => string,
): void {
  const sendJson = (reply: FastifyReply, statusCode: number, payload: unknown) =>
    reply.code(statusCode).header('Content-Type', 'application/json').send(JSON.stringify(payload))

  /** Serve a project JSON file, with node paths made project-relative. */
  const registerSanitizedFile = (urlPath: string, fileName: string, missing: (reply: FastifyReply) => unknown) => {
    app.get(urlPath, async (request, reply) => {
      const projectRoot = resolveProjectRoot(request)
      const file = path.join(resolveUADir(projectRoot), fileName)
      if (!fs.existsSync(file)) return missing(reply)
      try {
        return sendJson(reply, 200, relativizeNodePaths(readJsonObject(file), projectRoot))
      } catch {
        // Refuse rather than risk sending an unsanitised file.
        return sendJson(reply, 500, { error: 'Failed to read graph file' })
      }
    })
  }

  registerSanitizedFile('/knowledge-graph.json', 'knowledge-graph.json', (reply) =>
    sendJson(reply, 404, { error: 'No knowledge graph found. Run /understand first.' }),
  )
  // Optional files: an empty 404 means "not generated", which the dashboard treats as absent.
  const optionalMissing = (reply: FastifyReply) => reply.code(404).send()
  registerSanitizedFile('/domain-graph.json', 'domain-graph.json', optionalMissing)
  registerSanitizedFile('/diff-overlay.json', 'diff-overlay.json', optionalMissing)
  registerSanitizedFile('/meta.json', 'meta.json', optionalMissing)

  app.get('/config.json', async (request, reply) => {
    const file = path.join(resolveUADir(resolveProjectRoot(request)), 'config.json')
    if (!fs.existsSync(file)) return sendJson(reply, 200, { autoUpdate: false, outputLanguage: 'en' })
    try {
      return sendJson(reply, 200, readJsonObject(file))
    } catch {
      return sendJson(reply, 500, { error: 'Failed to read config file' })
    }
  })

  app.get('/code-lessons.json', async (request, reply) => {
    const file = path.join(resolveUADir(resolveProjectRoot(request)), 'code-lessons.json')
    if (!fs.existsSync(file)) return reply.code(404).send()
    try {
      return reply.header('Content-Type', 'application/json').send(fs.readFileSync(file, 'utf-8'))
    } catch {
      return sendJson(reply, 500, { error: 'Failed to read code lessons file' })
    }
  })

  app.get('/file-content.json', async (request, reply) => {
    const requestedPath = (request.query as { path?: string })?.path ?? ''
    const result = readSourceFile(resolveProjectRoot(request), requestedPath)
    return result.ok ? sendJson(reply, 200, result.payload) : sendJson(reply, result.statusCode, { error: result.error })
  })

  app.get('/staleness.json', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const result = await readFreshness(resolveProjectRoot(request))
    return result.ok ? sendJson(reply, 200, result.payload) : sendJson(reply, result.statusCode, { error: result.error })
  })
}
