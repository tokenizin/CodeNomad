/**
 * CodeNomad product silo for landing chrome (logo + card copy).
 * Prestix tunnel injects window.__CODENOMAD_AUTH_PROVIDER__ = "cloudflare-access".
 */

export type CodeNomadSilo = "tokenizin" | "prestix"

export function isPrestixSilo(hostname?: string | null, authProvider?: string | null): boolean {
  const provider = (
    authProvider ??
    (typeof window !== "undefined" ? window.__CODENOMAD_AUTH_PROVIDER__ : undefined)
  )
    ?.trim()
    .toLowerCase()
  if (provider === "cloudflare-access") return true

  const host = (
    hostname ??
    (typeof window !== "undefined" ? window.location.hostname : "")
  )
    .trim()
    .toLowerCase()
  return host === "prestix.vip" || host.endsWith(".prestix.vip")
}

export function resolveCodeNomadSilo(): CodeNomadSilo {
  return isPrestixSilo() ? "prestix" : "tokenizin"
}

export const PRESTIX_LANDING_COPY = {
  logoAlt: "Prestix 3D logo",
  brandTitle: "Prestix",
  tagline:
    "Venue booking, memberships, and operator tools — open a Prestix workspace. This silo is not StarWorld or Solidity.",
  loadingSubtitle: "Preparing your Prestix VIP workspace.",
  emptyTagline: "Prestix VIP — booking, POS, and venue ops. Select a workspace in this directory.",
  emptyDescription: "Prompt NomadWorks agents for Prestix.vip in this workspace — or open the Command Palette:",
  welcomeTitle: "Launching Prestix workspace",
  welcomeDescription: "Starting the Prestix VIP agent stack for this project…",
} as const
