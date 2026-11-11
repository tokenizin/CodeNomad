/**
 * Understand-Anything dashboard — serves the plugin's prebuilt dashboard UI.
 *
 * Endpoints:
 *   GET /understand                       — Dashboard page. `?projectRoot=<abs path>` selects the
 *                                           project it shows (remembered in a cookie, see below).
 *   GET /understand/assets/*              — Dashboard bundle (JS/CSS/images)
 *   GET /knowledge-graph.json             — Graph data the dashboard fetches. The root path is
 *                                           hardcoded by the dashboard bundle, so it cannot move
 *                                           under /api/.
 *   GET /api/understand/dashboard-status  — Cheap "can the dashboard be opened?" probe for the UI
 *   GET /api/understand/dashboard         — Legacy alias; redirects to /understand
 *
 * The page lives outside /api/ so browser navigations get the normal /login redirect. The
 * session gate for /understand* and /knowledge-graph.json is in http-server.ts and uses the
 * path constants exported here.
 *
 * The bundle requests /knowledge-graph.json without a query string, so the project chosen via
 * /understand?projectRoot= is carried in a short-lived cookie. Two tabs showing different
 * projects therefore share it, and the most recently opened page wins.
 *
 * @module understand-dashboard-routes
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fs from 'fs'
import path from 'path'
import { parseCookies } from '../../auth/http-auth.js'
import { readKnowledgeGraph, resolvePluginRoot } from './understand-anything.js'

/** Browser-facing path of the dashboard page (keep in sync with the UI and auth gate). */
export const DASHBOARD_PATH = '/understand'
/** Path the dashboard bundle fetches its graph from. */
export const KNOWLEDGE_GRAPH_PATH = '/knowledge-graph.json'

const PROJECT_ROOT_COOKIE = 'ua_project_root'
const PROJECT_ROOT_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export type DashboardAvailability =
  | { available: true; indexHtml: string; assetsDir: string }
  | { available: false; reason: 'not-installed' | 'not-built' }

/** Resolved per request so installing/building the plugin takes effect without a server restart. */
export function resolveDashboard(): DashboardAvailability {
  const pluginRoot = resolvePluginRoot()
  if (!pluginRoot) return { available: false, reason: 'not-installed' }
  const distDir = path.join(pluginRoot, 'packages/dashboard/dist')
  const indexHtml = path.join(distDir, 'index.html')
  if (!fs.existsSync(indexHtml)) return { available: false, reason: 'not-built' }
  return { available: true, indexHtml, assetsDir: path.resolve(distDir, 'assets') }
}

function unavailableHtml(reason: 'not-installed' | 'not-built'): string {
  return reason === 'not-installed'
    ? '<h1>Understand-Anything not installed</h1><p>Run: npx @understand-anything/init</p>'
    : '<h1>Dashboard not built</h1><p>Run: cd packages/dashboard && npm run build</p>'
}

/** Accepts only absolute paths so a stray relative value cannot resolve against the server cwd. */
function sanitizeProjectRoot(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) return null
  return path.normalize(trimmed)
}

function readProjectRootCookie(request: FastifyRequest): string | null {
  const raw = parseCookies(request.headers.cookie)[PROJECT_ROOT_COOKIE]
  if (!raw) return null
  try {
    return sanitizeProjectRoot(decodeURIComponent(raw))
  } catch {
    return null
  }
}

function setProjectRootCookie(reply: FastifyReply, projectRoot: string): void {
  reply.header(
    'Set-Cookie',
    `${PROJECT_ROOT_COOKIE}=${encodeURIComponent(projectRoot)}; Path=/; Max-Age=${PROJECT_ROOT_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`,
  )
}

export function registerUnderstandDashboardRoutes(app: FastifyInstance): void {
  app.get('/api/understand/dashboard-status', async (_request, reply) => {
    const dashboard = resolveDashboard()
    return reply.send(
      dashboard.available ? { available: true } : { available: false, reason: dashboard.reason },
    )
  })

  app.get(DASHBOARD_PATH, async (request, reply) => {
    const projectRoot = sanitizeProjectRoot((request.query as { projectRoot?: string })?.projectRoot)
    if (projectRoot) setProjectRootCookie(reply, projectRoot)

    reply.header('Content-Type', 'text/html; charset=utf-8')
    const dashboard = resolveDashboard()
    if (!dashboard.available) {
      return reply.code(503).send(unavailableHtml(dashboard.reason))
    }
    // Rewrite asset paths from /assets/ to /understand/assets/
    let html = fs.readFileSync(dashboard.indexHtml, 'utf-8')
    html = html.replace(/src="\/assets\//g, `src="${DASHBOARD_PATH}/assets/`)
    html = html.replace(/href="\/assets\//g, `href="${DASHBOARD_PATH}/assets/`)
    return reply.send(html)
  })

  // Legacy location of the dashboard page; keep the query so ?projectRoot= survives.
  app.get('/api/understand/dashboard', async (request, reply) => {
    const queryIndex = request.url.indexOf('?')
    const query = queryIndex >= 0 ? request.url.slice(queryIndex) : ''
    return reply.redirect(`${DASHBOARD_PATH}${query}`)
  })

  app.get(`${DASHBOARD_PATH}/assets/*`, async (request, reply) => {
    const dashboard = resolveDashboard()
    if (!dashboard.available) return reply.code(404).send('Not found')
    // The wildcard excludes the "assets/" segment, but the bundle keeps files in dist/assets/.
    const assetPath = path.resolve(dashboard.assetsDir, (request.params as any)['*'] ?? '')
    // Reject ../ traversal out of the dashboard bundle.
    if (!assetPath.startsWith(dashboard.assetsDir + path.sep)) {
      return reply.code(404).send('Not found')
    }
    if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
      return reply.code(404).send('Not found')
    }
    reply.header('Content-Type', CONTENT_TYPES[path.extname(assetPath)] ?? 'application/octet-stream')
    return reply.send(fs.readFileSync(assetPath))
  })

  app.get(KNOWLEDGE_GRAPH_PATH, async (request, reply) => {
    const projectRoot =
      sanitizeProjectRoot((request.query as { projectRoot?: string })?.projectRoot) ??
      readProjectRootCookie(request) ??
      process.cwd()
    try {
      const graph = await readKnowledgeGraph(projectRoot)
      reply.header('Content-Type', 'application/json')
      return reply.send(graph)
    } catch (err: any) {
      return reply.code(404).send({ error: err.message })
    }
  })
}
