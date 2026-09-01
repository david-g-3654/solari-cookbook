#!/usr/bin/env -S npx tsx
/**
 * splitflap — a browser-agent eval & replay harness on Solari.
 *
 *   run      N golden tasks across N parallel cloud browsers, with faults
 *   replay   fork the fixture VM and re-run one trace against the same world
 *   serve    re-publish a stored suite's dashboard on a fresh preview URL
 *   tasks    list the golden tasks
 */
import { SolariClient } from "@solarisdk/sdk"
import { loadEnv, requireApiKey } from "./config.js"
import { adapterByName } from "./adapters/index.js"
import { resolveFaults, FAULT_PRESETS } from "./faults/index.js"
import { FixtureHost } from "./fixture/host.js"
import { renderDashboard } from "./report/dashboard.js"
import { replayRun } from "./replay/replay.js"
import { runSuite } from "./run/runner.js"
import {
  findRun, listSuites, loadReplayResult, loadSuite, saveReplayResult, saveSuite,
} from "./report/store.js"
import { TASKS, taskById, withoutRecovery } from "./tasks/index.js"
import type { ReplayResult, Suite } from "./types.js"

// ------------------------------------------------------------------ args

interface Args {
  _: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith("--")) {
      out._.push(a)
      continue
    }
    const [key, inline] = a.slice(2).split("=", 2)
    const next = argv[i + 1]
    if (inline !== undefined) out.flags[key!] = inline
    else if (next && !next.startsWith("--")) { out.flags[key!] = next; i++ }
    else out.flags[key!] = true
  }
  return out
}

const str = (a: Args, k: string, d: string): string =>
  typeof a.flags[k] === "string" ? (a.flags[k] as string) : d
const num = (a: Args, k: string, d: number): number => {
  const v = a.flags[k]
  if (typeof v !== "string") return d
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`--${k} must be a number, got "${v}"`)
  return n
}
const bool = (a: Args, k: string): boolean => a.flags[k] === true || a.flags[k] === "true"

const log = (m: string) => console.log(m)

// ------------------------------------------------------------------- run

const USAGE = `splitflap — browser-agent eval & replay harness on Solari

  run [options]              run the golden tasks on parallel cloud browsers
    --tasks a,b              only these task ids (default: all 5)
    --adapter NAME           scripted | stagehand | browser-use  (default: scripted)
    --faults a,b             ${Object.keys(FAULT_PRESETS).join(" | ")}  (default: none)
    --parallel N             browsers in flight                   (default: 5)
    --seed N                 fault seed; same seed, same world    (default: 1)
    --no-recovery            strip the tasks' login-wall recovery (regression demo)
    --keep-alive MIN         keep the dashboard up this long      (default: 10)
    --no-dashboard           skip publishing the dashboard

  replay <runId> [--keep-fork]
                             fork the fixture snapshot and re-run that trace
  serve [suiteId]            re-publish a stored suite's dashboard
  tasks                      list the golden tasks
  suites                     list stored suites
`

async function cmdRun(args: Args): Promise<number> {
  const apiKey = requireApiKey()
  const adapter = adapterByName(str(args, "adapter", "scripted"))
  const faultNames = str(args, "faults", "").split(",").filter(Boolean)
  const faults = resolveFaults(faultNames)
  const seed = num(args, "seed", 1)
  const parallel = num(args, "parallel", 5)
  const keepAliveMin = num(args, "keep-alive", 10)

  const ids = str(args, "tasks", "").split(",").filter(Boolean)
  let tasks = ids.length ? ids.map(taskById) : TASKS
  if (bool(args, "no-recovery")) {
    tasks = withoutRecovery(tasks)
    log("running WITHOUT login-wall recovery — failures here are the point")
  }

  const client = new SolariClient({ apiKey })
  const fixture = await FixtureHost.start(client, log)

  let suite: Suite
  try {
    // Checkpoint the world BEFORE any run touches it. Every run in this suite
    // then shares one snapshot id, and replay forks from exactly that.
    const snapshotId = await fixture.snapshot(`splitflap-fixture-${Date.now()}`)
    log(`snapshot ${snapshotId} — runs from this suite are replayable\n`)

    suite = await runSuite({
      apiKey,
      tasks,
      adapter,
      faults,
      baseUrl: fixture.baseUrl,
      seed,
      parallel,
      fixtureSnapshotId: snapshotId,
      replayTimeoutMs: 30_000,
      log,
    })
    saveSuite(suite)
    printSummary(suite)

    if (!bool(args, "no-dashboard")) {
      const url = await fixture.publishDashboard(renderDashboard(suite))
      log(`\ndashboard: ${url}`)
      log(`(kept alive ${keepAliveMin} min; Ctrl-C to tear down now)`)
      await withTeardownOnInterrupt(fixture, () => fixture.keepAlive(keepAliveMin * 60_000, log))
    }
  } finally {
    await fixture.kill()
    log("fixture sandbox destroyed")
  }

  return suite.runs.every((r) => r.status === "pass") ? 0 : 1
}

async function cmdReplay(args: Args): Promise<number> {
  const apiKey = requireApiKey()
  const runId = args._[1]
  if (!runId) throw new Error("usage: splitflap replay <runId>")

  const { run } = findRun(runId)
  log(`replaying ${run.runId} (${run.adapter}, seed ${run.seed})`)

  const client = new SolariClient({ apiKey })
  const result = await replayRun({
    apiKey, client, run, keepFork: bool(args, "keep-fork"), log,
  })
  saveReplayResult(result)

  log("")
  if (result.deterministic) {
    log(`DETERMINISTIC — replay matched the original on every compared field`)
  } else {
    log(`DIVERGED on ${result.diffs.length} field(s):`)
    for (const d of result.diffs) {
      log(`  ${d.field}`)
      log(`    original: ${truncate(d.original)}`)
      log(`    replay:   ${truncate(d.replayed)}`)
    }
  }
  log(
    `forked ${result.forkedSandboxId} from ${result.fromSnapshotId} · server ${
      result.serverResumedFromSnapshot ? "resumed with snapshot" : "restarted after fork"
    } · ${(result.durationMs / 1000).toFixed(1)}s`,
  )
  return result.deterministic ? 0 : 1
}

async function cmdServe(args: Args): Promise<number> {
  const apiKey = requireApiKey()
  const suite = loadSuite(args._[1])
  const keepAliveMin = num(args, "keep-alive", 10)

  const replays: Record<string, ReplayResult> = {}
  for (const run of suite.runs) {
    const r = loadReplayResult(run.runId)
    if (r) replays[run.runId] = r
  }

  const client = new SolariClient({ apiKey })
  const host = await FixtureHost.start(client, log)
  try {
    const url = await host.publishDashboard(renderDashboard(suite, replays))
    log(`\ndashboard: ${url}`)
    log(`(kept alive ${keepAliveMin} min; Ctrl-C to tear down now)`)
    await withTeardownOnInterrupt(host, () => host.keepAlive(keepAliveMin * 60_000, log))
  } finally {
    await host.kill()
  }
  return 0
}

function cmdTasks(): number {
  for (const t of TASKS) {
    console.log(`${t.id.padEnd(18)} ${t.title}`)
    console.log(`${" ".repeat(18)} ${t.steps.length} steps · ${t.assertions.length} assertions` +
      `${t.recovery ? " · has login-wall recovery" : ""}`)
  }
  return 0
}

function cmdSuites(): number {
  const ids = listSuites()
  if (ids.length === 0) {
    console.log("no suites yet — try: npm run splitflap -- run")
    return 0
  }
  for (const id of ids) {
    const s = loadSuite(id)
    const passed = s.runs.filter((r) => r.status === "pass").length
    console.log(`${id}  ${s.adapter.padEnd(12)} ${passed}/${s.runs.length} passed`)
  }
  return 0
}

// ----------------------------------------------------------------- utils

function printSummary(suite: Suite): void {
  log("")
  for (const r of suite.runs) {
    const passed = r.assertions.filter((a) => a.ok).length
    log(
      `  ${r.status.toUpperCase().padEnd(6)} ${r.taskId.padEnd(18)} ` +
        `${passed}/${r.assertions.length} assertions  ${(r.durationMs / 1000).toFixed(1)}s`,
    )
  }
  const passed = suite.runs.filter((r) => r.status === "pass").length
  log(`\n${passed}/${suite.runs.length} tasks passed in ${(suite.durationMs / 1000).toFixed(1)}s`)
}

/**
 * Ctrl-C during the keep-alive window should destroy the VM, not orphan it
 * until its idle timeout. Node's default SIGINT handling would exit the
 * process before the `finally` teardown ever ran.
 */
async function withTeardownOnInterrupt(
  host: FixtureHost,
  body: () => Promise<void>,
): Promise<void> {
  let onSigint: (() => void) | undefined
  try {
    await Promise.race([
      body(),
      new Promise<void>((resolve) => {
        onSigint = () => {
          log("\ninterrupted — tearing down")
          resolve()
        }
        process.once("SIGINT", onSigint)
      }),
    ])
  } finally {
    if (onSigint) process.off("SIGINT", onSigint)
  }
}
const truncate = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

async function main(): Promise<number> {
  loadEnv()
  const args = parseArgs(process.argv.slice(2))
  switch (args._[0]) {
    case "run": return cmdRun(args)
    case "replay": return cmdReplay(args)
    case "serve": return cmdServe(args)
    case "tasks": return cmdTasks()
    case "suites": return cmdSuites()
    default:
      console.log(USAGE)
      return args._[0] ? 1 : 0
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`\nerror: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
