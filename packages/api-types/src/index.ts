/**
 * @codenomad/api-types — Shared API types for CodeNomad workspace.
 *
 * Re-exports all API types from the server package so that UI and other
 * workspace packages can import via `@codenomad/api-types` instead of
 * deep relative paths like `../../../../server/src/api-types`.
 *
 * ── MIRROR, NOT A CURATED SURFACE ────────────────────────────────────────────
 * DECISION (2026-10-17, TASK-2026-10-17-002 AC-1, owner: technical_architect):
 * this barrel mirrors the COMPLETE export surface of
 * `../../server/src/api-types`. It is not curated.
 *
 * Rationale:
 *   1. The stated purpose is path hygiene — breaking deep relative imports. A
 *      curated subset would push the UI back onto the deep paths this package
 *      exists to remove.
 *   2. Every export here is `export type` except `WINDOWS_DRIVES_ROOT`. Widening
 *      a type-only surface emits no JavaScript: no bundle change, no runtime
 *      behaviour change, no secret exposure. The encapsulation argument that
 *      justifies curation does not apply to a type-only barrel.
 *   3. The 33 names that were missing (29x TS2305 + 4x TS2724) were almost all
 *      in `ui/src/lib/api-client.ts` — the HTTP client, whose imports are
 *      contract-complete by nature: one request/response pair per endpoint.
 *      That is a snapshot that lagged the client's growth, not a boundary.
 *
 * DO NOT "trim" this file. A name withheld here is not merely unused — it is a
 * name the next UI caller cannot type-check against, and that surfaces as
 * TS2305/TS2724 rather than as a build failure (electron-vite strips types and
 * never resolves identifiers, so an unresolvable import can ship as a runtime
 * ReferenceError). See scripts/codenomad-typecheck-gate.sh.
 *
 * Source-passthrough by design: `main`/`exports` point at `./src/index.ts`, and
 * `packages/ui/tsconfig.json` maps `@codenomad/api-types` to this file, so
 * `tsc` always reads live upstream source. Do NOT introduce a `dist/` build for
 * this package — a stale `dist` would make the typecheck gate validate against
 * a build artifact instead of the source of truth.
 */

// ── Workspace lifecycle ──────────────────────────────────────────────────────
export type {
  WorkspaceStatus,
  WorkspaceDescriptor,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceCloneRequest,
  WorkspaceCloneResponse,
  WorkspaceListResponse,
  WorkspaceDetailResponse,
  WorkspaceDeleteResponse,
  WorkspaceExecRequest,
  WorkspaceExecResponse,
  WorkspaceFileResponse,
  WorkspaceFileSearchResponse,
  WorkspaceFileUploadItem,
  WorkspaceFileUploadRequest,
  WorkspaceFileUploadResponse,
  LogLevel,
  WorkspaceLogEntry,
} from '../../server/src/api-types';

// ── Worktrees & git ──────────────────────────────────────────────────────────
export type {
  WorktreeKind,
  WorktreeDescriptor,
  WorktreeListResponse,
  WorktreeCreateRequest,
  WorktreeMap,
  GitChangeKind,
  WorktreeGitStatusEntry,
  WorktreeGitStatusResponse,
  WorktreeGitDiffScope,
  WorktreeGitPathsRequest,
  WorktreeGitMutationResponse,
  WorktreeGitCommitRequest,
  WorktreeGitCommitResponse,
  WorktreeGitDiffRequest,
  WorktreeGitDiffResponse,
} from '../../server/src/api-types';

// ── File system & config files ───────────────────────────────────────────────
export type {
  FileSystemEntry,
  FileSystemScope,
  FileSystemPathKind,
  FileSystemListingMetadata,
  FileSystemListResponse,
  FileSystemCreateFolderRequest,
  FileSystemCreateFolderResponse,
  FileSystemFileContentResponse,
  ConfigFileDescriptor,
  ConfigFileListResponse,
  ConfigFileContentRequest,
  ConfigFileContentResponse,
} from '../../server/src/api-types';

/** Sentinel path segment representing the Windows drive root. Runtime value. */
export { WINDOWS_DRIVES_ROOT } from '../../server/src/api-types';

// ── Instances, streaming & sidecars ──────────────────────────────────────────
export type {
  InstanceData,
  InstanceStreamStatus,
  InstanceStreamEvent,
  SideCarKind,
  SideCarPrefixMode,
  SideCarStatus,
  SideCar,
  PreviewSession,
} from '../../server/src/api-types';

// ── Binaries & settings ──────────────────────────────────────────────────────
export type {
  BinaryRecord,
  BinaryListResponse,
  BinaryCreateRequest,
  BinaryUpdateRequest,
  BinaryValidationResult,
  SettingsOwner,
  SettingsBucket,
  SettingsDoc,
} from '../../server/src/api-types';

// ── Speech ───────────────────────────────────────────────────────────────────
export type {
  SpeechSegment,
  SpeechCapabilitiesResponse,
  SpeechTranscriptionResponse,
  SpeechSynthesisResponse,
} from '../../server/src/api-types';

// ── Local LLM models & providers ─────────────────────────────────────────────
export type {
  LocalLlmModelDescriptor,
  LocalLlmModelsResponse,
  ModelCapabilities,
  ModelStatus,
  SyncedModel,
  ModelSyncResult,
  SyncModelsResponse,
  ModelTestResult,
  TestModelResponse,
  TestModelBatchResponse,
  ProviderConfigDescriptor,
  ProviderConfigsResponse,
} from '../../server/src/api-types';

// ── Voice mode & remote access ───────────────────────────────────────────────
export type {
  VoiceModeStateResponse,
  RemoteServerProfile,
  RemoteServerProbeRequest,
  RemoteServerProbeResponse,
  RemoteProxySessionCreateRequest,
  RemoteProxySessionCreateResponse,
} from '../../server/src/api-types';

// ── Workspace events, network & server meta ──────────────────────────────────
export type {
  WorkspaceEventType,
  WorkspaceEventPayload,
  NetworkAddress,
  LatestReleaseInfo,
  UiMeta,
  SupportMeta,
  ServerMeta,
} from '../../server/src/api-types';

// ── Background processes ─────────────────────────────────────────────────────
export type {
  BackgroundProcessStatus,
  BackgroundProcessTerminalReason,
  BackgroundProcess,
  BackgroundProcessListResponse,
  BackgroundProcessOutputResponse,
} from '../../server/src/api-types';

// ── Server config-schema re-exports (KNOWN TRANSITIVE LEAK — keep in sync) ───
// These do NOT originate in `api-types.ts`; upstream re-exports them from
// `./config/schema` at its lines 629-635. They are server *configuration file*
// types, not part of the HTTP/SSE contract described at `api-types.ts:10-13`.
//
// They are mirrored here anyway, deliberately: they are type-only (no runtime
// cost), and withholding them would recreate the exact rot this file exists to
// prevent — the next reader re-adds them and re-breaks the typecheck gate. If
// these are ever removed from the upstream trailing block, remove them here in
// the same commit.
export type {
  Preferences,
  ModelPreference,
  AgentModelSelections,
  RecentFolder,
  OpenCodeBinary,
} from '../../server/src/api-types';