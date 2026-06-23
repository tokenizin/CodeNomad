import fs from 'fs/promises'
import path from 'path'
import { createReadStream, type ReadStream } from 'fs'

const BLOB_DIR = process.env.CODENOMAD_BLOB_DIR || path.join(process.cwd(), 'logs', 'blobs')

export function getBlobPath(key: string): string {
  return path.join(BLOB_DIR, key)
}

export async function blobExists(key: string): Promise<boolean> {
  try {
    await fs.access(getBlobPath(key))
    return true
  } catch {
    return false
  }
}

export async function writeBlob(key: string, data: Buffer | string): Promise<string> {
  const filePath = getBlobPath(key)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, data)
  return filePath
}

export async function readBlob(key: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(getBlobPath(key))
  } catch {
    return null
  }
}

export async function deleteBlob(key: string): Promise<boolean> {
  try {
    await fs.unlink(getBlobPath(key))
    return true
  } catch {
    return false
  }
}

export function streamBlob(key: string): ReadStream {
  return createReadStream(getBlobPath(key))
}

export async function listBlobs(prefix: string): Promise<string[]> {
  const dir = path.dirname(getBlobPath(prefix))
  try {
    const entries = await fs.readdir(dir)
    return entries
      .filter(e => e.startsWith(path.basename(prefix)))
      .map(e => `${prefix}${e}`)
  } catch {
    return []
  }
}

export async function deleteBlobsByPrefix(prefix: string): Promise<number> {
  const blobs = await listBlobs(prefix)
  let deleted = 0
  for (const key of blobs) {
    if (await deleteBlob(key)) deleted++
  }
  return deleted
}
