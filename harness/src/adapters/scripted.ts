/**
 * The scripted adapter — a deterministic agent with no model behind it.
 *
 * It exists for three reasons, and it earns its keep on all three:
 *   - it is the control. When an LLM adapter fails a task, this tells you
 *     whether the task was passable at all under those faults.
 *   - it runs in CI for free and in seconds, so the harness itself is tested.
 *   - its trace is complete and semantic, which makes it the strongest case
 *     for `splitflap replay`.
 */
import type { Adapter, AdapterRunContext } from "./types.js"
import type { Step } from "../types.js"

export const scriptedAdapter: Adapter = {
  name: "scripted",
  requiresModel: false,

  async run(ctx: AdapterRunContext): Promise<Record<string, unknown>> {
    const answer: Record<string, unknown> = {}
    let index = 0

    const exec = async (step: Step): Promise<void> => {
      ctx.emit(await ctx.executor.trace(step, index++, answer))
    }

    for (const step of ctx.task.steps) {
      await exec(step)
      // An injected interstitial can land after any navigation. A real agent
      // notices it and deals with it; this one checks for the marker and runs
      // the task's recovery script. `--no-recovery` removes that, which is how
      // you prove a red cell is a genuine robustness regression.
      await maybeRecover(ctx, exec)
    }

    return answer
  },
}

async function maybeRecover(
  ctx: AdapterRunContext,
  exec: (s: Step) => Promise<void>,
): Promise<void> {
  const recovery = ctx.task.recovery
  if (!recovery) return
  const hit = await ctx.page
    .locator(recovery.detect)
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false)
  if (!hit) return

  ctx.log(`hit ${recovery.detect}, running recovery`)
  for (const step of recovery.steps) await exec(step)
}
