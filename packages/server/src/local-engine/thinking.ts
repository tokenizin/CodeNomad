/**
 * The thinking option the user picked for a model (the "Thinking: ..." selector) as the environment of a run: the Rust agent reads
 * `NOMAD_THINKING` and sends it to the model as `reasoning_effort`. Only the values the agent knows are passed on; "default" (nothing picked) and
 * anything else leave the agent's own setting alone.
 */
const THINKING_VALUES = new Set(["off", "none", "on", "low", "medium", "high"])

export function thinkingEnv(variant: string | undefined): Record<string, string> {
  const value = variant?.trim().toLowerCase()
  return value && THINKING_VALUES.has(value) ? { NOMAD_THINKING: value } : {}
}
