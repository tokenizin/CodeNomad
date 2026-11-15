/**
 * Git Graph webview theming — maps the CodeNomad / Tokenizin brand tokens onto
 * the VS Code CSS custom properties the vendored Git Graph webview consumes
 * (media/out.min.css reads only `--vscode-*` vars with neutral fallbacks).
 *
 * The full style block is injected into every served page. It defines both
 * palettes under `html[data-gg-theme="light"|"dark"]`; the UI tab (GitGraphTab)
 * mirrors the app's resolved theme onto the iframe document whenever it
 * changes. Dark is the default so the first paint matches the Tokenizin
 * × StarWorld brand surface (`--sw-*` in tokens-starworld.css).
 */

const SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

/** Tokenizin × StarWorld dark — tokens from styles/tokens-starworld.css. */
const DARK: Record<string, string> = {
  "--vscode-font-family": SANS,
  "--vscode-editor-font-family": MONO,
  "--vscode-editor-background": "#090a11", // --sw-bg
  "--vscode-editor-foreground": "#f3f4f6", // --sw-text
  "--vscode-focusBorder": "#d4af37", // --sw-brand
  "--vscode-selection-background": "rgba(212, 175, 55, 0.28)",
  "--vscode-textLink-foreground": "#ffc713", // --sw-brand-bright
  "--vscode-textLink-activeForeground": "#d4af37",
  "--vscode-editorWidget-background": "#212936", // --sw-card
  "--vscode-editorSuggestWidget-foreground": "#f3f4f6",
  "--vscode-input-background": "#161b22", // --sw-surface
  "--vscode-input-foreground": "#f3f4f6",
  "--vscode-input-placeholderForeground": "#9ca3af", // --sw-text-muted
  "--vscode-inputOption-activeBackground": "rgba(212, 175, 55, 0.25)",
  "--vscode-inputOption-activeBorder": "#d4af37",
  "--vscode-inputValidation-errorBackground": "rgba(244, 67, 54, 0.12)",
  "--vscode-inputValidation-errorBorder": "#f44336", // --status-error
  "--vscode-menu-background": "#212936",
  "--vscode-menu-foreground": "#f3f4f6",
  "--vscode-menu-border": "rgba(212, 175, 55, 0.28)", // --sw-pill-border color
  "--vscode-menu-separatorBackground": "rgba(255, 255, 255, 0.08)",
  "--vscode-menu-selectionBackground": "#d4af37",
  "--vscode-menu-selectionForeground": "#090a11",
  "--vscode-menu-selectionBorder": "#b8962e",
  "--vscode-widget-shadow": "rgba(0, 0, 0, 0.6)",
  "--vscode-scrollbar-shadow": "rgba(0, 0, 0, 0.6)",
  "--vscode-editor-findMatchHighlightBackground": "rgba(255, 199, 19, 0.35)",
  "--vscode-editor-findMatchHighlightBorder": "#d4af37",
  "--vscode-gitDecoration-addedResourceForeground": "#4caf50", // --status-success
  "--vscode-gitDecoration-modifiedResourceForeground": "#ff9800", // --status-warning
  "--vscode-gitDecoration-deletedResourceForeground": "#f44336", // --status-error
  // Extra widget surfaces the webview picks up via fallbacks — keep on brand.
  "--vscode-button-background": "#d4af37",
  "--vscode-button-foreground": "#090a11",
  "--vscode-button-hoverBackground": "#ffc713",
  "--vscode-button-secondaryBackground": "#161b22",
  "--vscode-button-secondaryForeground": "#f3f4f6",
  "--vscode-button-secondaryHoverBackground": "#212936",
  "--vscode-dropdown-background": "#161b22",
  "--vscode-dropdown-foreground": "#f3f4f6",
  "--vscode-dropdown-border": "rgba(212, 175, 55, 0.28)",
  "--vscode-checkbox-background": "#161b22",
  "--vscode-checkbox-foreground": "#f3f4f6",
  "--vscode-checkbox-border": "rgba(212, 175, 55, 0.28)",
  "--vscode-list-hoverBackground": "rgba(212, 175, 55, 0.1)",
  "--vscode-list-activeSelectionBackground": "rgba(212, 175, 55, 0.22)",
  "--vscode-list-activeSelectionForeground": "#f3f4f6",
  "--vscode-panel-border": "rgba(255, 255, 255, 0.08)",
  "--vscode-panel-background": "#090a11",
  "--vscode-sideBar-background": "#090a11",
  "--vscode-badge-background": "#d4af37",
  "--vscode-badge-foreground": "#090a11",
  "--vscode-descriptionForeground": "#9ca3af",
  "--vscode-errorForeground": "#f44336",
  "--vscode-icon-foreground": "#9ca3af",
}

/** CodeNomad light — tokens from styles/tokens.css (+ brand-dim gold accents). */
const LIGHT: Record<string, string> = {
  "--vscode-font-family": SANS,
  "--vscode-editor-font-family": MONO,
  "--vscode-editor-background": "#ffffff", // --surface-base
  "--vscode-editor-foreground": "#111827", // --text-primary
  "--vscode-focusBorder": "#b8962e", // --sw-brand-dim
  "--vscode-selection-background": "rgba(212, 175, 55, 0.35)",
  "--vscode-textLink-foreground": "#b8962e",
  "--vscode-textLink-activeForeground": "#0066ff", // --accent-primary (hover)
  "--vscode-editorWidget-background": "#ffffff",
  "--vscode-editorSuggestWidget-foreground": "#111827",
  "--vscode-input-background": "#f8fafc", // --surface-muted
  "--vscode-input-foreground": "#111827",
  "--vscode-input-placeholderForeground": "#475569", // --text-muted
  "--vscode-inputOption-activeBackground": "rgba(184, 150, 46, 0.2)",
  "--vscode-inputOption-activeBorder": "#b8962e",
  "--vscode-inputValidation-errorBackground": "rgba(244, 67, 54, 0.08)",
  "--vscode-inputValidation-errorBorder": "#f44336",
  "--vscode-menu-background": "#ffffff",
  "--vscode-menu-foreground": "#111827",
  "--vscode-menu-border": "#e0e0e0", // --border-base
  "--vscode-menu-separatorBackground": "#e0e0e0",
  "--vscode-menu-selectionBackground": "#b8962e",
  "--vscode-menu-selectionForeground": "#ffffff",
  "--vscode-menu-selectionBorder": "#b8962e",
  "--vscode-widget-shadow": "rgba(0, 0, 0, 0.2)",
  "--vscode-scrollbar-shadow": "rgba(0, 0, 0, 0.15)",
  "--vscode-editor-findMatchHighlightBackground": "rgba(255, 199, 19, 0.45)",
  "--vscode-editor-findMatchHighlightBorder": "#b8962e",
  "--vscode-gitDecoration-addedResourceForeground": "#16a34a",
  "--vscode-gitDecoration-modifiedResourceForeground": "#ca8a04",
  "--vscode-gitDecoration-deletedResourceForeground": "#dc2626",
  "--vscode-button-background": "#b8962e",
  "--vscode-button-foreground": "#ffffff",
  "--vscode-button-hoverBackground": "#c49a2f", // --sw-brand-hover
  "--vscode-button-secondaryBackground": "#f5f5f5", // --surface-secondary
  "--vscode-button-secondaryForeground": "#111827",
  "--vscode-button-secondaryHoverBackground": "#e0e0e0",
  "--vscode-dropdown-background": "#f8fafc",
  "--vscode-dropdown-foreground": "#111827",
  "--vscode-dropdown-border": "#e0e0e0",
  "--vscode-checkbox-background": "#f8fafc",
  "--vscode-checkbox-foreground": "#111827",
  "--vscode-checkbox-border": "#e0e0e0",
  "--vscode-list-hoverBackground": "rgba(184, 150, 46, 0.1)",
  "--vscode-list-activeSelectionBackground": "rgba(184, 150, 46, 0.2)",
  "--vscode-list-activeSelectionForeground": "#111827",
  "--vscode-panel-border": "#e0e0e0",
  "--vscode-panel-background": "#ffffff",
  "--vscode-sideBar-background": "#f5f5f5",
  "--vscode-badge-background": "#b8962e",
  "--vscode-badge-foreground": "#ffffff",
  "--vscode-descriptionForeground": "#475569",
  "--vscode-errorForeground": "#f44336",
  "--vscode-icon-foreground": "#475569",
}

function paletteBlock(palette: Record<string, string>): string {
  return Object.entries(palette)
    .map(([k, v]) => `${k}:${v}`)
    .join(";")
}

/**
 * `<style>` body: default (no attribute) resolves dark; explicit light/dark
 * blocks are switched by GitGraphTab mirroring the app theme. The trailing
 * rules retint the JS-painted uncommitted row so it sits inside the brand
 * palette instead of the webview's stock pink.
 */
export function gitGraphThemeCss(): string {
  return [
    `:root{${paletteBlock(DARK)}}`,
    `html[data-gg-theme="dark"]{${paletteBlock(DARK)}}`,
    `html[data-gg-theme="light"]{${paletteBlock(LIGHT)}}`,
    // Brand retint of the webview's stock colors (beats inline JS styles).
    ".commit.uncommittedChanges{padding-left:inherit;padding-right:inherit}",
    "html[data-gg-theme=\"dark\"] .commit.uncommittedChanges{background-color:rgba(212,175,55,.07)!important}",
    "html[data-gg-theme=\"light\"] .commit.uncommittedChanges{background-color:rgba(184,150,46,.08)!important}",
    "html[data-gg-theme=\"dark\"] .commit.uncommittedChanges:hover{background-color:rgba(212,175,55,.12)!important}",
    "html[data-gg-theme=\"light\"] .commit.uncommittedChanges:hover{background-color:rgba(184,150,46,.14)!important}",
    // The webview paints its own <body>; make sure it inherits the palette bg.
    "html,body{background-color:var(--vscode-editor-background);color:var(--vscode-editor-foreground)}",
  ].join("\n")
}
