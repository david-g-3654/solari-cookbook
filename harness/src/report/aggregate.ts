/**
 * Aggregating repeated attempts into something you can act on.
 *
 * A single run of a stochastic agent tells you almost nothing. `paginate-collect`
 * returned 16 of 24 SKUs once — that could be a 0% pass rate or a 60% one, and
 * those call for very different responses.
 *
 * Because every attempt at a task shares the task's seed, the world and the
 * injected faults are byte-identical across attempts. So the spread measured
 * here is the agent's own nondeterminism, not the web's.
 */
import type { RunResult, Suite } from "../types.js"

/** The distinction that matters. `flaky` is invisible at N=1. */
export type Stability = "stable-pass" | "flaky" | "stable-fail"

export interface TaskAggregate {
  taskId: string
  attempts: number
  passes: number
  /** 0..1 */
  passRate: number
  stability: Stability
  /** Assertions that failed at least once, most frequent first. */
  unreliableAssertions: Array<{ kind: string; failures: number }>
  medianDurationMs: number
  /** True when the agent claimed success on an attempt that failed its checks. */
  falseSuccesses: number
  runs: RunResult[]
}

export function aggregate(suite: Suite): TaskAggregate[] {
  const byTask = new Map<string, RunResult[]>()
  for (const run of suite.runs) {
    const list = byTask.get(run.taskId) ?? []
    list.push(run)
    byTask.set(run.taskId, list)
  }

  return [...byTask.entries()]
    .map(([taskId, runs]) => {
      const passes = runs.filter((r) => r.status === "pass").length
      const failures = new Map<string, number>()
      for (const run of runs) {
        for (const a of run.assertions) {
          if (!a.ok) failures.set(a.assertion.kind, (failures.get(a.assertion.kind) ?? 0) + 1)
        }
      }
      return {
        taskId,
        attempts: runs.length,
        passes,
        passRate: runs.length === 0 ? 0 : passes / runs.length,
        stability: classify(passes, runs.length),
        unreliableAssertions: [...failures.entries()]
          .map(([kind, n]) => ({ kind, failures: n }))
          .sort((a, b) => b.failures - a.failures),
        medianDurationMs: median(runs.map((r) => r.durationMs)),
        falseSuccesses: runs.filter(claimedSuccessButFailed).length,
        runs: [...runs].sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1)),
      }
    })
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
}

function classify(passes: number, attempts: number): Stability {
  if (attempts === 0) return "stable-fail"
  if (passes === attempts) return "stable-pass"
  if (passes === 0) return "stable-fail"
  return "flaky"
}

/**
 * An agent that finished cleanly and produced an answer, on a run whose
 * assertions say it did not do the job. Distinct from erroring out: an agent
 * that fails loudly is manageable, one that reports success is not.
 */
function claimedSuccessButFailed(run: RunResult): boolean {
  return run.status === "fail" && !run.error && Object.keys(run.answer).length > 0
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!
}

/** One-line summary for the CLI. */
export function describeAggregate(a: TaskAggregate): string {
  const rate = `${a.passes}/${a.attempts}`
  const label =
    a.stability === "stable-pass" ? "PASS" : a.stability === "stable-fail" ? "FAIL" : "FLAKY"
  const worst = a.unreliableAssertions[0]
  return (
    `  ${label.padEnd(6)} ${a.taskId.padEnd(18)} ${rate.padStart(5)} passed  ` +
    `${(a.medianDurationMs / 1000).toFixed(1)}s median` +
    (a.stability === "stable-pass" || !worst ? "" : `  · ${worst.kind} failed ${worst.failures}×`)
  )
}
