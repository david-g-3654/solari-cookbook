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
  /** How the failing attempts failed. The distinction is the whole point. */
  failureModes: FailureModes
  /** Attempts where the agent reported success on a run that failed its checks. */
  falseSuccesses: number
  runs: RunResult[]
}

export interface FailureModes {
  /** The agent said it succeeded. It did not. The dangerous one. */
  falseSuccess: number
  /** The agent finished and said it had NOT succeeded — an honest failure. */
  gaveUp: number
  /** The agent never reached a verdict: out of steps, or stopped silently. */
  incomplete: number
  /** The run threw before it could report anything. */
  errored: number
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
        failureModes: classifyFailures(runs),
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
 * An agent that reported success on a run whose assertions say otherwise.
 *
 * Prefers the framework's own verdict when it reports one; falls back to
 * "produced an answer and did not error", which is the best available proxy
 * for an adapter that reports nothing.
 */
function claimedSuccessButFailed(run: RunResult): boolean {
  if (run.status !== "fail") return false
  if (run.agentReport) return run.agentReport.claimedSuccess === true
  return !run.error && Object.keys(run.answer).length > 0
}

function classifyFailures(runs: RunResult[]): FailureModes {
  const modes: FailureModes = { falseSuccess: 0, gaveUp: 0, incomplete: 0, errored: 0 }
  for (const run of runs) {
    if (run.status === "pass") continue
    if (run.status === "error") { modes.errored++; continue }
    if (claimedSuccessButFailed(run)) { modes.falseSuccess++; continue }
    if (run.agentReport?.claimedSuccess === false) { modes.gaveUp++; continue }
    modes.incomplete++
  }
  return modes
}

/** Quotable one-liner: how a task's failures broke down. */
export function describeFailureModes(m: FailureModes): string {
  const parts: string[] = []
  if (m.falseSuccess) parts.push(`${m.falseSuccess} reported success while failing`)
  if (m.gaveUp) parts.push(`${m.gaveUp} gave up`)
  if (m.incomplete) parts.push(`${m.incomplete} stopped without a verdict`)
  if (m.errored) parts.push(`${m.errored} errored`)
  return parts.join(", ")
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
  const modes = describeFailureModes(a.failureModes)
  return (
    `  ${label.padEnd(6)} ${a.taskId.padEnd(18)} ${rate.padStart(5)} passed  ` +
    `${(a.medianDurationMs / 1000).toFixed(1)}s median` +
    (modes ? `\n         ${modes}` : "") +
    (a.stability === "stable-pass" || !worst ? "" : `\n         ${worst.kind} failed ${worst.failures}×`)
  )
}
