/**
 * Where local-run-attach.ts says how a run this tab did not start is followed live. A module of its own,
 * with no imports, so both session-api.ts (which asks for a run to be followed) and local-run-attach.ts
 * (which does it, and imports session-api.ts) can use it however the import cycle happens to be entered.
 */
export type LocalRunAttacher = (instanceId: string, sessionId: string) => void

const holder: { attacher?: LocalRunAttacher } = {}

export function setLocalRunAttacher(attacher: LocalRunAttacher): void {
  holder.attacher = attacher
}

export function getLocalRunAttacher(): LocalRunAttacher | undefined {
  return holder.attacher
}

/** Sessions whose run is being fed live by an attach in this tab (loadMessages must not reset their status). */
export const attachedLocalSessions = new Set<string>()
