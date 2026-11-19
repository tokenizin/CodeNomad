/**
 * suggestions/ — public surface for the dynamic, context-aware suggestion
 * system (SCR-2026-11-18-001).
 *
 * S0 core types live in `conversation.ts`; the session-chain state model in
 * `sessions.ts`; the agent contract + `generateSuggestions()` in `agents.ts`;
 * the engine-projection layer in `Context.ts`. This barrel is the single
 * import point for consumers UI / tests and keeps the internal file split
 * private.
 */

// Conversation / phase model
export {
  phaseForStatus,
  lastMessage,
  lastUserPrompt,
  lastAssistantText,
  appendMessage,
  createConversation,
} from "./conversation";
export type {
  SessionPhase,
  SessionKind,
  EngineSessionStatus,
  ChatRole,
  UserPrompt,
  AssistantText,
  ChatMessage,
  Conversation,
} from "./conversation";
export { SESSION_STATUS_TO_PHASE } from "./conversation";

// Session chain
export {
  currentSession,
  emptyConversation,
  deriveConversation,
  advanceSessionChain,
  startSessionChain,
  reprojectPhases,
  isSessionLive,
} from "./sessions";
export type {
  SessionChainEntry,
  EngineSessions,
  SessionSnapshot,
} from "./sessions";

// Agent contract + generator
export {
  generateSuggestions,
  suggestionsForSession,
  suggestionsByScope,
  isDiscussable,
} from "./agents";
export type {
  Agent,
  AgentMemory,
  AgentSkill,
  AgentRegistry,
  Suggestion,
  SuggestionScope,
  SuggestionAction,
  SuggestionInputs,
  SuggestionContext,
} from "./agents";

// Engine projection
export {
  fromContext,
  fromPrompt,
  fromContextHistory,
  toSuggestionContext,
} from "./Context";
export type {
  Context,
  FromContext,
  FromPrompt,
  FromContextHistory,
} from "./Context";
