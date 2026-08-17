/**
 * Default sidecar configuration.
 * These sidecars are automatically registered when CodeNomad starts,
 * if not already present in the configuration.
 */

import type { SideCar } from "../api-types"

export const DEFAULT_SIDECARS: Array<Omit<SideCar, "status">> = [
  {
    id: "openwa-sidecar",
    kind: "port",
    name: "OpenWA Sidecar",
    port: 9963,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "venue-staff-sidecar",
    kind: "port",
    name: "Venue Staff Sidecar",
    port: 9941,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "entry-sidecar",
    kind: "port",
    name: "Entry Sidecar",
    port: 9922,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "admin-sidecar",
    kind: "port",
    name: "Admin Sidecar",
    port: 9970,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "starpages-tv-sidecar",
    kind: "port",
    name: "StarPAGES TV Sidecar",
    port: 9950,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

/**
 * Ensure default sidecars are registered.
 * Checks each default sidecar and creates it if not already present.
 */
export async function ensureDefaultSidecars(
  manager: {
    get(id: string): Promise<unknown>
    create(input: any): Promise<unknown>
  },
  logger?: { info(msg: string): void; warn(msg: string): void },
): Promise<void> {
  for (const defaultSidecar of DEFAULT_SIDECARS) {
    const existing = await manager.get(defaultSidecar.id)
    if (!existing) {
      logger?.info(`Registering default sidecar: ${defaultSidecar.name} (${defaultSidecar.id})`)
      try {
        await manager.create({
          kind: defaultSidecar.kind,
          name: defaultSidecar.name,
          port: defaultSidecar.port,
          insecure: defaultSidecar.insecure,
          prefixMode: defaultSidecar.prefixMode,
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        logger?.warn(`Failed to register sidecar ${defaultSidecar.id}: ${message}`)
      }
    }
  }
}
