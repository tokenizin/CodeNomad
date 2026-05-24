const WORKSPACE_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()

export interface RollbackResult {
  success: boolean
  previousHash?: string
  previousMsg?: string
  branch?: string
  error?: string
}

/**
 * Rollback the workspace to the previous commit, force push,
 * and optionally trigger a Vercel redeploy.
 */
export async function rollbackToPreviousCommit(
  triggerRedeploy = false,
): Promise<RollbackResult> {
  try {
    const { execSync } = await import('child_process')
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: WORKSPACE_ROOT, encoding: 'utf-8' }).trim()
    const prevHash = execSync('git rev-parse HEAD~1', { cwd: WORKSPACE_ROOT, encoding: 'utf-8' }).trim()
    const prevMsg = execSync(`git log --oneline -1 ${prevHash}`, { cwd: WORKSPACE_ROOT, encoding: 'utf-8' }).trim()

    execSync(`git reset --hard ${prevHash}`, { cwd: WORKSPACE_ROOT, encoding: 'utf-8' })
    execSync(`git push origin ${branch} --force`, { cwd: WORKSPACE_ROOT, encoding: 'utf-8', timeout: 30000 })

    const result: RollbackResult = {
      success: true,
      previousHash: prevHash.slice(0, 7),
      previousMsg: prevMsg,
      branch,
    }

    if (triggerRedeploy) {
      const hookUrl = process.env.VERCEL_DEPLOY_HOOK_URL
      if (hookUrl) {
        await fetch(hookUrl, { method: 'POST' })
        result.previousMsg = `${prevMsg} (redeploy triggered)`
      }
    }

    return result
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
    }
  }
}

/**
 * Get the diff summary between HEAD and previous commit.
 */
export async function captureDiffForRollback(): Promise<string> {
  try {
    const { execSync } = await import('child_process')
    return execSync('git diff --cached --stat 2>/dev/null || echo "(no staged changes)"', {
      cwd: WORKSPACE_ROOT, encoding: 'utf-8', maxBuffer: 1024 * 1024,
    })
  } catch { return '(could not capture diff)' }
}
