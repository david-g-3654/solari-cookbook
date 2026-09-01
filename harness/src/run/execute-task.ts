/**
 * Driving one task in one browser context.
 *
 * Deliberately separated from the Solari runner: this function knows nothing
 * about how the browser was obtained, only what to do with it. That split is
 * what lets the integration tests drive the REAL executor, fault chain,
 * recovery hook and scorer against a local browser — testing the code that
 * ships rather than a reimplementation of it.
 *
 * Everything Solari-specific (launching, recording, releasing, replay
 * download) stays in runner.ts.
 */
import type { BrowserContext, Page } from "patchright-core"
import { FaultChain } from "../faults/index.js"
import { StepExecutor, captureFinalState } from "./executor.js"
import { makeRecoveryHandler } from "./recovery.js"
import { scoreAll, statusOf } from "./score.js"
import type { Adapter } from "../adapters/types.js"
import type {
  AssertionResult, FaultSpec, Observation, RunStatus, Task, TraceStep,
} from "../types.js"

export interface TaskExecutionInput {
  context: BrowserContext
  task: Task
  baseUrl: string
  faults: FaultSpec[]
  seed: number
  adapter: Adapter
  /** Raw CDP endpoint, for adapters that attach themselves. */
  cdpEndpoint: string
  log: (msg: string) => void
}

export interface TaskExecutionOutput {
  trace: TraceStep[]
  observation: Observation
  answer: Record<string, unknown>
  assertions: AssertionResult[]
  status: RunStatus
  error?: string
  finalUrl: string
}

export async function executeTask(input: TaskExecutionInput): Promise<TaskExecutionOutput> {
  const { context, task, log } = input

  const trace: TraceStep[] = []
  const observation: Observation = { navigations: [], faultEvents: [], consoleErrors: [] }
  const chain = new FaultChain({ faults: input.faults, seed: input.seed })

  let answer: Record<string, unknown> = {}
  let error: string | undefined
  let finalUrl = ""
  let finalText = ""
  let visibleSelectors = new Set<string>()

  try {
    await installFaults(context, chain)
    const page = await context.newPage()
    wireObservers(page, observation)

    // The recovery handler needs the executor and the executor needs the
    // handler, so the handler takes a lazy getter rather than the instance.
    let executor!: StepExecutor
    const onInterstitial = makeRecoveryHandler(page, () => executor, task.recovery, log)
    executor = new StepExecutor(page, input.baseUrl, { onInterstitial })

    answer = await input.adapter.run({
      page,
      baseUrl: input.baseUrl,
      cdpEndpoint: input.cdpEndpoint,
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
  }

  const assertions = scoreAll(task.assertions, {
    url: finalUrl,
    text: finalText,
    answer,
    visibleSelectors,
  })

  return {
    trace,
    observation,
    answer,
    assertions,
    status: statusOf(assertions, Boolean(error)),
    ...(error ? { error } : {}),
    finalUrl,
  }
}

/**
 * Faults are installed on the CONTEXT rather than on our page, deliberately:
 * adapters like Stagehand and Browser-Use attach over CDP and open pages of
 * their own, and context-level routing is what makes those pages meet the same
 * injected faults as the scripted baseline.
 */
export async function installFaults(context: BrowserContext, chain: FaultChain): Promise<void> {
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
  return task.assertions.flatMap((a) => (a.kind === "selectorVisible" ? [a.selector] : []))
}
