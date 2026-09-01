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

    // Interstitial recovery is not handled here: an injected wall can land
    // inside a compound step like `paginate`, so the executor clears it after
    // every navigation it performs. See run/recovery.ts.
    for (const step of ctx.task.steps) await exec(step)

    return answer
  },
}
