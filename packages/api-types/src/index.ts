/**
 * @codenomad/api-types — Shared API types for CodeNomad workspace.
 *
 * Re-exports all API types from the server package so that UI and other
 * workspace packages can import via `@codenomad/api-types` instead of
 * deep relative paths like `../../../../server/src/api-types`.
 */

export type {
  BackgroundProcess,
  ConfigFileDescriptor,
  FileSystemEntry,
  FileSystemListingMetadata,
  InstanceData,
  LocalLlmModelsResponse,
  NetworkAddress,
  PreviewSession,
  RemoteServerProfile,
  ServerMeta,
  SideCar,
  SpeechCapabilitiesResponse,
  SupportMeta,
  WorkspaceDescriptor,
  WorkspaceEventPayload,
  WorkspaceEventType,
  WorkspaceExecResponse,
  WorkspaceLogEntry,
  WorktreeDescriptor,
  WorktreeGitStatusEntry,
  WorktreeMap,
} from '../../server/src/api-types';

export { WINDOWS_DRIVES_ROOT } from '../../server/src/api-types';
