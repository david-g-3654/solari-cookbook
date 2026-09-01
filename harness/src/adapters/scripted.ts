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

    const exec = async (step: Step) => {
      const outcome = await ctx.executor.trace(step, index++, answer)
      ctx.emit(outcome)
      return outcome
    }

    // Interstitial recovery is not handled here: an injected wall can land
    // inside a compound step like `paginate`, so the executor clears it after
    // every navigation it performs. See run/recovery.ts.
    for (const step of ctx.task.steps) {
      const outcome = await exec(step)
      if (!outcome.ok) {
        // Stop rather than grinding through the rest of the script. Once a
        // step fails the run is already lost, and every following step just
        // burns another full timeout against a page that will never have the
        // element — five dead steps is over a minute of cloud browser time.
        // The trace stays honest: it records what was actually attempted.
        ctx.log(`step ${outcome.index} failed, abandoning ${
          ctx.task.steps.length - outcome.index - 1
        } remaining step(s)`)
        break
      }
    }

    return answer
  },
}
