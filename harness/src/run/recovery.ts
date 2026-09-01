/**
 * Interstitial recovery, shared by the runner and the replayer.
 *
 * The login-wall fault can land on ANY navigation, including one that happens
 * inside a compound step like `paginate` — an agent mid-loop is exactly where
 * a real interstitial is most annoying. So recovery is a hook the executor
 * calls after every navigation it performs, not just something checked between
 * top-level steps.
 *
 * Recovery runs silently: it is not emitted into the trace. That is
 * deliberate — replay builds the identical handler from the task definition
 * and the run's `recoveryEnabled` flag, so both sides recover the same way and
 * the trace stays a record of what the AGENT chose to do. The fact that a wall
 * was served is already recorded, as a fault event.
 */
import type { Page } from "patchright-core"
import type { Recovery } from "../types.js"
import type { StepExecutor } from "./executor.js"

export type InterstitialHandler = () => Promise<void>

export function makeRecoveryHandler(
  page: Page,
  executor: () => StepExecutor,
  recovery: Recovery | undefined,
  log: (m: string) => void,
): InterstitialHandler | undefined {
  if (!recovery) return undefined

  return async () => {
    const hit = await page
      .locator(recovery.detect)
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false)
    if (!hit) return

    log(`hit ${recovery.detect}, recovering`)
    const scratch: Record<string, unknown> = {}
    for (const step of recovery.steps) {
      await executor().run(step, scratch)
    }
  }
}
