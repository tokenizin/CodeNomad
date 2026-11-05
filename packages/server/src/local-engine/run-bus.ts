/**
 * Lets a page watch a run it did not start.
 *
 * A person's message streams to the tab that sent it. A run the server starts itself — a workflow's
 * notification turn on the Product Manager, or a Workflow Runner's whole run — has nobody on the line,
 * and a page that reloads in the middle of any run has lost its stream. Every run publishes its events
 * here as well; `GET /api/local-engine/attach` replays what it has said so far and then follows it live,
 * so the page shows the turn as it happens instead of finding it saved a few seconds later.
 *
 * A run is kept only while it is going (its events are in the saved history once it ends).
 */

/** What an attaching page needs to draw the run before its first event: the message that started it, and the ids the saved history will use. */
export type RunHeader = {
  type: "attach"
  sessionKey: string
  startedAt: number
  user: { id: string; text: string; createdAt: number }
  assistantId: string
  agent?: string
  model?: string
}

type Listener = (event: object | null) => void

type LiveRun = {
  header: RunHeader
  events: object[]
  listeners: Set<Listener>
}

export class RunBus {
  private readonly runs = new Map<string, LiveRun>()

  /** The run going for the session, if any. */
  current(sessionKey: string): RunHeader | undefined {
    return this.runs.get(sessionKey)?.header
  }

  start(header: RunHeader): void {
    this.runs.set(header.sessionKey, { header, events: [], listeners: new Set() })
  }

  /** Adds an event to the run; consecutive text deltas are joined so a late page replays a short list. */
  publish(sessionKey: string, event: object): void {
    const run = this.runs.get(sessionKey)
    if (!run) return
    const last = run.events[run.events.length - 1] as { type?: string; text?: string } | undefined
    const next = event as { type?: string; text?: string }
    if (last?.type === "delta" && next.type === "delta" && typeof last.text === "string" && typeof next.text === "string") {
      last.text += next.text
    } else {
      run.events.push({ ...event })
    }
    for (const listener of run.listeners) listener(event)
  }

  /** The run is over: its listeners are told and it is forgotten. */
  end(sessionKey: string): void {
    const run = this.runs.get(sessionKey)
    if (!run) return
    this.runs.delete(sessionKey)
    for (const listener of run.listeners) listener(null)
    run.listeners.clear()
  }

  /**
   * Follows the session's current run: the events so far first, then each new one; `null` when it ends.
   * Returns a function that stops listening, or undefined when no run is going.
   */
  follow(sessionKey: string, listener: Listener): (() => void) | undefined {
    const run = this.runs.get(sessionKey)
    if (!run) return undefined
    // Replay a copy: a listener may take its time while the run goes on.
    for (const event of [...run.events]) listener(event)
    run.listeners.add(listener)
    return () => {
      run.listeners.delete(listener)
    }
  }
}
