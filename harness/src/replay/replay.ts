/**
 * Deterministic replay.
 *
 * A browser-agent run has three sources of nondeterminism: the site's
 * responses, the agent's decisions, and timing. Replay pins all three:
 *
 *   the site    fork the microVM from the snapshot taken when the suite
 *               started — the fork serves byte-identical bytes
 *   the agent   re-execute the RECORDED action trace instead of asking the
 *               model again (so replay is deterministic and costs no tokens)
 *   timing      same seed into the same fault chain, so the same requests are
 *               delayed, 5xx'd and walled at the same points
 *
 * What that buys you: when a replay diverges, the divergence is real. It is
 * not the site having changed under you, and not the model having rolled a
 * different sample. That is the difference between a flake and a bug.
 *
 * The honest limit: for the LLM adapters the recorded trace is a report of
 * what the agent said it did, not a replayable selector script, so those runs
 * replay the harness-driven steps and diff observations only. The scripted
 * adapter replays end to end.
 */
import { Solari } from "@solarisdk/browser"
import type { SolariClient } from "@solarisdk/sdk"
import { FaultChain } from "../faults/index.js"
import { FixtureHost } from "../fixture/host.js"
import { StepExecutor, captureFinalState } from "../run/executor.js"
import { makeRecoveryHandler } from "../run/recovery.js"
import { scoreAll, statusOf } from "../run/score.js"
import { taskById } from "../tasks/index.js"
import type { ReplayDiff, ReplayResult, RunResult, Step, TraceStep } from "../types.js"

export interface ReplayOptions {
  apiKey: string
  client: SolariClient
  run: RunResult
  /** Keep the forked VM alive afterwards (for poking at it by hand). */
  keepFork: boolean
  log: (msg: string) => void
}

/** Pseudo-steps emitted by LLM adapters carry prose, not a selector. */
function isAgentNote(step: Step): boolean {
  return step.do === "waitFor" && step.selector.startsWith("agent:")
}

/** Compare paths, not hosts — a fork always has a different preview host. */
function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}

export async function replayRun(opts: ReplayOptions): Promise<ReplayResult> {
  const { run, log } = opts
  if (!run.fixtureSnapshotId) {
    throw new Error(
      `run ${run.runId} has no fixture snapshot — it cannot be replayed deterministically`,
    )
  }
  const task = taskById(run.taskId)
  const started = Date.now()

  const fork = await FixtureHost.fork(opts.client, run.fixtureSnapshotId, log)
  const solari = new Solari({ apiKey: opts.apiKey })

  const trace: TraceStep[] = []
  const navigations: string[] = []
  const answer: Record<string, unknown> = {}
  let finalUrl = ""
  let finalText = ""
  let visible = new Set<string>()
  let error: string | undefined

  // Same faults, same seed. Any difference now is a real difference.
  const chain = new FaultChain({ faults: run.faults, seed: run.seed })

  const browser = await solari.launch()
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext())
    if (chain.faultCount > 0) {
      await context.route("**/*", async (route) => {
        try {
          await chain.handle(route)
        } catch {
          await route.continue().catch(() => {})
        }
      })
    }
    const page = await context.newPage()
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) navigations.push(f.url())
    })

    // Recover exactly as the original run did — including whether recovery
    // was active at all, so a `--no-recovery` run replays as a `--no-recovery`
    // run rather than mysteriously succeeding.
    let executor!: StepExecutor
    const onInterstitial = makeRecoveryHandler(
      page,
      () => executor,
      run.recoveryEnabled ? task.recovery : undefined,
      log,
    )
    executor = new StepExecutor(page, fork.baseUrl, { onInterstitial })
    let index = 0
    for (const original of run.trace) {
      if (isAgentNote(original.step)) continue
      trace.push(await executor.trace(original.step, index++, answer))
    }

    const final = await captureFinalState(
      page,
      task.assertions.flatMap((a) => (a.kind === "selectorVisible" ? [a.selector] : [])),
    )
    finalUrl = final.url
    finalText = final.text
    visible = final.visibleSelectors
  } catch (err) {
    error = err instanceof Error ? err.message.split("\n")[0]! : String(err)
    log(`replay error: ${error}`)
  } finally {
    await browser.close().catch(() => {})
    await solari.close()
    if (!opts.keepFork) await fork.kill()
    else log(`fork kept alive: ${fork.baseUrl}`)
  }

  const assertions = scoreAll(task.assertions, {
    url: finalUrl,
    text: finalText,
    answer,
    visibleSelectors: visible,
  })
  const status = statusOf(assertions, Boolean(error))

  const diffs = diffAgainstOriginal(run, {
    status,
    answer,
    navigations,
    trace,
    faultKinds: chain.events.map((e) => `${e.kind}:${e.detail}`),
  })

  return {
    runId: run.runId,
    replayedAt: new Date().toISOString(),
    forkedSandboxId: fork.sandboxId,
    fromSnapshotId: run.fixtureSnapshotId,
    baseUrl: fork.baseUrl,
    deterministic: diffs.length === 0,
    diffs,
    status,
    durationMs: Date.now() - started,
    serverResumedFromSnapshot: fork.resumedFromSnapshot,
  }
}

interface ReplayObserved {
  status: string
  answer: Record<string, unknown>
  navigations: string[]
  trace: TraceStep[]
  faultKinds: string[]
}

/**
 * What counts as a divergence. Deliberately excludes timings — a replay that
 * took 200ms longer is not a different outcome, and treating it as one would
 * make the whole feature cry wolf.
 */
export function diffAgainstOriginal(run: RunResult, got: ReplayObserved): ReplayDiff[] {
  const diffs: ReplayDiff[] = []
  const push = (field: string, original: unknown, replayed: unknown) => {
    const a = JSON.stringify(original) ?? "undefined"
    const b = JSON.stringify(replayed) ?? "undefined"
    if (a !== b) diffs.push({ field, original: a, replayed: b })
  }

  push("status", run.status, got.status)

  const keys = new Set([...Object.keys(run.answer), ...Object.keys(got.answer)])
  for (const k of keys) push(`answer.${k}`, run.answer[k], got.answer[k])

  push(
    "navigations",
    run.observation.navigations.map(pathOf),
    got.navigations.map(pathOf),
  )
  push(
    "faults",
    run.observation.faultEvents.map((e) => `${e.kind}:${e.detail}`),
    got.faultKinds,
  )

  // Step-level outcomes, ignoring the agent-note pseudo-steps the LLM
  // adapters emit (they have no replayable selector).
  const originalSteps = run.trace.filter((t) => !isAgentNote(t.step))
  push(
    "trace.ok",
    originalSteps.map((t) => t.ok),
    got.trace.map((t) => t.ok),
  )
  push(
    "trace.urls",
    originalSteps.map((t) => pathOf(t.url)),
    got.trace.map((t) => pathOf(t.url)),
  )

  return diffs
}
