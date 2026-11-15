# Vendored: Git Graph (VS Code extension)

- Upstream: https://github.com/mhutchie/vscode-git-graph
- Version: 1.30.0 (MIT, © Marcus Hutchie)
- Provenance: copied from a marketplace-installed extension and verified to match
  upstream GitHub `mhutchie/vscode-git-graph` HEAD `d7f43f4` (2021-09-19,
  CHANGELOG 1.30.0 — 2021-04-05). Only network endpoints in `out/` are the
  maintainer's install-telemetry API (`api.mhutchie.com`, code removed below)
  and Gravatar avatars (disabled by config default). No obfuscation present.

## Modifications

- `out/life-cycle/` **removed** — install/update telemetry; the CodeNomad bridge
  never loads `extension.js`/`startup.js`, the directory is deleted so it can
  never be reached.
- `node_modules/vscode/` **added** — a resolution hook package that proxies
  `require("vscode")` to the CodeNomad bridge's vscode API shim
  (`globalThis.__gitGraphVscodeShim`).
- `node_modules/iconv-lite` (+ transitive dep) copied from the extension's own
  `node_modules` (the only non-builtin require in `out/`).
- Everything else byte-identical to the published extension (`out/`, `media/`).

## How it is used

`packages/server/src/gitgraph/bridge.ts` loads `out/*.js` unmodified on the
server with the vscode shim, instantiates the real `GitGraphView`, and bridges
its webview message protocol to the browser via the routes in
`packages/server/src/server/routes/git-graph.ts`.
