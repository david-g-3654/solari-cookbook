/**
 * The runner: N golden tasks across N parallel Solari cloud browsers.
 *
 * One browser session per run, each with recording on, each with its own
 * seeded fault chain. Sessions are independent, so a slow or wedged run cannot
 * corrupt its neighbours — the worst it does is fail its own assertions.
 *
 * Driving a task is execute-task.ts's job; everything here is about getting a
 * Solari session, releasing it, and collecting what came back.
 */
import { Solari } from "@solarisdk/browser"
import { executeTask } from "./execute-task.js"
import { LlmProxy } from "../llm/proxy.js"
import { saveCassette } from "../llm/cassette.js"
import type { ModelChoice } from "../adapters/model.js"
import { retryOnConcurrencyLimit } from "../retry.js"
import type { TaskExecutionOutput } from "./execute-task.js"
import type { Adapter } from "../adapters/index.js"
import type { FaultSpec, LlmUsage, RunResult, Suite, Task } from "../types.js"

export interface RunnerOptions {
  apiKey: string
  tasks: Task[]
  adapter: Adapter
  faults: FaultSpec[]
  baseUrl: string
  seed: number
  parallel: number
  fixtureSnapshotId?: string
  /** Poll this long for each session's rrweb replay to finish uploading. */
  replayTimeoutMs: number
  /** Runs per task. Repetitions share a seed, so variance is the agent's. */
  repeat: number
  /** Resolved model, when the adapter uses one. Enables cassette recording. */
  model?: ModelChoice
  log: (msg: string) => void
}

export async function runSuite(opts: RunnerOptions): Promise<Suite> {
  const solari = new Solari({ apiKey: opts.apiKey })
  const startedAt = new Date()
  const suiteId = `suite-${stamp(startedAt)}`
  const runs: RunResult[] = []

  // Record model traffic when there is a base URL to sit in front of. This is
  // what makes an LLM run replayable at all — Stage 1 pinned the world but
  // resampled the model, so an LLM replay verified only the environment.
  const proxy = opts.model?.openAiCompatible
    ? await LlmProxy.start({
        upstreamBaseUrl: opts.model.upstreamBaseUrl!,
        apiKey: opts.model.apiKey,
        log: opts.log,
      })
    : undefined
  if (opts.model && !proxy) {
    opts.log(
      `note: ${opts.model.id} does not speak the OpenAI wire format, so this run ` +
        "cannot be recorded — use an openrouter/… or openai/… model to enable replay",
    )
  }

  // Every repetition of a task is a separate unit of work, but they share the
  // task's seed: the world and the injected faults are identical across
  // attempts, so the variance you measure is the agent's own.
  const units = opts.tasks.flatMap((task, taskIndex) =>
    Array.from({ length: opts.repeat }, (_, attempt) => ({ task, taskIndex, attempt: attempt + 1 })),
  )

  try {
    // A tiny worker pool: `parallel` browsers in flight, units pulled off a
    // shared cursor as slots free up.
    let cursor = 0
    const workers = Array.from(
      { length: Math.min(opts.parallel, units.length) },
      async () => {
        for (;;) {
          const unit = units[cursor++]
          if (!unit) return
          runs.push(
            await runOne(solari, unit.task, unit.taskIndex, unit.attempt, suiteId, opts, proxy),
          )
        }
      },
    )
    await Promise.all(workers)
  } finally {
    await proxy?.stop()
    // REQUIRED: the client holds a loopback proxy open for connection retries,
    // and without this the process prints its summary and then hangs.
    await solari.close()
  }

  runs.sort(
    (a, b) => a.taskId.localeCompare(b.taskId) || (a.attempt ?? 1) - (b.attempt ?? 1),
  )
  return {
    suiteId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    seed: opts.seed,
    adapter: opts.adapter.name,
    parallel: opts.parallel,
    repeat: opts.repeat,
    ...(opts.fixtureSnapshotId ? { fixtureSnapshotId: opts.fixtureSnapshotId } : {}),
    baseUrl: opts.baseUrl,
    runs,
  }
}

async function runOne(
  solari: Solari,
  task: Task,
  index: number,
  attempt: number,
  suiteId: string,
  opts: RunnerOptions,
  proxy: LlmProxy | undefined,
): Promise<RunResult> {
  // Per-task seed: reproducible for this task, but distinct from its
  // neighbours so eight parallel runs are not all handed the same jitter.
  const seed = opts.seed + index
  const runId = opts.repeat > 1 ? `${suiteId}-${task.id}-r${attempt}` : `${suiteId}-${task.id}`
  const started = Date.now()
  const log = (m: string) => opts.log(`[${task.id}] ${m}`)

  log(`launching (seed ${seed}, ${opts.faults.length} fault(s))`)

  // Register this run with the proxy before the adapter can send anything:
  // an unbound run is refused rather than silently proxied on someone else's
  // key, so forgetting this makes every model call 404.
  if (proxy && opts.model) {
    proxy.bind({
      runId,
      mode: "record",
      model: opts.model.id,
      missPolicy: "live",
    })
  }

  let sessionId: string | undefined
  let result: TaskExecutionOutput
  try {
    // `--parallel` is a request, not a requirement: if the plan's cap is
    // lower, wait for a slot rather than losing the run to a 429.
    const browser = await retryOnConcurrencyLimit(
      "session",
      () => solari.launch({ recording: true }),
      { log },
    )
    sessionId = browser.id
    try {
      const context = browser.contexts()[0] ?? (await browser.newContext())
      result = await executeTask({
        context,
        task,
        baseUrl: opts.baseUrl,
        faults: opts.faults,
        seed,
        adapter: opts.adapter,
        cdpEndpoint: browser.cdpEndpoint,
        ...(proxy ? { modelBaseUrl: proxy.baseUrlFor(runId) } : {}),
        log,
      })
    } finally {
      // Closing the browser also RELEASES the session, which is what starts
      // the replay upload. Do it before polling for the replay, not after.
      await browser.close().catch(() => {})
    }
  } catch (err) {
    // A session that could not be acquired (or a browser that died on
    // teardown) is this run's problem, not the suite's. Record it as an
    // errored run so the other four still report.
    const message = err instanceof Error ? err.message.split("\n")[0]! : String(err)
    log(`could not run: ${message}`)
    result = erroredRun(message)
  }

  const llm = collectCassette(proxy, runId, opts, log)

  const replayBytes = sessionId
    ? await fetchReplay(solari, sessionId, runId, opts.replayTimeoutMs, log)
    : undefined

  log(
    `${result.status.toUpperCase()} — ` +
      `${result.assertions.filter((a) => a.ok).length}/${result.assertions.length} assertions`,
  )

  return {
    runId,
    taskId: task.id,
    adapter: opts.adapter.name,
    status: result.status,
    seed,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    sessionId,
    ...(opts.fixtureSnapshotId ? { fixtureSnapshotId: opts.fixtureSnapshotId } : {}),
    baseUrl: opts.baseUrl,
    faults: opts.faults,
    recoveryEnabled: task.recovery !== undefined,
    trace: result.trace,
    observation: result.observation,
    answer: result.answer,
    assertions: result.assertions,
    ...(result.error ? { error: result.error } : {}),
    ...(replayBytes !== undefined ? { replayBytes } : {}),
    ...(opts.repeat > 1 ? { attempt } : {}),
    ...(llm ? { llm } : {}),
    ...(result.agentReport ? { agentReport: result.agentReport } : {}),
  }
}

/** Persist this run's model traffic so `replay` can answer from it. */
function collectCassette(
  proxy: LlmProxy | undefined,
  runId: string,
  opts: RunnerOptions,
  log: (m: string) => void,
): LlmUsage | undefined {
  if (!proxy || !opts.model) return undefined
  const cassette = proxy.cassetteFor(runId)
  const stats = proxy.statsFor(runId)
  if (!cassette || !stats) return undefined
  if (cassette.entries.length > 0) {
    saveCassette(cassette)
    log(`recorded ${cassette.entries.length} model call(s)`)
  }
  return { model: opts.model.id, calls: stats.live }
}




/** A run that never got off the ground, shaped like any other run. */
function erroredRun(error: string): TaskExecutionOutput {
  return {
    trace: [],
    observation: { navigations: [], faultEvents: [], consoleErrors: [] },
    answer: {},
    assertions: [],
    status: "error",
    error,
    finalUrl: "",
  }
}

/**
 * The rrweb upload happens asynchronously AFTER release, so the first poll
 * usually 404s even on a perfectly good recording. Long runs need a longer
 * window — an LLM adapter can drive a session for minutes, and that recording
 * takes correspondingly longer to land than a 10-second scripted one.
 */
async function fetchReplay(
  solari: Solari,
  sessionId: string,
  runId: string,
  timeoutMs: number,
  log: (m: string) => void,
): Promise<number | undefined> {
  const { saveReplayBlob } = await import("../report/store.js")
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000))
    try {
      const blob = await solari.sessions.downloadReplay(sessionId)
      saveReplayBlob(runId, blob)
      log(`replay saved (${blob.length} bytes)`)
      return blob.length
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status !== 404) {
        log(`replay error: ${(err as Error).message}`)
        return undefined
      }
    }
  }
  log(
    `no replay after ${Math.round(timeoutMs / 1000)}s — it may still be uploading; ` +
      `re-fetch with the session id (${sessionId})`,
  )
  return undefined
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
}
