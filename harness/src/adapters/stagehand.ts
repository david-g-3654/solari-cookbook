/**
 * Stagehand adapter (optional — `npm i @browserbasehq/stagehand`).
 *
 * Stagehand attaches to the SAME Solari session over its raw CDP endpoint, so
 * it drives the browser the harness already prepared. That matters: the fault
 * interception is installed on the browser CONTEXT, not on our page, precisely
 * so that pages Stagehand opens for itself still get the injected latency,
 * 5xx and login wall. An adapter that connected to a browser of its own would
 * be running a different experiment.
 *
 * The trace this produces is coarser than the scripted adapter's — Stagehand
 * reports the action it took, not a replayable selector script — so `replay`
 * treats these runs as observation-diff only. See README, "What replay pins".
 */
import type { Adapter, AdapterRunContext } from "./types.js"
import type { TraceStep } from "../types.js"
import { loadStagehand, loadZod } from "./optional-deps.js"
import { resolveModel } from "./model.js"
import { stagehandModel } from "./openrouter-llm.js"

/** How many `act` turns before we call the task unfinished. */
const MAX_ACTS = 8

export const stagehandAdapter: Adapter = {
  name: "stagehand",
  requiresModel: true,

  async run(ctx: AdapterRunContext): Promise<Record<string, unknown>> {
    // Resolve the model BEFORE launching anything: a missing key should not
    // cost a browser session.
    const model = resolveModel()
    ctx.log(`stagehand via ${model.id}`)

    const sh = await loadStagehand()
    const z = await loadZod()

    // Start the agent on the task's entry page so every adapter begins from
    // the same place; what it does from there is up to the model.
    ctx.emit(await ctx.executor.trace({ do: "goto", path: ctx.task.path }, 0, {}))

    const browser = await sh.localBrowser.connect({ cdpUrl: ctx.cdpEndpoint })
    const stagehand = await sh.Stagehand.create({
      browser,
      // Native providers use Stagehand's own client; OpenRouter goes through
      // the `generate` bridge, since Stagehand offers no base-URL override.
      model: stagehandModel(model),
    })

    const answer: Record<string, unknown> = {}
    let index = 1
    try {
      for (let turn = 0; turn < MAX_ACTS; turn++) {
        const started = Date.now()
        const result = await stagehand.act(
          turn === 0
            ? ctx.task.goal
            : `Continue working on this goal. Stop as soon as it is done: ${ctx.task.goal}`,
        )
        ctx.emit(
          agentTrace(index++, `act: ${describe(result)}`, ctx.page.url(), Date.now() - started),
        )
        if (isDone(result)) break
      }

      const spec = ctx.task.extract
      if (spec) {
        const schema =
          spec.shape === "list"
            ? z.object({ values: z.array(z.string()) })
            : z.object({ value: z.string() })
        const started = Date.now()
        const out = await stagehand.extract(spec.instruction, schema)
        const data = out.data as { values?: string[]; value?: string }
        answer[spec.as] = spec.shape === "list" ? (data.values ?? []) : (data.value ?? "")
        ctx.emit(
          agentTrace(
            index++,
            `extract: ${spec.as}`,
            ctx.page.url(),
            Date.now() - started,
            answer[spec.as],
          ),
        )
      }
    } finally {
      // Closes Stagehand's own handle. The Solari session belongs to the
      // runner, which releases it after the replay is flushed.
      await stagehand.close().catch(() => {})
    }

    return answer
  },
}

/** LLM adapters report prose, not selectors — record it as an opaque note. */
function agentTrace(
  index: number,
  note: string,
  url: string,
  durationMs: number,
  extracted?: unknown,
): TraceStep {
  return {
    index,
    // Modelled as a `waitFor` on a pseudo-selector so the trace stays one
    // homogeneous list; replay skips these (see replay.ts).
    step: { do: "waitFor", selector: `agent:${note}` },
    ...(extracted === undefined ? {} : { extracted }),
    url,
    ok: true,
    durationMs,
  }
}

function describe(result: unknown): string {
  const r = result as { action?: string; message?: string; success?: boolean }
  return (r?.action ?? r?.message ?? "step").slice(0, 120)
}

function isDone(result: unknown): boolean {
  const r = result as { success?: boolean; done?: boolean }
  return r?.done === true || r?.success === false
}
