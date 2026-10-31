/**
 * What to read aloud from an assistant reply: its ```spoken block when it has one, otherwise the prose with code,
 * tables and markdown syntax removed.
 */

const SPOKEN_BLOCK = /```spoken[ \t]*\r?\n([\s\S]*?)\r?\n```/i

/** Longest text read aloud for one reply (the rest stays in the chat). */
export const MAX_SPOKEN_CHARS = 4000

export function speechTextFromReply(markdown: string): string {
  const spoken = markdown.match(SPOKEN_BLOCK)?.[1]?.trim()
  if (spoken) return spoken

  let text = markdown
    .replace(/```[\s\S]*?(```|$)/g, " ") // code blocks
    .replace(/<[^>\n]+>/g, " ") // html tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`([^`]+)`/g, "$1") // inline code
    .split("\n")
    .filter((line) => !/^\s*\|.*\|\s*$/.test(line) && !/^\s*[-:| ]{3,}\s*$/.test(line)) // tables, rules
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "") // headings
        .replace(/^\s*>\s?/, "") // quotes
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "") // list markers
        .replace(/(\*\*|__)(.*?)\1/g, "$2")
        .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, "$2"),
    )
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")

  if (text.length > MAX_SPOKEN_CHARS) {
    const cut = text.lastIndexOf(". ", MAX_SPOKEN_CHARS)
    text = text.slice(0, cut > MAX_SPOKEN_CHARS / 2 ? cut + 1 : MAX_SPOKEN_CHARS)
  }
  return text
}
