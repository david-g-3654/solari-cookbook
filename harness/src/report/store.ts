/** On-disk state: suites, and the rrweb replays downloaded alongside them. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stateDir } from "../config.js"
import type { ReplayResult, RunResult, Suite } from "../types.js"

const suitesDir = () => join(stateDir(), "suites")
const replaysDir = () => join(stateDir(), "replays")
const replaysResultDir = () => join(stateDir(), "replay-results")

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function saveSuite(suite: Suite): string {
  const path = join(ensure(suitesDir()), `${suite.suiteId}.json`)
  writeFileSync(path, JSON.stringify(suite, null, 2))
  writeFileSync(join(suitesDir(), "latest.json"), JSON.stringify(suite, null, 2))
  return path
}

/** Load a suite by id, or the most recent one. */
export function loadSuite(suiteId?: string): Suite {
  const dir = suitesDir()
  const path = join(dir, `${suiteId ?? "latest"}.json`)
  if (!existsSync(path)) {
    throw new Error(
      suiteId
        ? `no suite "${suiteId}" under ${dir}`
        : `no runs yet — try: npm run splitflap -- run`,
    )
  }
  return JSON.parse(readFileSync(path, "utf8")) as Suite
}

export function listSuites(): string[] {
  const dir = suitesDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "latest.json")
    .map((f) => f.replace(/\.json$/, ""))
    .sort()
    .reverse()
}

/** Find one run across every stored suite. */
export function findRun(runId: string): { suite: Suite; run: RunResult } {
  for (const id of ["latest", ...listSuites()]) {
    let suite: Suite
    try {
      suite = loadSuite(id === "latest" ? undefined : id)
    } catch {
      continue
    }
    const run = suite.runs.find((r) => r.runId === runId)
    if (run) return { suite, run }
  }
  throw new Error(`no run "${runId}" in ${suitesDir()}`)
}

export function saveReplayBlob(runId: string, bytes: Uint8Array): string {
  const path = join(ensure(replaysDir()), `${runId}.ndjson`)
  writeFileSync(path, bytes)
  return path
}

export function replayBlobPath(runId: string): string | undefined {
  const path = join(replaysDir(), `${runId}.ndjson`)
  return existsSync(path) ? path : undefined
}

export function saveReplayResult(result: ReplayResult): string {
  const path = join(ensure(replaysResultDir()), `${result.runId}.json`)
  writeFileSync(path, JSON.stringify(result, null, 2))
  return path
}

export function loadReplayResult(runId: string): ReplayResult | undefined {
  const path = join(replaysResultDir(), `${runId}.json`)
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, "utf8")) as ReplayResult
}
