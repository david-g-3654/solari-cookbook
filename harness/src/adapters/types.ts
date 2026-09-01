/** The contract every agent framework is wrapped in. */
import type { Page } from "patchright-core"
import type { Task, TraceStep } from "../types.js"
import type { StepExecutor } from "../run/executor.js"

export interface AdapterRunContext {
  page: Page
  /** Root of the fixture site for this run (a Solari preview URL). */
  baseUrl: string
  /** Raw CDP endpoint of this run's session, for frameworks that attach themselves. */
  cdpEndpoint: string
  task: Task
  /** Shared executor — use it so replay re-runs identical code. */
  executor: StepExecutor
  /** Record an action into the run's trace, in execution order. */
  emit(step: TraceStep): void
  log(msg: string): void
}

export interface Adapter {
  readonly name: string
  /** True when the adapter needs an LLM key to do anything. */
  readonly requiresModel: boolean
  /** Returns the agent's answer: the values the task's assertions check. */
  run(ctx: AdapterRunContext): Promise<Record<string, unknown>>
}
