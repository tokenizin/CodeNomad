/** Mirror of StarGuard src/lib/tokidapp/speech-sanitize.ts for server-side voice text. */

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
const ETH_ADDRESS_RE = /\b0x[0-9a-fA-F]{40}\b/g
const LONG_HEX_RE = /\b0x[0-9a-fA-F]{16,}\b/g
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi
const FILE_PATH_RE =
  /(?:^|[\s(])(?:\/?(?:Users|home|var|tmp|src|contracts|CodeNomad)[^\s)\],:;]+|(?:\.\.?\/)+[\w./-]+|[\w.-]+\/(?:[\w.-]+\/)+[\w.-]+)/g

const ENTITY_ALIASES: Record<string, string> = {
  "0xef89dc4e687d5ffa44bf3ed537cb37f1619756c1": "Dynamic Splitter",
  "0xc71829068aaff3c75c1c23a89c741570b51f839c": "Star Bridge",
  "0x87387dd7c75bd129d8898f050924118004dbdcdf": "STARX token",
}

export function sanitizeSpeechText(text: string): string {
  if (!text) return text
  let out = text
  for (const [key, label] of Object.entries(ENTITY_ALIASES)) {
    out = out.replace(new RegExp(key, "gi"), label)
  }
  out = out.replace(URL_RE, "the link")
  out = out.replace(ETH_ADDRESS_RE, "the contract")
  out = out.replace(LONG_HEX_RE, "the identifier")
  out = out.replace(UUID_RE, "the record")
  out = out.replace(FILE_PATH_RE, (m) => {
    const trimmed = m.trim()
    const base = trimmed.split("/").pop() || trimmed
    const name = base.replace(/\.(tsx?|jsx?|sol|md|json)$/i, "").replace(/[-_]/g, " ")
    return ` ${name || "the file"} `
  })
  return out.replace(/\s{2,}/g, " ").trim()
}

export const VOICE_INSTRUCTIONS = [
  "You are TokiDAPP, voice assistant for the StarCARD ecosystem.",
  "Be concise. Use tools for code tasks.",
  "Never read aloud file paths, URLs, wallet addresses, UUIDs, or raw IDs.",
  "Refer to resources by friendly names (e.g. Dynamic Splitter, Star Bridge, StarGuard).",
  "When a multi-step task finishes, briefly offer to continue with the next planned step or give a one-sentence overview.",
].join(" ")
