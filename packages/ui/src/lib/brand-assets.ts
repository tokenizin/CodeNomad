/**
 * Tokenizin palace mark from the 3D logo system.
 * Served from renderer `public/` so Vite/Solid does not treat the SVG as a component.
 * `import.meta.env.BASE_URL` is `/codenomad/` for embed and `/` for the tunnel build.
 */
export const TOKENIZIN_LOGO_URL = `${import.meta.env.BASE_URL}Tokenizin-Logo.svg`

/** Raster twin for contexts that prefer PNG. */
export const TOKENIZIN_LOGO_PNG_URL = `${import.meta.env.BASE_URL}Tokenizin-Logo.png`

/** Prestix.vip mark fallback when WebGL is unavailable. */
export const PRESTIX_LOGO_URL = `${import.meta.env.BASE_URL}prestix-icon.svg`
