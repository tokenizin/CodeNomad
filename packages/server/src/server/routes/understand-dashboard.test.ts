import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { registerUnderstandAnythingRoutes } from './understand-anything'
import {
  DASHBOARD_PLACEHOLDER_TOKEN,
  isUnderstandDashboardPath,
  registerUnderstandDashboardRoutes,
} from './understand-dashboard'

let tmp: string
let project: string
let plugin: string
let pluginNoFreshness: string
let outside: string
const savedPluginRoot = process.env.UNDERSTAND_PLUGIN_ROOT

function write(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function makePlugin(dir: string, coreSource?: string) {
  write(path.join(dir, 'package.json'), '{}')
  write(path.join(dir, 'packages/dashboard/dist/index.html'), '<script src="/assets/app.js"></script><link href="/assets/app.css">')
  write(path.join(dir, 'packages/dashboard/dist/assets/app.js'), 'console.log(1)')
  write(path.join(dir, 'packages/dashboard/dist/assets/app.css'), 'body{}')
  write(path.join(dir, 'packages/dashboard/secret.txt'), 'SECRET')
  if (coreSource) write(path.join(dir, 'packages/core/dist/index.js'), coreSource)
}

function createApp() {
  const app = Fastify({ logger: false })
  registerUnderstandAnythingRoutes(app)
  registerUnderstandDashboardRoutes(app)
  return app
}

const enc = encodeURIComponent
const cookieFor = (root: string) => `ua_project_root=${enc(root)}`

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ua-dashboard-')))
  project = path.join(tmp, 'proj')
  outside = path.join(tmp, 'outside')
  plugin = path.join(tmp, 'plugin')
  pluginNoFreshness = path.join(tmp, 'plugin-old')

  makePlugin(
    plugin,
    `export function getGraphFreshnessBatch(dir, inputs) {
       const out = {}
       for (const k of Object.keys(inputs)) out[k] = { status: 'fresh', dir, hash: inputs[k].graphCommitHash ?? null }
       return Promise.resolve(out)
     }`,
  )
  makePlugin(pluginNoFreshness, 'export const SearchEngine = class {}')

  write(
    path.join(project, '.understand-anything/knowledge-graph.json'),
    JSON.stringify({
      project: { gitCommitHash: 'abc123', analyzedAt: '2026-01-01T00:00:00Z' },
      nodes: [
        { id: 'a', filePath: path.join(project, 'src/a.ts') },
        { id: 'b', filePath: 'src/b.ts' },
        { id: 'c', filePath: '/elsewhere/leak/secret.ts' },
        { id: 'sib', filePath: project + '-sibling/x.ts' },
        { id: 'big', filePath: 'src/big.ts' },
        { id: 'bin', filePath: 'src/bin.dat' },
        { id: 'link', filePath: 'src/link.ts' },
        { id: 'esc', filePath: '../outside/stolen.ts' },
      ],
      edges: [],
    }),
  )
  write(path.join(project, 'src/a.ts'), 'const a = 1\nconst b = 2\n')
  write(path.join(project, 'src/b.ts'), 'export {}\n')
  write(path.join(project, 'src/unlisted.ts'), 'not in graph')
  write(path.join(project, 'src/big.ts'), 'x'.repeat(1024 * 1024 + 1))
  write(path.join(project, 'src/bin.dat'), Buffer.from([0x41, 0x00, 0x42]))
  write(path.join(outside, 'stolen.ts'), 'STOLEN')
  fs.symlinkSync(path.join(outside, 'stolen.ts'), path.join(project, 'src/link.ts'))
  write(path.join(project, '.understand-anything/domain-graph.json'), JSON.stringify({ project: { gitCommitHash: 'def456' }, nodes: [{ id: 'd', filePath: path.join(project, 'src/a.ts') }] }))
  write(path.join(project, '.understand-anything/meta.json'), JSON.stringify({ theme: { accent: 'gold' } }))

  process.env.UNDERSTAND_PLUGIN_ROOT = plugin
})

after(() => {
  if (savedPluginRoot === undefined) delete process.env.UNDERSTAND_PLUGIN_ROOT
  else process.env.UNDERSTAND_PLUGIN_ROOT = savedPluginRoot
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('dashboard page and token gate', () => {
  it('redirects to itself with the placeholder token, keeping projectRoot, and sets the project cookie', async () => {
    const res = await createApp().inject({ method: 'GET', url: `/understand?projectRoot=${enc(project)}` })
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, `/understand?projectRoot=${enc(project)}&token=${DASHBOARD_PLACEHOLDER_TOKEN}`)
    assert.match(String(res.headers['set-cookie']), /^ua_project_root=.*HttpOnly.*SameSite=Lax/)
  })

  it('serves the page with rewritten asset URLs once the token is present', async () => {
    const res = await createApp().inject({ method: 'GET', url: `/understand?token=${DASHBOARD_PLACEHOLDER_TOKEN}` })
    assert.equal(res.statusCode, 200)
    assert.match(res.body, /src="\/understand\/assets\/app\.js"/)
    assert.match(res.body, /href="\/understand\/assets\/app\.css"/)
  })

  it('ignores a relative projectRoot (no cookie)', async () => {
    const res = await createApp().inject({ method: 'GET', url: `/understand?projectRoot=relative/path&token=x` })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['set-cookie'], undefined)
  })

  it('keeps the query when redirecting the legacy alias', async () => {
    const res = await createApp().inject({ method: 'GET', url: `/api/understand/dashboard?projectRoot=${enc(project)}` })
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, `/understand?projectRoot=${enc(project)}`)
  })

  it('serves assets from dist/assets and refuses traversal', async () => {
    const app = createApp()
    const ok = await app.inject({ method: 'GET', url: '/understand/assets/app.js' })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.headers['content-type'], 'application/javascript')
    for (const url of ['/understand/assets/..%2Fsecret.txt', '/understand/assets/..%2F..%2Fsecret.txt', '/understand/assets/']) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404, url)
    }
  })

  it('reports availability and answers 503 HTML when the plugin is missing', async () => {
    process.env.UNDERSTAND_PLUGIN_ROOT = path.join(tmp, 'nope')
    const savedHome = process.env.HOME
    process.env.HOME = path.join(tmp, 'no-home')
    try {
      const app = createApp()
      const status = await app.inject({ method: 'GET', url: '/api/understand/dashboard-status' })
      assert.deepEqual(status.json(), { available: false, reason: 'not-installed' })
      const page = await app.inject({ method: 'GET', url: '/understand' })
      assert.equal(page.statusCode, 503)
      assert.match(String(page.headers['content-type']), /text\/html/)
    } finally {
      process.env.UNDERSTAND_PLUGIN_ROOT = plugin
      process.env.HOME = savedHome
    }
    const ok = await createApp().inject({ method: 'GET', url: '/api/understand/dashboard-status' })
    assert.deepEqual(ok.json(), { available: true })
  })
})

describe('auth gate predicate', () => {
  it('covers the page, its assets and every data file, and nothing else', () => {
    for (const p of ['/understand', '/understand/assets/app.js', '/knowledge-graph.json', '/domain-graph.json', '/diff-overlay.json', '/meta.json', '/config.json', '/code-lessons.json', '/file-content.json', '/staleness.json']) {
      assert.equal(isUnderstandDashboardPath(p), true, p)
    }
    for (const p of ['/', '/understanding', '/understand-other', '/api/understand/status', '/login']) {
      assert.equal(isUnderstandDashboardPath(p), false, p)
    }
  })
})

describe('data endpoints', () => {
  const get = (url: string, root: string | null = project) =>
    createApp().inject({ method: 'GET', url, headers: root ? { cookie: cookieFor(root) } : {} })

  it('serves the graph with project-relative node paths and no host layout leaking', async () => {
    const res = await get('/knowledge-graph.json?token=whatever')
    assert.equal(res.statusCode, 200)
    const byId = Object.fromEntries(res.json().nodes.map((n: any) => [n.id, n.filePath]))
    assert.equal(byId.a, 'src/a.ts')
    assert.equal(byId.b, 'src/b.ts')
    assert.equal(byId.c, 'secret.ts') // absolute, outside the project: basename only
    assert.equal(byId.sib, 'x.ts') // sibling dir sharing the project's name as a prefix is NOT inside it
    assert.ok(!res.body.includes(project))
  })

  it('selects the project from ?projectRoot= over the cookie', async () => {
    const res = await createApp().inject({
      method: 'GET',
      url: `/knowledge-graph.json?projectRoot=${enc(project)}`,
      headers: { cookie: cookieFor(path.join(tmp, 'other')) },
    })
    assert.equal(res.statusCode, 200)
  })

  it('answers 404 JSON for a missing graph', async () => {
    const res = await get('/knowledge-graph.json', path.join(tmp, 'empty'))
    assert.equal(res.statusCode, 404)
    assert.match(res.json().error, /No knowledge graph/)
  })

  it('sanitises the domain graph too and serves meta.json', async () => {
    const domain = await get('/domain-graph.json')
    assert.equal(domain.json().nodes[0].filePath, 'src/a.ts')
    assert.deepEqual((await get('/meta.json')).json(), { theme: { accent: 'gold' } })
  })

  it('answers an empty 404 for absent optional files', async () => {
    for (const url of ['/diff-overlay.json', '/code-lessons.json']) {
      const res = await get(url)
      assert.equal(res.statusCode, 404, url)
      assert.equal(res.body, '')
    }
  })

  it('defaults config.json and serves a project one when present', async () => {
    assert.deepEqual((await get('/config.json')).json(), { autoUpdate: false, outputLanguage: 'en' })
    write(path.join(project, '.understand-anything/config.json'), JSON.stringify({ autoUpdate: true, outputLanguage: 'fr' }))
    assert.deepEqual((await get('/config.json')).json(), { autoUpdate: true, outputLanguage: 'fr' })
    fs.rmSync(path.join(project, '.understand-anything/config.json'))
  })

  it('serves code-lessons.json verbatim when present', async () => {
    write(path.join(project, '.understand-anything/code-lessons.json'), '{"lessons":[1]}')
    assert.equal((await get('/code-lessons.json')).body, '{"lessons":[1]}')
    fs.rmSync(path.join(project, '.understand-anything/code-lessons.json'))
  })

  it('does not let a corrupt graph file through unsanitised', async () => {
    const broken = path.join(tmp, 'broken')
    write(path.join(broken, '.understand-anything/knowledge-graph.json'), '{not json /Users/secret')
    const res = await get('/knowledge-graph.json', broken)
    assert.equal(res.statusCode, 500)
    assert.ok(!res.body.includes('/Users/secret'))
  })
})

describe('/file-content.json', () => {
  const get = (rel: string) =>
    createApp().inject({ method: 'GET', url: `/file-content.json?path=${enc(rel)}`, headers: { cookie: cookieFor(project) } })

  it('previews a file listed in the graph, via an absolute or relative graph path', async () => {
    const a = await get('src/a.ts')
    assert.equal(a.statusCode, 200)
    assert.deepEqual(a.json(), { path: 'src/a.ts', language: 'typescript', content: 'const a = 1\nconst b = 2\n', sizeBytes: 24, lineCount: 3 })
    assert.equal((await get('src/b.ts')).statusCode, 200)
  })

  it('rejects missing, absolute, traversing and unlisted paths', async () => {
    assert.equal((await get('')).statusCode, 400)
    assert.equal((await get(path.join(project, 'src/a.ts'))).statusCode, 400)
    assert.equal((await get('../outside/stolen.ts')).statusCode, 400)
    assert.equal((await get('src/../../outside/stolen.ts')).statusCode, 400)
    const unlisted = await get('src/unlisted.ts')
    assert.equal(unlisted.statusCode, 404)
    assert.equal((await get('.understand-anything/knowledge-graph.json')).statusCode, 404)
  })

  it('refuses a symlink that points outside the project', async () => {
    const res = await get('src/link.ts')
    assert.equal(res.statusCode, 400)
    assert.ok(!res.body.includes('STOLEN'))
  })

  it('refuses oversized and binary files', async () => {
    assert.equal((await get('src/big.ts')).statusCode, 413)
    assert.equal((await get('src/bin.dat')).statusCode, 415)
  })
})

describe('/staleness.json', () => {
  const get = () => createApp().inject({ method: 'GET', url: '/staleness.json', headers: { cookie: cookieFor(project) } })

  it('reports freshness for the knowledge and domain graphs through the plugin core', async () => {
    const res = await get()
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.deepEqual(res.json(), {
      graphs: {
        knowledge: { status: 'fresh', dir: project, hash: 'abc123' },
        domain: { status: 'fresh', dir: project, hash: 'def456' },
      },
    })
  })

  it('answers 501 when the installed plugin predates the freshness report', async () => {
    process.env.UNDERSTAND_PLUGIN_ROOT = pluginNoFreshness
    try {
      assert.equal((await get()).statusCode, 501)
    } finally {
      process.env.UNDERSTAND_PLUGIN_ROOT = plugin
    }
  })

  it('answers 404 when the project has no graph', async () => {
    const res = await createApp().inject({ method: 'GET', url: '/staleness.json', headers: { cookie: cookieFor(path.join(tmp, 'empty')) } })
    assert.equal(res.statusCode, 404)
  })
})
