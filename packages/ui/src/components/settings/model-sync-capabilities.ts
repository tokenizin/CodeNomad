import { Brain, Cloud, Cpu, Image, Music, Video } from "lucide-solid"

import type { CapabilityKey } from "../../lib/model-sync/filter-models"

/**
 * Icon + colour for each model capability, shared by the Model Sync filter
 * toggles and the table's Capabilities column. Colours match the model
 * picker's capability filter bar (model-selector.tsx).
 */
export const CAPABILITY_META: ReadonlyArray<{
  key: CapabilityKey
  icon: typeof Cpu
  labelKey: string
  color: string
}> = [
  { key: "tools", icon: Cpu, labelKey: "settings.section.modelSync.capability.tools", color: "var(--status-info, #3b82f6)" },
  { key: "image", icon: Image, labelKey: "settings.section.modelSync.capability.image", color: "var(--status-success, #22c55e)" },
  { key: "video", icon: Video, labelKey: "settings.section.modelSync.capability.video", color: "#a855f7" },
  { key: "reasoning", icon: Brain, labelKey: "settings.section.modelSync.capability.reasoning", color: "#f97316" },
  { key: "audio", icon: Music, labelKey: "settings.section.modelSync.capability.audio", color: "#ec4899" },
  { key: "cloud", icon: Cloud, labelKey: "settings.section.modelSync.capability.cloud", color: "#06b6d4" },
]
