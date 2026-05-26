import { createCodeNomadUiConfig } from "./vite.shared"

/** StarGuard static embed at /codenomad — no service worker / workbox (same-origin shell). */
export default createCodeNomadUiConfig(false)
