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
import type { TaskExecutionOutput } from "./execute-task.js"
import type { Adapter } from "../adapters/index.js"
import type { FaultSpec, RunResult, Suite, Task } from "../types.js"

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
  log: (msg: string) => void
}

export async function runSuite(opts: RunnerOptions): Promise<Suite> {
  const solari = new Solari({ apiKey: opts.apiKey })
  const startedAt = new Date()
  const suiteId = `suite-${stamp(startedAt)}`
  const runs: RunResult[] = []

  try {
    // A tiny worker pool: `parallel` browsers in flight, tasks pulled off a
    // shared cursor as slots free up.
    let cursor = 0
    const workers = Array.from(
      { length: Math.min(opts.parallel, opts.tasks.length) },
      async () => {
        for (;;) {
          const index = cursor++
          const task = opts.tasks[index]
          if (!task) return
          runs.push(await runOne(solari, task, index, suiteId, opts))
        }
      },
    )
    await Promise.all(workers)
  } finally {
    // REQUIRED: the client holds a loopback proxy open for connection retries,
    // and without this the process prints its summary and then hangs.
    await solari.close()
  }

  runs.sort((a, b) => a.taskId.localeCompare(b.taskId))
  return {
    suiteId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    seed: opts.seed,
    adapter: opts.adapter.name,
    parallel: opts.parallel,
    ...(opts.fixtureSnapshotId ? { fixtureSnapshotId: opts.fixtureSnapshotId } : {}),
    baseUrl: opts.baseUrl,
    runs,
  }
}

async function runOne(
  solari: Solari,
  task: Task,
  index: number,
  suiteId: string,
  opts: RunnerOptions,
): Promise<RunResult> {
  // Per-task seed: reproducible for this task, but distinct from its
  // neighbours so eight parallel runs are not all handed the same jitter.
  const seed = opts.seed + index
  const runId = `${suiteId}-${task.id}`
  const started = Date.now()
  const log = (m: string) => opts.log(`[${task.id}] ${m}`)

  log(`launching (seed ${seed}, ${opts.faults.length} fault(s))`)

  let sessionId: string | undefined
  let result: TaskExecutionOutput
  try {
    const browser = await solari.launch({ recording: true })
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
  }
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
 * usually 404s even on a perfectly good recording.
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
  log("no replay after polling — was the session created with recording:true?")
  return undefined
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
}
