import path from "path"

export function getMonorepoRoot(): string {
  return process.env.CLI_WORKSPACE_ROOT || process.cwd()
}

export function getTargetAppDir(): string {
  return (process.env.CLI_TARGET_APP_DIR || "").replace(/^\/+|\/+$/g, "")
}

export function getTargetAppWorkspaceRoot(): string {
  const nested = getTargetAppDir()
  const root = getMonorepoRoot()
  return nested ? path.join(root, nested) : root
}

/**
 * Spawn cwd: default = active workspace root (nested app when CLI_TARGET_APP_DIR set).
 * "in <dir>" is always relative to monorepo root to avoid double-nesting
 * (e.g. workspace already prestix.app-1 + "in prestix.app-1").
 */
export function resolveSpawnWorkspacePath(
  workspaceRoot: string,
  promptSubdir: string | null | undefined,
): string {
  if (!promptSubdir) return workspaceRoot
  const normalized = promptSubdir.replace(/^\/+|\/+$/g, "")
  if (!normalized) return workspaceRoot
  return path.join(getMonorepoRoot(), normalized)
}
