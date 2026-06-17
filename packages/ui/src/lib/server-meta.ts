import type { ServerMeta } from "../../../server/src/api-types"
import { serverApi } from "./api-client"

let cachedMeta: ServerMeta | null = null
let pendingMeta: Promise<ServerMeta> | null = null

export async function getServerMeta(forceRefresh = false): Promise<ServerMeta> {
  if (!forceRefresh && cachedMeta) {
    return cachedMeta
  }
  if (!forceRefresh && pendingMeta) {
    return pendingMeta
  }
  pendingMeta = serverApi
    .fetchServerMeta()
    .then((meta) => {
      cachedMeta = meta
      return meta
    })
    .catch((err) => {
      pendingMeta = null
      throw err
    })
    .finally(() => {
      pendingMeta = null
    })
  return pendingMeta
}
