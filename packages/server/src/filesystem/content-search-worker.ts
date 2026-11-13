/**
 * Runs one ranked text search and prints the result as JSON.
 *
 * `searchText` is synchronous (it shells out to ripgrep, or walks the tree itself) and can take seconds on a large
 * workspace. Run inside the server it would stall every session's stream for that long, so `discovery.ts` starts
 * this file as a separate process, and can kill it when the person types something else.
 *
 * Input: one JSON object on stdin, `{ query, root, maxFiles, snippetsPerFile }`. Output: a `SearchResult` on stdout.
 */
import { searchText } from "../plugins/tokidapp/concierge/text-search"

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      data += chunk
    })
    process.stdin.on("end", () => resolve(data))
    process.stdin.on("error", reject)
  })
}

async function main() {
  const input = JSON.parse(await readStdin()) as { query: string; root: string; maxFiles: number; snippetsPerFile: number }
  const result = searchText(input.query, {
    roots: [input.root],
    maxFiles: input.maxFiles,
    snippetsPerFile: input.snippetsPerFile,
  })
  process.stdout.write(JSON.stringify(result))
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
