/**
 * Deterministic replay.
 *
 * A browser-agent run has three sources of nondeterminism: the site's
 * responses, the agent's decisions, and timing. Replay pins all three:
 *
 *   the site    fork the microVM from the snapshot taken when the suite
 *               started — the fork serves byte-identical bytes
 *   the agent   for a scripted run, re-execute the recorded action trace; for
 *               an LLM run, re-run the AGENT with its recorded responses
 *               served from a cassette, so it makes the same decisions
 *               without a single token being spent
 *   timing      same seed into the same fault chain, so the same requests are
 *               delayed, 5xx'd and walled at the same points
 *
 * What that buys you: when a replay diverges, the divergence is real. It is
 * not the site having changed under you, and not the model having rolled a
 * different sample. That is the difference between a flake and a bug.
 *
 * Two modes, picked by what the run left behind:
 *
 *   trace   no cassette (the scripted adapter). Re-executes the recorded
 *           selector script through the same executor the original used.
 *   agent   a cassette exists. Re-runs the real adapter, with every model
 *           call answered from the recording. A cache MISS is itself a
 *           finding: the agent asked something it did not ask before, which
 *           means it took a different path.
 */
import { Solari } from "@solarisdk/browser"
import type { SolariClient } from "@solarisdk/sdk"
import { FaultChain } from "../faults/index.js"
import { FixtureHost } from "../fixture/host.js"
import { adapterByName } from "../adapters/index.js"
import { resolveModel } from "../adapters/model.js"
import { CassetteReader, loadCassette } from "../llm/cassette.js"
import { LlmProxy, type MissPolicy } from "../llm/proxy.js"
import { executeTask } from "../run/execute-task.js"
import { StepExecutor, captureFinalState } from "../run/executor.js"
import { makeRecoveryHandler } from "../run/recovery.js"
import { scoreAll, statusOf } from "../run/score.js"
import { retryOnConcurrencyLimit } from "../retry.js"
import { taskById } from "../tasks/index.js"
import type { ReplayDiff, ReplayResult, RunResult, Step, TraceStep } from "../types.js"

export interface ReplayOptions {
  apiKey: string
  client: SolariClient
  run: RunResult
  /** Keep the forked VM alive afterwards (for poking at it by hand). */
  keepFork: boolean
  /** What to do when the agent asks something the cassette does not hold. */
  missPolicy: MissPolicy
  log: (msg: string) => void
}

/** Pseudo-steps emitted by LLM adapters carry prose, not a selector. */
function isAgentNote(step: Step): boolean {
  return step.do === "waitFor" && step.selector.startsWith("agent:")
}

/**
 * Normalise a URL for comparison.
 *
 * Two things differ between a run and its replay by construction, and neither
 * is a divergence:
 *   - the host, because a fork gets its own preview subdomain;
 *   - `pt_token`, the per-sandbox access token the preview URL carries.
 *
 * Everything else in the query IS meaningful and stays: `sf_auth=1` is how the
 * login wall records that it was cleared, and the account form submits its
 * fields as a GET. Dropping the whole query string would hide real
 * differences; keeping the token would report a divergence on every single
 * replay, which is worse than useless.
 */
export function pathOf(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.delete(PREVIEW_TOKEN_PARAM)
    return u.pathname + u.search
  } catch {
    return url
  }
}

/** Query parameter Solari's preview URLs carry their access token in. */
const PREVIEW_TOKEN_PARAM = "pt_token"

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

  // A cassette means the agent's decisions were recorded, so we can re-run the
  // agent itself rather than its footprints. That is a far stronger claim: the
  // scripted trace only proves the steps replay, whereas this proves the agent
  // reaches the same place when the world and the model both hold still.
  const cassette = loadCassette(run.runId)
  const mode: "trace" | "agent" = cassette ? "agent" : "trace"
  log(`replaying in ${mode} mode${cassette ? ` (${cassette.entries.length} recorded calls)` : ""}`)

  let proxy: LlmProxy | undefined
  if (cassette) {
    const model = resolveModel()
    if (!model.openAiCompatible) {
      throw new Error(`${model.id} cannot be replayed — it does not speak the OpenAI wire format`)
    }
    proxy = await LlmProxy.start({
      upstreamBaseUrl: model.upstreamBaseUrl!,
      apiKey: model.apiKey,
      log,
    })
    proxy.bind({
      runId: run.runId,
      mode: "replay",
      model: cassette.model,
      missPolicy: opts.missPolicy,
      reader: new CassetteReader(cassette),
    })
  }

  const trace: TraceStep[] = []
  const navigations: string[] = []
  let answer: Record<string, unknown> = {}
  let finalUrl = ""
  let finalText = ""
  let visible = new Set<string>()
  let error: string | undefined
  let assertions: ReturnType<typeof scoreAll> = []
  let proxyStats: { hits: number; misses: number; live: number } | undefined

  // Same faults, same seed. Any difference now is a real difference.
  const chain = new FaultChain({ faults: run.faults, seed: run.seed })

  const browser = await retryOnConcurrencyLimit("session", () => solari.launch(), { log })
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext())

    if (mode === "agent") {
      // Drive the real adapter through exactly the path the runner uses, with
      // every model call answered from the recording.
      const out = await executeTask({
        context,
        task,
        baseUrl: fork.baseUrl,
        faults: run.faults,
        seed: run.seed,
        adapter: adapterByName(run.adapter),
        cdpEndpoint: browser.cdpEndpoint,
        modelBaseUrl: proxy!.baseUrlFor(run.runId),
        log,
      })
      trace.push(...out.trace)
      navigations.push(...out.observation.navigations)
      answer = out.answer
      assertions = out.assertions
      finalUrl = out.finalUrl
      if (out.error) error = out.error
      // executeTask installs its own fault chain; use the events it recorded.
      chain.events.push(...out.observation.faultEvents)
    } else {
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
        [page, ...context.pages().filter((p) => p !== page)],
        task.assertions.flatMap((a) => (a.kind === "selectorVisible" ? [a.selector] : [])),
      )
      finalUrl = final.url
      finalText = final.text
      visible = final.visibleSelectors
      assertions = scoreAll(task.assertions, {
        url: finalUrl,
        text: finalText,
        answer,
        visibleSelectors: visible,
      })
    }
  } catch (err) {
    error = err instanceof Error ? err.message.split("\n")[0]! : String(err)
    log(`replay error: ${error}`)
  } finally {
    await browser.close().catch(() => {})
    await solari.close()
    // Read the accounting before the listener goes away.
    proxyStats = proxy?.statsFor(run.runId)
    await proxy?.stop()
    if (!opts.keepFork) await fork.kill()
    else log(`fork kept alive: ${fork.baseUrl}`)
  }

  const status = statusOf(assertions, Boolean(error))
  const stats = proxyStats

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
    // A cache miss means the agent asked something it never asked when
    // recording, i.e. it took a different path. That is a divergence even if
    // it happened to land in the same place.
    deterministic: diffs.length === 0 && (stats?.misses ?? 0) === 0,
    diffs,
    status,
    durationMs: Date.now() - started,
    serverResumedFromSnapshot: fork.resumedFromSnapshot,
    mode,
    ...(stats
      ? { llm: { cacheHits: stats.hits, cacheMisses: stats.misses, liveCalls: stats.live } }
      : {}),
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
  // adapters emit — they carry prose, not a selector, and must be filtered
  // from BOTH sides. An agent replay re-runs the adapter, so the replayed
  // trace contains notes too.
  const originalSteps = run.trace.filter((t) => !isAgentNote(t.step))
  const replayedSteps = got.trace.filter((t) => !isAgentNote(t.step))
  push("trace.ok", originalSteps.map((t) => t.ok), replayedSteps.map((t) => t.ok))
  push(
    "trace.urls",
    originalSteps.map((t) => pathOf(t.url)),
    replayedSteps.map((t) => pathOf(t.url)),
  )

  return diffs
}
