/**
 * Per-instance UI skin, set by the server from CODENOMAD_UI_SKIN (packages/server/src/server/ui-skin.ts) and exposed as
 * window.__CODENOMAD_UI_SKIN__. The server's runtime-config script already marks <html data-skin="..."> before the app
 * renders; the styles live in src/styles/skins/<name>.css. Only known skins are honoured.
 */

export const UI_SKINS = ["matriza"] as const

export type UiSkin = (typeof UI_SKINS)[number]

/** Skins that are dark-only designs: the theme provider keeps dark mode on while one is active. */
const DARK_ONLY_SKINS: ReadonlySet<UiSkin> = new Set<UiSkin>(["matriza"])

export function activeUiSkin(value: unknown = typeof window !== "undefined" ? window.__CODENOMAD_UI_SKIN__ : undefined): UiSkin | null {
  if (typeof value !== "string") return null
  const skin = value.trim().toLowerCase()
  return (UI_SKINS as readonly string[]).includes(skin) ? (skin as UiSkin) : null
}

export function skinLocksDarkMode(skin: UiSkin | null = activeUiSkin()): boolean {
  return skin !== null && DARK_ONLY_SKINS.has(skin)
}
