import fs from "fs"
import path from "path"
import os from "os"

export interface LocalRecording {
  id: string
  sessionId: string
  blobUrl: string
  duration: number
  createdAt: string
}

const RECORDINGS_DIR = path.join(os.homedir(), ".config", "codenomad", "recordings")
const META_FILE = path.join(RECORDINGS_DIR, "recordings-meta.json")

function loadAll(): LocalRecording[] {
  try {
    if (!fs.existsSync(META_FILE)) return []
    const data = fs.readFileSync(META_FILE, "utf-8")
    return JSON.parse(data) as LocalRecording[]
  } catch {
    return []
  }
}

function saveAll(recordings: LocalRecording[]): void {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true })
  fs.writeFileSync(META_FILE, JSON.stringify(recordings, null, 2))
}

/**
 * Retrieve all locally-stored recordings for a given session,
 * ordered by createdAt descending (most recent first).
 */
export function getLocalRecordings(sessionId: string): LocalRecording[] {
  return loadAll()
    .filter((r) => r.sessionId === sessionId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/**
 * Persist a recording metadata entry to the local JSON store.
 */
export function addLocalRecording(recording: LocalRecording): void {
  const recordings = loadAll()
  recordings.push(recording)
  saveAll(recordings)
}
