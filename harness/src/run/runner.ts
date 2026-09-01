/**
 * The runner: N golden tasks across N parallel Solari cloud browsers.
 *
 * One browser session per run, each with recording on, each with its own
 * seeded fault chain. Sessions are independent, so a slow or wedged run cannot
 * corrupt its neighbours — the worst it does is fail its own assertions.
 *
 * Fault interception is installed on the browser CONTEXT rather than on our
 * page, deliberately: adapters like Stagehand and Browser-Use attach over CDP
 * and open pages of their own, and context-level routing is what makes those
 * pages meet the same injected faults as the scripted baseline.
 */
import { Solari } from "@solarisdk/browser"
import type { BrowserContext, Page } from "patchright-core"
import { FaultChain } from "../faults/index.js"
import { StepExecutor, captureFinalState } from "./executor.js"
import { scoreAll, statusOf } from "./score.js"
import type { Adapter } from "../adapters/index.js"
import type {
  FaultSpec, Observation, RunResult, Suite, Task, TraceStep,
} from "../types.js"

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

  const trace: TraceStep[] = []
  const observation: Observation = { navigations: [], faultEvents: [], consoleErrors: [] }
  let answer: Record<string, unknown> = {}
  let sessionId: string | undefined
  let error: string | undefined
  let finalUrl = ""
  let finalText = ""
  let visibleSelectors = new Set<string>()

  log(`launching (seed ${seed}, ${opts.faults.length} fault(s))`)
  const browser = await solari.launch({ recording: true })
  sessionId = browser.id

  const chain = new FaultChain({ faults: opts.faults, seed })
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext())
    await installFaults(context, chain)
    const page = await context.newPage()
    wireObservers(page, observation)

    const executor = new StepExecutor(page, opts.baseUrl)
    answer = await opts.adapter.run({
      page,
      baseUrl: opts.baseUrl,
      cdpEndpoint: browser.cdpEndpoint,
      task,
      executor,
      emit: (t) => trace.push(t),
      log,
    })

    const final = await captureFinalState(page, selectorsUnderTest(task))
    finalUrl = final.url
    finalText = final.text
    visibleSelectors = final.visibleSelectors
  } catch (err) {
    error = err instanceof Error ? err.message.split("\n")[0]! : String(err)
    log(`error: ${error}`)
  } finally {
    observation.faultEvents.push(...chain.events)
    // Closing the browser also RELEASES the session, which is what starts the
    // replay upload. Do it before polling for the replay, not after.
    await browser.close().catch(() => {})
  }

  const assertions = scoreAll(task.assertions, {
    url: finalUrl,
    text: finalText,
    answer,
    visibleSelectors,
  })
  const status = statusOf(assertions, Boolean(error))

  const replayBytes = sessionId
    ? await fetchReplay(solari, sessionId, runId, opts.replayTimeoutMs, log)
    : undefined

  log(`${status.toUpperCase()} — ${assertions.filter((a) => a.ok).length}/${assertions.length} assertions`)

  return {
    runId,
    taskId: task.id,
    adapter: opts.adapter.name,
    status,
    seed,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    ...(sessionId ? { sessionId } : {}),
    ...(opts.fixtureSnapshotId ? { fixtureSnapshotId: opts.fixtureSnapshotId } : {}),
    baseUrl: opts.baseUrl,
    faults: opts.faults,
    trace,
    observation,
    answer,
    assertions,
    ...(error ? { error } : {}),
    ...(replayBytes !== undefined ? { replayBytes } : {}),
  }
}

async function installFaults(context: BrowserContext, chain: FaultChain): Promise<void> {
  if (chain.faultCount === 0) return
  await context.route("**/*", async (route) => {
    try {
      await chain.handle(route)
    } catch {
      // Never let the fault layer wedge a run: fall through to the network.
      await route.continue().catch(() => {})
    }
  })
}

function wireObservers(page: Page, observation: Observation): void {
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) observation.navigations.push(frame.url())
  })
  page.on("console", (msg) => {
    if (msg.type() === "error") observation.consoleErrors.push(msg.text().slice(0, 300))
  })
}

/** Selectors an assertion will ask about, so we can check them before teardown. */
function selectorsUnderTest(task: Task): string[] {
  return task.assertions
    .filter((a): a is Extract<typeof a, { kind: "selectorVisible" }> => a.kind === "selectorVisible")
    .map((a) => a.selector)
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
