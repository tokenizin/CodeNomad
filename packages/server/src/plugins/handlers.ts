import type { EventBus } from "../events/bus"
import type { WorkspaceManager } from "../workspaces/manager"
import type { Logger } from "../logger"
import type { PluginOutboundEvent } from "./channel"

export interface PluginInboundEvent {
  type: string
  properties?: Record<string, unknown>
}

interface HandlerDeps {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
}

export function handlePluginEvent(workspaceId: string, event: PluginInboundEvent, deps: HandlerDeps) {
  switch (event.type) {
    case "codenomad.pong":
      deps.logger.debug({ workspaceId, properties: event.properties }, "Plugin pong received")
      return

    case "codenomad.jevGate": {
      // Shadow-mode verdicts and real escalations. Anything other than `allow` on a
      // healthy feed is surfaced at warn so it is visible without a debug log level.
      const properties = event.properties ?? {}
      const status = typeof properties.status === "string" ? properties.status : "unknown"
      const action = typeof properties.action === "string" ? properties.action : "unknown"
      const payload = { workspaceId, ...properties }
      if (status === "degraded") {
        deps.logger.warn(payload, "Jev tool gate degraded")
      } else if (action !== "allow") {
        deps.logger.warn(payload, "Jev tool gate would restrict a tool action")
      } else {
        deps.logger.debug(payload, "Jev tool gate cleared a tool action")
      }
      return
    }

    default:
      deps.logger.debug({ workspaceId, eventType: event.type }, "Unhandled plugin event")
  }
}

export function buildPingEvent(): PluginOutboundEvent {

  return {
    type: "codenomad.ping",
    properties: {
      ts: Date.now(),
    },
  }
}
