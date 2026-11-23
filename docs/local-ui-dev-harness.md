# Local UI dev harness (Vite + CodeNomad server)

Use this when you need to exercise the SolidJS UI against a **local Vite source server** rather
than the built bundle. The server proxies UI HTML to Vite; the proxy injects the runtime config
globals before the page renders, so auth/silo-aware chrome behaves the same as in production.

> Do **not** use this harness against the live tunnel. The live server owns port `9940` and is
> restarted only through its supervisor. Pick a different local port (e.g. `9946`).

## 1. Start Vite (terminal 1)

From the `CodeNomad/` root:

```sh
npm run dev --workspace @codenomad/ui -- --port 3000
```

Vite now serves the UI source at `http://localhost:3000`.

## 2. Start the CodeNomad server in dev-proxy mode (terminal 2)

The flag is **`--ui-dev-server <url>`** (single option carrying the URL; env equivalent
`CLI_UI_DEV_SERVER`). There is no `--ui-dev-server-url` flag.

From the `CodeNomad/` root:

```sh
CLI_UI_DEV_SERVER=http://localhost:3000 \
  npm run dev --workspace @neuralnomads/codenomad -- --http-port 9946
```

The workspace `dev` script already sets `CODENOMAD_DEV=1`,
`CODENOMAD_SERVER_PASSWORD=codenomad-dev`, `CLI_HTTPS=false` and `CLI_HTTP=true`. Override the
Vite URL with `--ui-dev-server http://localhost:<port>` or the `CLI_UI_DEV_SERVER` env var.

Open `http://localhost:9946/` and log in with the dev password when prompted. `GET /` redirects to
`/login` until a session exists; both routes go through the same dev proxy.

## 3. Verify the injected globals and `data-silo`

Open DevTools on the proxied page:

```js
window.__CODENOMAD_AUTH_PROVIDER__   // string, e.g. "local" / "cloudflare-access" — never undefined
window.__STARGUARD_PUBLIC_URL__      // string (may be "") — never undefined
document.documentElement.dataset.silo // "tokenizin" or "prestix"
```

On the **Network** tab, select the document request for `/` (or `/login`):

- Response HTML contains `<script>window.__CODENOMAD_AUTH_PROVIDER__=…` **before** `</head>`.
- The script appears exactly once (no double injection).
- `content-length` matches the response body byte length; there is no stale `content-encoding`
  header on the already-decoded HTML.

Because the config script is inline and synchronous in `<head>`, the globals and `data-silo` are
set before any deferred/module app script runs — no component should observe them as `undefined`.

Non-dev paths (built `index.html` served from the static UI dir and the SPA fallback) keep their
existing injection behavior and are unchanged by the dev-proxy fix.

## 4. Visual-test criteria

Exercise these four criteria from `TASK-2026-11-23-003` while the harness is running:

1. `data-silo` is reflected in the DOM and UI chrome adapts to the injected
   `window.__CODENOMAD_AUTH_PROVIDER__`; StarWorld vs Prestix render distinct expected chrome.
2. Dev-proxy source state surfaces without breaking component access to the required auth/silo
   globals (the injection-gap regression).
3. The "Testing" state (`animate-pulse`) is perceptible; success/error alerts are positioned
   without major layout shift (CLS).
4. Filter/search updates the table instantly without a full reload.

Capture screenshots only from an actual harness session. Do not synthesize or fabricate images.
If no visual session was performed, record that explicitly in the evidence packet instead.
