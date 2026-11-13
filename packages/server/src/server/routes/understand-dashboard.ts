/**
 * Understand-Anything dashboard — serves the plugin's prebuilt dashboard UI.
 *
 * Endpoints:
 *   GET /understand                       — Dashboard page. `?projectRoot=<abs path>` selects the
 *                                           project it shows (remembered in a cookie, see below).
 *   GET /understand/assets/*              — Dashboard bundle (JS/CSS/images)
 *   GET /knowledge-graph.json, /domain-graph.json, /diff-overlay.json, /meta.json,
 *       /config.json, /code-lessons.json, /file-content.json, /staleness.json
 *                                         — Data the dashboard fetches (see
 *                                           understand-dashboard-data.ts). The root paths are
 *                                           hardcoded by the dashboard bundle, so they cannot
 *                                           move under /api/.
 *   GET /api/understand/dashboard-status  — Cheap "can the dashboard be opened?" probe for the UI
 *   GET /api/understand/dashboard         — Legacy alias; redirects to /understand
 *
 * The page lives outside /api/ so browser navigations get the normal /login redirect. The
 * session gate for /understand* and the data paths is in http-server.ts and uses
 * isUnderstandDashboardPath() from here.
 *
 * The plugin's SPA shows an "Access Token Required" gate unless the URL carries `?token=` (or
 * sessionStorage already has one), because its standalone viewer protects a local port with a
 * one-time secret. Here CodeNomad's session gate already protects the page and graph, and the
 * graph route ignores `token`, so /understand redirects to itself with a fixed, non-secret
 * placeholder token. The SPA stores it in sessionStorage, strips it from the address bar and sends
 * it back on its data requests. The placeholder is deliberately NOT derived from the session
 * cookie, so nothing sensitive ends up in a URL or in the browser history.
 *
 * The bundle requests its data files without a projectRoot, so the project chosen via
 * /understand?projectRoot= is carried in a short-lived cookie. Two tabs showing different
 * projects therefore share it, and the most recently opened page wins.
 *
 * @module understand-dashboard-routes
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fs from 'fs'
import path from 'path'
import { parseCookies } from '../../auth/http-auth.js'
import { resolvePluginRoot } from './understand-anything.js'
import { DASHBOARD_DATA_PATHS, registerUnderstandDashboardDataRoutes } from './understand-dashboard-data.js'

/** Browser-facing path of the dashboard page (keep in sync with the UI and auth gate). */
export const DASHBOARD_PATH = '/understand'

/** True for the dashboard page, its assets and the data files it fetches; all need a session. */
export function isUnderstandDashboardPath(pathname: string): boolean {
  return pathname === DASHBOARD_PATH || pathname.startsWith(`${DASHBOARD_PATH}/`) || DASHBOARD_DATA_PATHS.has(pathname)
}

/**
 * Satisfies the dashboard SPA's token gate. Not a credential: access is enforced by the CodeNomad
 * session (see http-server.ts), which this value is never derived from or checked against.
 */
export const DASHBOARD_PLACEHOLDER_TOKEN = 'codenomad-session'

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

/** Project for a request: ?projectRoot= > cookie set by /understand > server cwd. */
function resolveRequestProjectRoot(request: FastifyRequest): string {
  return (
    sanitizeProjectRoot((request.query as { projectRoot?: string })?.projectRoot) ??
    readProjectRootCookie(request) ??
    process.cwd()
  )
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
    const query = request.query as { projectRoot?: string; token?: string }
    const projectRoot = sanitizeProjectRoot(query?.projectRoot)
    if (projectRoot) setProjectRootCookie(reply, projectRoot)

    const dashboard = resolveDashboard()
    if (!dashboard.available) {
      reply.header('Content-Type', 'text/html; charset=utf-8')
      return reply.code(503).send(unavailableHtml(dashboard.reason))
    }

    // Skip the SPA's "Access Token Required" gate for users who already passed CodeNomad auth.
    if (!query?.token) {
      const params = new URLSearchParams(request.url.split('?')[1] ?? '')
      params.set('token', DASHBOARD_PLACEHOLDER_TOKEN)
      return reply.redirect(`${DASHBOARD_PATH}?${params.toString()}`)
    }

    // Rewrite asset paths from /assets/ to /understand/assets/
    let html = fs.readFileSync(dashboard.indexHtml, 'utf-8')
    html = html.replace(/src="\/assets\//g, `src="${DASHBOARD_PATH}/assets/`)
    html = html.replace(/href="\/assets\//g, `href="${DASHBOARD_PATH}/assets/`)
    reply.header('Content-Type', 'text/html; charset=utf-8')
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

  registerUnderstandDashboardDataRoutes(app, resolveRequestProjectRoot)
}
