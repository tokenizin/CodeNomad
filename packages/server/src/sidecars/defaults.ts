/**
 * Default sidecar configuration.
 * These sidecars are automatically registered when CodeNomad starts,
 * if not already present in the configuration.
 */

import type { SideCar } from "../api-types"

// BEGIN GENERATED — sidecar-registry (scripts/sync-sidecars.ts)
export const DEFAULT_SIDECARS: Array<Omit<SideCar, "status">> = [
// BEGIN GENERATED — sidecar-registry (scripts/sync-sidecars.ts)
  {
    id: "venue-staff-sidecar",
    kind: "port",
    name: "Venue Staff (Door + Bar)",
    port: 9941,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "entry-sidecar",
    kind: "port",
    name: "Venue Entry (Customer Verify + Drink)",
    port: 9922,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "admin-sidecar",
    kind: "port",
    name: "Admin Console",
    port: 9970,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "upload-widget",
    kind: "port",
    name: "Upload Widget",
    port: 9966,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "powerx-sidecar",
    kind: "port",
    name: "PowerX Model Agency",
    port: 9975,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "openwa-sidecar",
    kind: "port",
    name: "OpenWA (WhatsApp Service)",
    port: 9963,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "ollama",
    kind: "port",
    name: "Ollama",
    port: 11434,
    insecure: true,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "deepseek",
    kind: "port",
    name: "DeepSeek V4 Flash (MLX)",
    port: 8082,
    insecure: true,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "payment-sidecar",
    kind: "port",
    name: "Payment (STARXP WhatsApp QR)",
    port: 9965,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "pay-sidecar",
    kind: "port",
    name: "Pay (QRIS Invoice)",
    port: 9980,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "starpages-tv-sidecar",
    kind: "port",
    name: "StarPAGES TV (Catalog Kiosk)",
    port: 9950,
    insecure: false,
    prefixMode: "strip",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
// END GENERATED — sidecar-registry
]
// END GENERATED — sidecar-registry

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
