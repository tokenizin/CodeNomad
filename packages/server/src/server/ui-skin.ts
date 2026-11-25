/**
 * Per-instance UI skin. A per-user instance (scripts/multi-user) can be given its own look with CODENOMAD_UI_SKIN in
 * its LaunchDaemon environment, e.g. CODENOMAD_UI_SKIN=matriza for stas. The server passes it to the UI through the
 * runtime-config script (injectUiRuntimeConfig), which sets <html data-skin="..."> before the app renders, so there is
 * no flash of the default theme. Unknown values are ignored: the value ends up in an inline script, so only names on
 * this list are ever written there.
 */

/** Skins the UI ships styles for (packages/ui/src/styles/skins/<name>.css). */
export const UI_SKINS = ["matriza"] as const

export type UiSkin = (typeof UI_SKINS)[number]

/** Skins that are dark-only designs: the UI locks dark mode while one is active. */
const DARK_ONLY_SKINS: ReadonlySet<UiSkin> = new Set<UiSkin>(["matriza"])

let warnedFor: string | null = null

export function resolveUiSkin(env: NodeJS.ProcessEnv = process.env): UiSkin | null {
  const raw = env.CODENOMAD_UI_SKIN?.trim().toLowerCase()
  if (!raw) return null
  if ((UI_SKINS as readonly string[]).includes(raw)) return raw as UiSkin
  if (warnedFor !== raw) {
    warnedFor = raw
    console.warn(`[ui-skin] Ignoring unknown CODENOMAD_UI_SKIN="${raw}" (known: ${UI_SKINS.join(", ")})`)
  }
  return null
}

export function isDarkOnlySkin(skin: UiSkin | null): boolean {
  return skin !== null && DARK_ONLY_SKINS.has(skin)
}

/**
 * The part of the runtime-config script for the skin: exposes it as window.__CODENOMAD_UI_SKIN__ and marks <html>
 * before first paint. Empty when no skin is set, so instances without one serve exactly the same HTML as before.
 */
export function uiSkinScript(skin: UiSkin | null): string {
  if (!skin) return ""
  const darkOnly = isDarkOnlySkin(skin)
  return `window.__CODENOMAD_UI_SKIN__=${JSON.stringify(skin)};document.documentElement.dataset.skin=${JSON.stringify(skin)};${darkOnly ? 'document.documentElement.setAttribute("data-theme","dark");' : ""}`
}
