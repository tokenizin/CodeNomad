/**
 * Git Graph bridge — hosts the vendored VS Code "Git Graph" extension
 * (resources/git-graph, MIT © Marcus Hutchie) on the CodeNomad server and
 * bridges its webview message protocol to a browser page.
 *
 * How it works:
 *  - The extension's compiled CommonJS (`out/*.js`) is loaded unmodified.
 *    Its `require("vscode")` resolves to the shim package at
 *    `resources/git-graph/node_modules/vscode`, which proxies to
 *    `globalThis.__gitGraphVscodeShim` — installed here per active bridge.
 *  - The real `GitGraphView` is instantiated against the real `DataSource` /
 *    `RepoManager` for one repository, so the full protocol (checkout, merge,
 *    rebase, stash, tags, commit details, compare, …) works untouched.
 *  - The webview HTML the extension generates for its fake panel is captured,
 *    post-processed (CSP stripped, bootstrap injected) and served by the
 *    git-graph routes; `acquireVsCodeApi().postMessage` maps to
 *    `POST <prefix>/__request` and `webview.postMessage` to SSE on
 *    `<prefix>/__events` (see routes/git-graph.ts + the UI tab).
 *
 * Extension singletons (the fake panel, the vscode shim, the view class's
 * static current panel) mean one bridge is active per server process. Opening
 * a second repository disposes the previous bridge — the same
 * "most-recently-opened page wins" tradeoff the Understand-Anything dashboard
 * makes. Bridges idle-dispose after IDLE_MS.
 *
 * @module gitgraph/bridge
 */

import cp from "child_process"
import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { createRequire } from "module"
import type { ServerResponse } from "http"
import type { Logger } from "../logger"
import { gitGraphThemeCss } from "./theme.js"

/* ------------------------------------------------------------------ */
/* Vendored extension location                                         */
/* ------------------------------------------------------------------ */

/** src/gitgraph/bridge.ts (bun/dev) and dist/gitgraph/bridge.js (tsc) both
 * resolve to packages/server/resources/git-graph. */
function resolveExtensionRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    path.resolve(here, "../../resources/git-graph"), // src/gitgraph + dist/gitgraph
    path.resolve(process.cwd(), "packages/server/resources/git-graph"),
    path.resolve(process.cwd(), "resources/git-graph"),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "out/gitGraphView.js"))) return dir
  }
  throw new Error(`[gitgraph] vendored extension not found (tried: ${candidates.join(", ")})`)
}

export const EXTENSION_ROOT = resolveExtensionRoot()
export const isGitGraphExtensionVendored = (): boolean => fs.existsSync(path.join(EXTENSION_ROOT, "out/gitGraphView.js"))

const IDLE_MS = 15 * 60_000
const EXT_VERSION = "1.30.0"

/* ------------------------------------------------------------------ */
/* Bridge                                                              */
/* ------------------------------------------------------------------ */

type LogLike = Pick<Logger, "info" | "warn" | "error" | "debug">

interface BridgeInit {
  repoPath: string
  urlPrefix: string // e.g. /gitgraph/<workspaceId>
  logger: LogLike
}

// biome-ignore lint/suspicious/noExplicitAny: the vscode API is intentionally untyped here
type VscodeLike = any

/** One extension module namespace bag (classes are require-cached across bridges). */
interface ExtensionModules {
  Logger: new () => { log(m: string): void; logError(m: string): void }
  EventEmitter: new <T>() => { subscribe: (cb: (v: T) => void) => { dispose(): void }; emit(v: T): void }
  ExtensionState: new (context: VscodeLike, onDidChangeGitExecutable: unknown) => VscodeLike
  findGit: (extensionState: VscodeLike) => Promise<{ path: string; version: string }>
  DataSource: new (gitExecutable: VscodeLike, onDidChangeConfiguration: unknown, onDidChangeGitExecutable: unknown, logger: VscodeLike) => VscodeLike
  AvatarManager: new (dataSource: VscodeLike, extensionState: VscodeLike, logger: VscodeLike) => VscodeLike
  RepoManager: new (dataSource: VscodeLike, extensionState: VscodeLike, onDidChangeConfiguration: unknown, logger: VscodeLike) => VscodeLike
  GitGraphView: new (extensionPath: string, dataSource: VscodeLike, extensionState: VscodeLike, avatarManager: VscodeLike, repoManager: VscodeLike, logger: VscodeLike, loadViewTo: null, column: number) => { respondToMessage(msg: unknown): Promise<void>; dispose(): void }
}

let extensionModules: ExtensionModules | null = null
let guardsInstalled = false

/** Install the extension classes once, with the global vscode shim active. */
async function loadExtension(logger: LogLike): Promise<ExtensionModules> {
  if (extensionModules) return extensionModules

  if (!guardsInstalled) {
    guardsInstalled = true
    // A malformed client message can reject inside the extension's async git
    // pipelines; the process must survive it (VS Code isolates webview handlers).
    process.on("unhandledRejection", (e) => logger.warn({ err: e }, "[gitgraph] unhandledRejection (contained)"))
    process.on("uncaughtException", (e) => logger.error({ err: e }, "[gitgraph] uncaughtException (contained)"))
  }

  const require = createRequire(import.meta.url)
  // The extension's require("vscode") lands on resources/git-graph/node_modules/vscode,
  // which reads this global on every property access. A stub shim is active
  // during module load (constants are read at require time); the live shim is
  // swapped in per bridge below.
  ;(globalThis as VscodeLike).__gitGraphVscodeShim ??= createVscodeShimStub(logger)
  try {
    extensionModules = {
      Logger: require(path.join(EXTENSION_ROOT, "out/logger.js")).Logger,
      EventEmitter: require(path.join(EXTENSION_ROOT, "out/utils/event.js")).EventEmitter,
      ExtensionState: require(path.join(EXTENSION_ROOT, "out/extensionState.js")).ExtensionState,
      findGit: require(path.join(EXTENSION_ROOT, "out/utils.js")).findGit,
      DataSource: require(path.join(EXTENSION_ROOT, "out/dataSource.js")).DataSource,
      AvatarManager: require(path.join(EXTENSION_ROOT, "out/avatarManager.js")).AvatarManager,
      RepoManager: require(path.join(EXTENSION_ROOT, "out/repoManager.js")).RepoManager,
      GitGraphView: require(path.join(EXTENSION_ROOT, "out/gitGraphView.js")).GitGraphView,
    }
    return extensionModules
  } finally {
    // keep a stub active so no stray code outside a live bridge uses the shim
    ;(globalThis as VscodeLike).__gitGraphVscodeShim = createVscodeShimStub(logger)
  }
}

/* ------------------------------------------------------------------ */
/* vscode API shim (surface = what the vendored modules actually touch) */
/* ------------------------------------------------------------------ */

interface DisposableLike { dispose(): void }
const disposable = (): DisposableLike => ({ dispose: () => {} })

/** A fully-formed shim bound to an inert panel. Installed as the global shim
 * while extension modules are require()d — some of them (config.js) read
 * vscode constants at module load. Replaced by the live per-bridge shim before
 * any extension instance is constructed. */
function createVscodeShimStub(logger: LogLike): VscodeLike {
  const inertPanel: PanelHandle = { visible: false, html: "", clients: new Set(), receive: null }
  return createVscodeShim({ repoPath: process.cwd(), panel: inertPanel, logger, baseUrl: "" })
}

function makeUri(p: string): VscodeLike {
  const u: VscodeLike = { fsPath: p, path: p, scheme: "file", authority: "", fragment: "", query: "" }
  u.with = (opts: { fsPath?: string }) => makeUri(opts?.fsPath ?? p)
  u.toString = () => (u.scheme === "file" ? `file://${p}` : `${u.scheme}:${p}`)
  return u
}

interface PanelHandle {
  visible: boolean
  html: string
  clients: Set<ServerResponse>
  receive: ((msg: unknown) => Promise<void>) | null
}

function createVscodeShim(opts: {
  repoPath: string
  panel: PanelHandle
  logger: LogLike
  baseUrl: string
}): VscodeLike {
  const { repoPath, panel, logger } = opts

  const broadcast = (msg: unknown) => {
    const body = `data: ${JSON.stringify(msg)}\n\n`
    for (const res of panel.clients) {
      try { res.write(body) } catch { /* client gone; removed on close */ }
    }
  }

  const macTerminal = (script: string) => {
    if (process.platform !== "darwin") return
    cp.spawn("osascript", [
      "-e", "tell application \"Terminal\" to activate",
      "-e", "tell application \"Terminal\" to do script " + JSON.stringify(script),
    ], { stdio: "ignore" }).on("error", () => {})
  }

  const fakeWebview = {
    get html(): string { return panel.html },
    set html(v: string) { panel.html = v },
    cspSource: "vscode-webview://codenomad-gitgraph",
    asWebviewUri: (uri: { fsPath: string }) => `${opts.baseUrl}/media/${encodeURIComponent(path.basename(uri.fsPath))}`,
    postMessage: (msg: unknown) => { broadcast(msg); return Promise.resolve(true) },
    onDidReceiveMessage: (cb: (msg: unknown) => Promise<void>) => { panel.receive = cb; return disposable() },
  }

  const fakePanel = {
    visible: true,
    webview: fakeWebview,
    onDidDispose: () => disposable(),
    onDidChangeViewState: () => disposable(),
    reveal() {}, hide() {}, show() {}, dispose() {},
  }

  const memento = () => {
    const m = new Map<string, unknown>()
    return {
      get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
      update: (k: string, v: unknown) => Promise.resolve(v === undefined ? m.delete(k) : m.set(k, v)),
      keys: () => Array.from(m.keys()),
    }
  }
  void memento

  class Disposable {
    private fn: () => void
    constructor(fn?: () => void) { this.fn = fn ?? (() => {}) }
    dispose() { this.fn() }
    static from(...items: DisposableLike[]) { return new Disposable(() => items.forEach((i) => i?.dispose?.())) }
  }

  class EventEmitter {
    private cbs: Array<(v: unknown) => void> = []
    event = (cb: (v: unknown) => void) => {
      this.cbs.push(cb)
      return disposable()
    }
    fire(v: unknown) { this.cbs.slice().forEach((cb) => cb(v)) }
    dispose() { this.cbs = [] }
  }

  return {
    version: "1.60.0",
    Disposable,
    EventEmitter,
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class { id: string; constructor(id: string) { this.id = id } },
    RelativePattern: class { base: unknown; pattern: unknown; constructor(base: unknown, pattern: unknown) { this.base = base; this.pattern = pattern } },
    Uri: {
      file: makeUri,
      parse: (s: string) => makeUri(String(s)),
      joinPath: (u: { fsPath: string }, ...parts: string[]) => makeUri(path.join(u.fsPath, ...parts)),
    },
    window: {
      activeTextEditor: null,
      createWebviewPanel: () => fakePanel,
      createOutputChannel: () => ({
        append() {},
        appendLine: (l: string) => logger.debug(`[gitgraph/ext] ${String(l).trimEnd()}`),
        clear() {}, show() {}, hide() {}, replace() {}, dispose() {},
      }),
      showErrorMessage: (m: string) => { logger.warn(`[gitgraph] ext error message: ${m}`); return Promise.resolve(undefined) },
      showInformationMessage: (m: string) => { logger.debug(`[gitgraph] ext info: ${m}`); return Promise.resolve(undefined) },
      showWarningMessage: () => Promise.resolve(undefined),
      showSaveDialog: () => Promise.resolve(undefined),
      createTerminal: (o?: { cwd?: string; name?: string }) => {
        macTerminal(`cd ${JSON.stringify(o?.cwd ?? repoPath)}`)
        return { show() {}, hide() {}, dispose() {}, sendText: (t: string) => macTerminal(t), name: o?.name ?? "Git Graph" }
      },
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: "", tooltip: "", command: "" }),
    },
    workspace: {
      workspaceFolders: [{ uri: makeUri(repoPath), name: path.basename(repoPath), index: 0 }],
      getConfiguration: () => ({
        // every config read in the extension passes its own default
        get: (_key: string, def?: unknown) => def,
        has: () => false,
        inspect: () => undefined,
        update: () => Promise.resolve(),
      }),
      onDidChangeConfiguration: () => disposable(),
      onDidChangeWorkspaceFolders: () => disposable(),
      onDidCloseTextDocument: () => disposable(),
      createFileSystemWatcher: () => ({
        onDidCreate: () => disposable(),
        onDidChange: () => disposable(),
        onDidDelete: () => disposable(),
        dispose() {},
      }),
      registerTextDocumentContentProvider: () => disposable(),
      openTextDocument: () => Promise.reject(new Error("openTextDocument unavailable in the CodeNomad git-graph bridge")),
      asRelativePath: (p: string | { fsPath: string }) => path.relative(repoPath, typeof p === "string" ? p : p.fsPath),
    },
    commands: {
      executeCommand: () => Promise.resolve(null),
      getCommands: () => Promise.resolve([]),
    },
    env: {
      machineId: "codenomad-gitgraph",
      sessionId: crypto.randomBytes(8).toString("hex"),
      clipboard: {
        writeText: (text: string) => new Promise<void>((resolve, reject) => {
          const p = cp.spawn("pbcopy")
          p.on("error", reject)
          p.on("close", () => resolve())
          p.stdin?.end(String(text))
        }),
      },
      openExternal: (uri: { toString(): string }) => {
        cp.exec(`open ${JSON.stringify(String(uri.toString()))}`)
        return Promise.resolve(true)
      },
    },
    extensions: { getExtension: () => undefined, all: [] },
  }
}

/* ------------------------------------------------------------------ */
/* Bridge registry (single active bridge, idle disposal)               */
/* ------------------------------------------------------------------ */

export class GitGraphBridge {
  readonly repoPath: string
  urlPrefix: string
  private panel: PanelHandle = { visible: true, html: "", clients: new Set(), receive: null }
  private view: VscodeLike | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private logger: LogLike

  private constructor(init: BridgeInit) {
    this.repoPath = init.repoPath
    this.urlPrefix = init.urlPrefix
    this.logger = init.logger
  }

  static async create(init: BridgeInit): Promise<GitGraphBridge> {
    const bridge = new GitGraphBridge(init)
    await bridge.boot()
    return bridge
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.panel.clients.size === 0) {
        this.logger.info({ repo: this.repoPath }, "[gitgraph] idle — disposing bridge")
        this.dispose()
      } else {
        this.armIdle()
      }
    }, IDLE_MS)
    if (typeof this.idleTimer.unref === "function") this.idleTimer.unref()
  }

  touch() { this.armIdle() }

  get isDisposed() { return this.disposed }
  get htmlReady() { return this.panel.html.length > 0 }
  get clientCount() { return this.panel.clients.size }
  get html(): string {
    return this.renderHtml()
  }

  /** Render the page HTML, optionally pre-selecting the brand palette
   * (`light`/`dark`) so the first paint already matches the app theme. */
  renderHtml(theme?: string): string {
    const t = theme === "light" || theme === "dark" ? theme : undefined
    return postProcessHtml(this.panel.html, this.urlPrefix, t)
  }

  addClient(res: ServerResponse) {
    this.panel.clients.add(res)
    this.armIdle()
    res.on("close", () => this.panel.clients.delete(res))
  }

  async respond(msg: unknown) {
    if (this.disposed || !this.panel.receive) throw new Error("gitgraph bridge is not ready")
    this.armIdle()
    try {
      await this.panel.receive(msg)
    } catch (err) {
      // malformed client input reaches the extension's pipelines — contain it
      this.logger.warn({ err, command: (msg as { command?: string })?.command }, "[gitgraph] message handler error (contained)")
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    for (const res of this.panel.clients) { try { res.end() } catch { /* ignore */ } }
    this.panel.clients.clear()
    try { this.view?.dispose() } catch { /* extension disposal is best-effort */ }
    this.view = null
    if (activeBridge === this) activeBridge = null
  }

  private async boot() {
    const mods = await loadExtension(this.logger)
    const shim = createVscodeShim({
      repoPath: this.repoPath,
      panel: this.panel,
      logger: this.logger,
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      baseUrl: this.urlPrefix,
    })
    ;(globalThis as VscodeLike).__gitGraphVscodeShim = shim

    try {
      const storageDir = fs.mkdtempSync(path.join(/* turbopack ignore */ os.tmpdir(), "codenomad-gitgraph-"))
      const context = {
        subscriptions: { push() {} },
        globalState: mementoLike(),
        workspaceState: mementoLike(),
        globalStoragePath: storageDir,
        extensionPath: EXTENSION_ROOT,
        asAbsolutePath: (p: string) => path.join(EXTENSION_ROOT, p),
      }

      const extLogger = new mods.Logger()
      const gitExeEmitter = new mods.EventEmitter()
      const extensionState = new mods.ExtensionState(context, gitExeEmitter.subscribe)

      let gitExecutable: { path: string; version: string } | null = null
      try {
        gitExecutable = await mods.findGit(extensionState)
        gitExeEmitter.emit(gitExecutable)
        this.logger.info({ git: gitExecutable.path, version: gitExecutable.version }, "[gitgraph] git executable")
      } catch {
        this.logger.warn("[gitgraph] git executable not found — view will render in degraded mode")
      }

      const configurationEmitter = new mods.EventEmitter()
      const dataSource = new mods.DataSource(gitExecutable, configurationEmitter.subscribe, gitExeEmitter.subscribe, extLogger)
      const avatarManager = new mods.AvatarManager(dataSource, extensionState, extLogger)
      const repoManager = new mods.RepoManager(dataSource, extensionState, configurationEmitter.subscribe, extLogger)

      // RepoManager.startupTasks() scans workspace folders asynchronously —
      // the view renders once from current state, so wait for the scan.
      for (let i = 0; i < 100 && repoManager.getNumRepos() === 0; i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (repoManager.getNumRepos() === 0) {
        throw new Error(`git-graph repo scan found nothing under ${this.repoPath}`)
      }

      this.view = new mods.GitGraphView(EXTENSION_ROOT, dataSource, extensionState, avatarManager, repoManager, extLogger, null, 1)
      this.logger.info({ repo: this.repoPath }, "[gitgraph] bridge ready")
      this.armIdle()
    } catch (err) {
      // don't leave a half-booted live shim installed
      if ((globalThis as VscodeLike).__gitGraphVscodeShim === shim) {
        ;(globalThis as VscodeLike).__gitGraphVscodeShim = createVscodeShimStub(this.logger)
      }
      throw err
    }
  }
}

function mementoLike() {
  const m = new Map<string, unknown>()
  return {
    get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
    update: (k: string, v: unknown) => Promise.resolve(v === undefined ? m.delete(k) : m.set(k, v)),
    keys: () => Array.from(m.keys()),
  }
}

/* ------------------------------------------------------------------ */
/* HTML post-processing                                                */
/* ------------------------------------------------------------------ */

function bootstrapScript(): string {
  // Runs inside the captured webview HTML. Maps the VS Code webview API onto
  // the bridge: fetch POST → respondToMessage, SSE → window "message" events.
  return [
    "<script>(function(){ if (window.__ggBooted) return; window.__ggBooted = true;",
    "var KEY='codenomad-gg-state:'+location.pathname;",
    "window.acquireVsCodeApi = function(){ return {",
    "postMessage: function(m){ fetch(ROUTER+'/__request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)}).catch(function(e){console.error('[gitgraph] send failed',e);}); },",
    "getState: function(){ try { return JSON.parse(sessionStorage.getItem(KEY)); } catch(e){ return undefined; } },",
    "setState: function(s){ try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch(e){} return s; }",
    "}; };",
    "function listen(){ var es = new EventSource(ROUTER+'/__events');",
    "es.onmessage = function(e){ window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(e.data), origin: location.origin })); };",
    "es.onerror = function(){ es.close(); setTimeout(listen, 1500); }; } listen();",
    "})();</scr" + "ipt>",
  ].join("")
}

function postProcessHtml(rawHtml: string, urlPrefix: string, theme?: string): string {
  let html = rawHtml
  // The VS Code webview CSP (nonce-based, inert outside VS Code) blocks the
  // injected bootstrap; access is enforced by the CodeNomad session gate.
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  // CodeNomad / Tokenizin brand palette (see gitgraph/theme.ts). The extension
  // emits several templates (some without a <head>) — inject where one exists.
  const themeStyle = `<style id="codenomad-gitgraph-theme">\n${gitGraphThemeCss()}\n</style>` +
    (theme ? `\n<script>document.documentElement.setAttribute("data-gg-theme", ${JSON.stringify(theme)});</script>` : "")
  if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, themeStyle + "</head>")
  else if (/<body/i.test(html)) html = html.replace(/<body/i, themeStyle + "<body")
  else html = themeStyle + html
  const bootstrap = bootstrapScript().replace(/ROUTER/g, JSON.stringify(urlPrefix))
  // Inject immediately before the initialState script the extension emits.
  html = html.replace(/<script nonce="[^"]*">var initialState/, bootstrap + "<script>var initialState")
  return html
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

let activeBridge: GitGraphBridge | null = null
let bootQueue: Promise<unknown> = Promise.resolve()

export interface BridgeResult {
  bridge: GitGraphBridge
  created: boolean
}

/**
 * Return the live bridge for `repoPath`, creating it if needed. A different
 * path disposes the previous bridge (single-active — see module docs).
 * Serialized via `bootQueue` so concurrent page loads cannot interleave two
 * extension boots (the vscode shim is process-global during boot).
 */
export function acquireBridge(init: BridgeInit): Promise<BridgeResult> {
  const run = async (): Promise<BridgeResult> => {
    if (activeBridge && !activeBridge.isDisposed && activeBridge.repoPath === init.repoPath) {
      const bridge = activeBridge
      // url prefix may differ per workspace alias — keep it fresh for new HTML renders
      bridge.urlPrefix = init.urlPrefix
      bridge.touch()
      return { bridge, created: false }
    }
    if (activeBridge) activeBridge.dispose()
    const bridge = await GitGraphBridge.create(init)
    activeBridge = bridge
    return { bridge, created: true }
  }
  const next = bootQueue.then(run, run)
  bootQueue = next.catch(() => undefined)
  return next
}

export function activeBridgeInfo(): { repoPath: string; clients: number; htmlReady: boolean } | null {
  const b = activeBridge as GitGraphBridge | null
  if (!b || b.isDisposed) return null
  return { repoPath: b.repoPath, clients: b.clientCount, htmlReady: b.htmlReady }
}
