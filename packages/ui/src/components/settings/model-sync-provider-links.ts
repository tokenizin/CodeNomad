/**
 * External links used by the Model Status row actions ("Top up credits",
 * "Official details"). Keyed by model-sync provider id (see PROVIDER_CONFIGS in
 * packages/server/src/model-sync/service.ts).
 *
 * These are the providers' public billing / model documentation pages. They are
 * best-known URLs, not fetched from the providers — edit here if one moves.
 * Local providers (ollama, mlx, …) have no top-up page.
 */
interface ProviderLinks {
  /** Billing / credits page. */
  topUp?: string
  /** Model documentation. `{model}` is replaced with the URL-encoded model id path. */
  details?: string
}

const PROVIDER_LINKS: Record<string, ProviderLinks> = {
  openrouter: { topUp: "https://openrouter.ai/settings/credits", details: "https://openrouter.ai/{model}" },
  "openrouter-fallback": { topUp: "https://openrouter.ai/settings/credits", details: "https://openrouter.ai/{model}" },
  anthropic: { topUp: "https://console.anthropic.com/settings/billing", details: "https://docs.anthropic.com/en/docs/about-claude/models" },
  openai: { topUp: "https://platform.openai.com/settings/organization/billing", details: "https://platform.openai.com/docs/models/{model}" },
  google: { topUp: "https://console.cloud.google.com/billing", details: "https://ai.google.dev/gemini-api/docs/models" },
  nvidia: { topUp: "https://build.nvidia.com/", details: "https://build.nvidia.com/{model}" },
  groq: { topUp: "https://console.groq.com/settings/billing", details: "https://console.groq.com/docs/models" },
  deepinfra: { topUp: "https://deepinfra.com/dash/billing", details: "https://deepinfra.com/{model}" },
  vercel: { topUp: "https://vercel.com/dashboard", details: "https://vercel.com/ai-gateway/models" },
  xai: { topUp: "https://console.x.ai/", details: "https://docs.x.ai/docs/models" },
  "cloudflare-ai-gateway": { topUp: "https://dash.cloudflare.com/", details: "https://developers.cloudflare.com/ai-gateway/" },
  "cloudflare-workers-ai": { topUp: "https://dash.cloudflare.com/", details: "https://developers.cloudflare.com/workers-ai/models/" },
  ollama: { details: "https://ollama.com/library/{model}" },
}

function fill(template: string, modelId: string): string {
  // Keep "/" in ids like "anthropic/claude-x" (OpenRouter paths); encode each segment.
  const path = modelId.split("/").map(encodeURIComponent).join("/")
  return template.replace("{model}", path)
}

export function topUpUrl(providerId: string): string | undefined {
  return PROVIDER_LINKS[providerId]?.topUp
}

export function officialDetailsUrl(providerId: string, modelId: string): string | undefined {
  const template = PROVIDER_LINKS[providerId]?.details
  if (!template) return undefined
  // Ollama tags ("llama3.2:latest") → library page for the base name.
  const id = providerId === "ollama" ? modelId.split(":")[0] : modelId
  return fill(template, id)
}
