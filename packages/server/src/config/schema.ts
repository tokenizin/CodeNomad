import { z } from "zod"

const ModelPreferenceSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
})

const AgentModelSelectionSchema = z.record(z.string(), ModelPreferenceSchema)
const AgentModelSelectionsSchema = z.record(z.string(), AgentModelSelectionSchema)

const PreferencesSchema = z
  .object({
  showThinkingBlocks: z.boolean().optional().default(false),
  thinkingBlocksExpansion: z.enum(["expanded", "collapsed"]).optional().default("expanded"),
  showTimelineTools: z.boolean().optional().default(true),
  promptSubmitOnEnter: z.boolean().optional().default(false),
  lastUsedBinary: z.string().optional(),
  locale: z.string().optional(),
  environmentVariables: z.record(z.string(), z.string()).optional().default({}),
  modelRecents: z.array(ModelPreferenceSchema).optional().default([]),
  modelFavorites: z.array(ModelPreferenceSchema).optional().default([]),
  modelThinkingSelections: z.record(z.string(), z.string()).optional().default({}),
  diffViewMode: z.enum(["split", "unified"]).optional().default("split"),
  toolOutputExpansion: z.enum(["expanded", "collapsed"]).optional().default("expanded"),
  diagnosticsExpansion: z.enum(["expanded", "collapsed"]).optional().default("expanded"),
  showUsageMetrics: z.boolean().optional().default(true),
  autoCleanupBlankSessions: z.boolean().optional().default(true),
  listeningMode: z.enum(["local", "all"]).optional().default("local"),
  logLevel: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).optional().default("DEBUG"),

  // OS notifications
  osNotificationsEnabled: z.boolean().optional().default(false),
  osNotificationsAllowWhenVisible: z.boolean().optional().default(false),
  notifyOnNeedsInput: z.boolean().optional().default(true),
  notifyOnIdle: z.boolean().optional().default(true),
  })
  // Preserve unknown preference keys so newer configs survive older binaries.
  .passthrough()

const RecentFolderSchema = z.object({
  path: z.string(),
  lastAccessed: z.number().nonnegative(),
  projectName: z.string().optional(),
})

const OpenCodeBinarySchema = z.object({
  path: z.string(),
  version: z.string().optional(),
  lastUsed: z.number().nonnegative(),
  label: z.string().optional(),
})

// Zod v4: .default() on an object schema validates the default against the schema's
// input shape. Because every preference field is now `.optional().default(...)`,
// we can safely materialize the full default once and reuse it.
const PREFERENCES_DEFAULTS = PreferencesSchema.parse({})

const ConfigFileSchema = z
  .object({
    preferences: PreferencesSchema.default(PREFERENCES_DEFAULTS),
    recentFolders: z.array(RecentFolderSchema).default([]),
    opencodeBinaries: z.array(OpenCodeBinarySchema).default([]),
    theme: z.enum(["light", "dark", "system"]).optional(),
  })
  // Preserve unknown top-level keys so optional future features survive downgrades.
  .passthrough()

// On-disk config.yaml only stores stable configuration (not volatile state like recent folders).
const ConfigYamlSchema = z
  .object({
    preferences: PreferencesSchema.default(PREFERENCES_DEFAULTS),
    opencodeBinaries: z.array(OpenCodeBinarySchema).default([]),
    theme: z.enum(["light", "dark", "system"]).optional(),
  })
  .passthrough()

// On-disk state.yaml stores server-scoped mutable state (per-server, not per-client).
const StateFileSchema = z
  .object({
    recentFolders: z.array(RecentFolderSchema).default([]),
  })
  .passthrough()

const DEFAULT_CONFIG = ConfigFileSchema.parse({})
const DEFAULT_CONFIG_YAML = ConfigYamlSchema.parse({})
const DEFAULT_STATE = StateFileSchema.parse({})

export {
  ModelPreferenceSchema,
  AgentModelSelectionSchema,
  AgentModelSelectionsSchema,
  PreferencesSchema,
  RecentFolderSchema,
  OpenCodeBinarySchema,
  ConfigFileSchema,
  ConfigYamlSchema,
  StateFileSchema,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_YAML,
  DEFAULT_STATE,
}

export type ModelPreference = z.infer<typeof ModelPreferenceSchema>
export type AgentModelSelection = z.infer<typeof AgentModelSelectionSchema>
export type AgentModelSelections = z.infer<typeof AgentModelSelectionsSchema>
export type Preferences = z.infer<typeof PreferencesSchema>
export type RecentFolder = z.infer<typeof RecentFolderSchema>
export type OpenCodeBinary = z.infer<typeof OpenCodeBinarySchema>
export type ConfigFile = z.infer<typeof ConfigFileSchema>
export type ConfigYamlFile = z.infer<typeof ConfigYamlSchema>
export type StateFile = z.infer<typeof StateFileSchema>
