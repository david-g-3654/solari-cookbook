/** Core data model for the harness: tasks, traces, faults, runs. */

// ---------------------------------------------------------------- tasks

/**
 * One deterministic action. The `scripted` adapter executes these directly;
 * LLM adapters produce them as a byproduct of whatever they decided to do, and
 * replay re-executes them without consulting the model.
 */
export type Step =
  | { do: "goto"; path: string }
  | { do: "click"; selector: string }
  | { do: "fill"; selector: string; value: string }
  | { do: "waitFor"; selector: string; timeoutMs?: number }
  | { do: "selectOption"; selector: string; value: string }
  | { do: "extractText"; selector: string; as: string }
  | { do: "extractAll"; selector: string; as: string }
  | {
      do: "paginate"
      nextSelector: string
      itemSelector: string
      as: string
      maxPages: number
    }

/** A check on the final state of the run. Adapter-independent by design. */
export type Assertion =
  | { kind: "urlContains"; value: string }
  | { kind: "textContains"; value: string }
  | { kind: "selectorVisible"; selector: string }
  | { kind: "answerEquals"; key: string; value: string }
  | { kind: "answerContains"; key: string; value: string }
  | { kind: "answerCountAtLeast"; key: string; n: number }

/**
 * How an agent gets past an unexpected interstitial (the login-wall fault).
 * Running with `--no-recovery` strips this, which is how you demonstrate that
 * the harness actually detects a robustness regression rather than noise.
 */
export interface Recovery {
  /** Selector whose presence means "we hit the wall". */
  detect: string
  steps: Step[]
}

/**
 * What an LLM adapter should hand back, so its answer lands in the same
 * `answer` keys the assertions check. Without this the model-driven adapters
 * would be scored on a different shape than the scripted baseline, and the
 * dashboard's columns would not be comparable.
 */
export interface ExtractSpec {
  instruction: string
  /** Answer key to write into. */
  as: string
  /** `list` asks for an array, which is what count assertions need. */
  shape: "text" | "list"
}

export interface Task {
  id: string
  title: string
  /** Natural-language goal handed to the LLM adapters. */
  goal: string
  /** How model-driven adapters should report their answer. */
  extract?: ExtractSpec
  /** Entry path on the fixture site, e.g. "/catalog.html". */
  path: string
  steps: Step[]
  assertions: Assertion[]
  recovery?: Recovery
}

// ---------------------------------------------------------------- faults

export type FaultSpec =
  | {
      kind: "latency"
      /** Fixed delay added to every matching request. */
      ms: number
      /** Extra 0..jitterMs drawn from the seeded RNG, so it stays replayable. */
      jitterMs?: number
      match?: string
    }
  | {
      kind: "http5xx"
      status?: number
      match?: string
      /** Fail the first N matching requests, then let them through. */
      times?: number
    }
  | {
      kind: "loginWall"
      /** Serve the wall on the Nth top-level navigation (1-based). */
      afterNavigations?: number
    }

export type FaultKind = FaultSpec["kind"]

// ---------------------------------------------------------------- traces

/** What the adapter did, in order. This is the unit of replay. */
export interface TraceStep {
  index: number
  step: Step
  /** Value(s) pulled out of the page, for extract steps. */
  extracted?: unknown
  /** URL after the step settled. */
  url: string
  ok: boolean
  error?: string
  /** Wall-clock ms. Recorded for reporting; never used to decide pass/fail. */
  durationMs: number
}

/** Non-action facts observed during a run — the environment's side of the story. */
export interface Observation {
  navigations: string[]
  /** Requests the fault layer intervened on, in order. */
  faultEvents: FaultEvent[]
  consoleErrors: string[]
}

export interface FaultEvent {
  kind: FaultKind
  url: string
  detail: string
}

export interface AssertionResult {
  assertion: Assertion
  ok: boolean
  detail: string
}

// ---------------------------------------------------------------- runs

export type RunStatus = "pass" | "fail" | "error"

export interface RunResult {
  runId: string
  taskId: string
  adapter: string
  status: RunStatus
  seed: number
  startedAt: string
  durationMs: number
  /** Solari browser session id — the handle for the rrweb replay. */
  sessionId?: string
  /** Snapshot the fixture VM was forked from; replay pins the world to this. */
  fixtureSnapshotId?: string
  baseUrl: string
  faults: FaultSpec[]
  /** Whether the task's interstitial recovery was active (`--no-recovery` off). */
  recoveryEnabled: boolean
  trace: TraceStep[]
  observation: Observation
  answer: Record<string, unknown>
  assertions: AssertionResult[]
  error?: string
  /** Bytes of rrweb NDJSON stored alongside the run, if the replay uploaded. */
  replayBytes?: number
}

export interface Suite {
  suiteId: string
  startedAt: string
  durationMs: number
  seed: number
  adapter: string
  parallel: number
  fixtureSnapshotId?: string
  baseUrl: string
  runs: RunResult[]
}

// ---------------------------------------------------------------- replay

export interface ReplayDiff {
  field: string
  original: string
  replayed: string
}

export interface ReplayResult {
  runId: string
  replayedAt: string
  forkedSandboxId: string
  fromSnapshotId: string
  baseUrl: string
  /** True when every compared field matched the original run. */
  deterministic: boolean
  diffs: ReplayDiff[]
  status: RunStatus
  durationMs: number
  /** Whether the forked VM resumed with its server already running. */
  serverResumedFromSnapshot: boolean
}
