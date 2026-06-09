import { createCodeNomadUiConfig } from "./vite.shared"

/** Tunnel/server UI — no service worker (PWA only for Electron via build:pwa). */
export default createCodeNomadUiConfig(false)
