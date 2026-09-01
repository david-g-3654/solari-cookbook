/**
 * Integration tests: the real harness code, a real browser, a real HTTP server.
 *
 * Everything here except Solari itself is the code that ships — the fixture
 * site, the fault chain wired into Playwright's router, the step executor, the
 * recovery hook, the scripted adapter and the scorer, all driven through
 * `executeTask`, exactly as the Solari runner drives it.
 *
 * The browser is the locally installed Chrome (`channel: "chrome"`), so this
 * needs no browser download. Skips itself cleanly if Chrome is absent.
 */
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { chromium, type Browser } from "patchright-core"

import { executeTask } from "../src/run/execute-task.js"
import { fixtureFiles, FIXTURE_ITEM_COUNT } from "../src/fixture/site.js"
import { scriptedAdapter } from "../src/adapters/scripted.js"
import { FAULT_PRESETS } from "../src/faults/index.js"
import { diffAgainstOriginal } from "../src/replay/replay.js"
import { TASKS, taskById, withoutRecovery } from "../src/tasks/index.js"
import type { FaultSpec, RunResult, Task } from "../src/types.js"

/** Serve the fixture from memory — same bytes the sandbox would serve. */
function serveFixture(): Promise<{ server: Server; baseUrl: string }> {
  const files = fixtureFiles()
  const server = createServer((req, res) => {
    // Query strings are ignored, exactly as a static file server ignores them.
    // That is what lets the login wall's `?sf_auth=1` round-trip work.
    const name = (req.url ?? "/").split("?")[0]!.replace(/^\/+/, "") || "index.html"
    const body = files[name]
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("not found")
      return
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` })
    })
  })
}

let browser: Browser | undefined
let server: Server
let baseUrl: string
let chromeAvailable = true

before(async () => {
  ;({ server, baseUrl } = await serveFixture())
  try {
    browser = await chromium.launch({ headless: true, channel: "chrome" })
  } catch {
    chromeAvailable = false
  }
})

after(async () => {
  await browser?.close()
  await new Promise((r) => server.close(r))
})

/** Run one task the way the Solari runner does, but in a local browser. */
async function run(
  task: Task,
  faults: FaultSpec[] = [],
  seed = 1,
): Promise<Awaited<ReturnType<typeof executeTask>>> {
  const context = await browser!.newContext()
  try {
    return await executeTask({
      context,
      task,
      baseUrl,
      faults,
      seed,
      adapter: scriptedAdapter,
      cdpEndpoint: "",
      log: () => {},
    })
  } finally {
    await context.close()
  }
}

const skip = () => (chromeAvailable ? false : "no local Chrome — skipping")

describe("golden tasks against the hermetic fixture", () => {
  for (const task of TASKS) {
    test(`${task.id} passes with no faults`, { skip: skip() }, async () => {
      const out = await run(task)
      const failed = out.assertions.filter((a) => !a.ok).map((a) => a.detail)
      assert.equal(out.status, "pass", `${out.error ?? ""} ${failed.join("; ")}`)
    })
  }

  test("paginate-collect really walks every page", { skip: skip() }, async () => {
    const out = await run(taskById("paginate-collect"))
    assert.equal((out.answer.skus as string[]).length, FIXTURE_ITEM_COUNT)
  })
})

describe("injected faults", () => {
  test("latency slows a run but does not break it", { skip: skip() }, async () => {
    const out = await run(taskById("smoke-read"), [FAULT_PRESETS.latency!])
    assert.equal(out.status, "pass")
    assert.ok(out.observation.faultEvents.length > 0, "latency should have been applied")
  })

  test("a login wall mid-run is recovered from", { skip: skip() }, async () => {
    const out = await run(taskById("paginate-collect"), [FAULT_PRESETS.loginWall!])
    const walls = out.observation.faultEvents.filter((e) => e.kind === "loginWall")
    assert.equal(walls.length, 1, "the wall should be served exactly once")
    assert.equal(out.status, "pass", out.error ?? "recovery should clear the wall")
    assert.equal(
      (out.answer.skus as string[]).length,
      FIXTURE_ITEM_COUNT,
      "pagination should resume after the wall, losing nothing",
    )
  })

  test("without recovery the same wall fails the run", { skip: skip() }, async () => {
    const [stripped] = withoutRecovery([taskById("paginate-collect")])
    const out = await run(stripped!, [FAULT_PRESETS.loginWall!])
    assert.notEqual(out.status, "pass", "a stripped agent must not survive the wall")
  })

  test("a 5xx on the entry page fails the run", { skip: skip() }, async () => {
    const out = await run(taskById("login-flow"), [FAULT_PRESETS.http5xx!])
    assert.notEqual(out.status, "pass")
    assert.ok(
      out.observation.faultEvents.some((e) => e.kind === "http5xx"),
      "the 503 should be recorded",
    )
  })
})

describe("determinism", () => {
  /**
   * The local half of the replay claim: same seed, same world, same trace and
   * same answers. Replay proper adds the VM fork, which pins the world for
   * runs where the site could otherwise have changed underneath.
   */
  test("the same seed reproduces the same run", { skip: skip() }, async () => {
    const task = taskById("paginate-collect")
    const faults = [FAULT_PRESETS.loginWall!, FAULT_PRESETS.latency!]

    const first = await run(task, faults, 7)
    const second = await run(task, faults, 7)

    const asRun = (o: typeof first): RunResult => ({
      runId: "x", taskId: task.id, adapter: "scripted", status: o.status, seed: 7,
      startedAt: "", durationMs: 0, baseUrl, faults, recoveryEnabled: true,
      trace: o.trace, observation: o.observation, answer: o.answer,
      assertions: o.assertions,
    })

    const diffs = diffAgainstOriginal(asRun(first), {
      status: second.status,
      answer: second.answer,
      navigations: second.observation.navigations,
      trace: second.trace,
      faultKinds: second.observation.faultEvents.map((e) => `${e.kind}:${e.detail}`),
    })
    assert.deepEqual(diffs, [], "two runs at the same seed must not diverge")
  })

  test("a different seed still reaches the same answer", { skip: skip() }, async () => {
    const task = taskById("catalog-browse")
    const a = await run(task, [FAULT_PRESETS.latency!], 1)
    const b = await run(task, [FAULT_PRESETS.latency!], 2)
    assert.deepEqual(a.answer, b.answer, "jitter must not change what the agent found")
    assert.equal(a.status, "pass")
    assert.equal(b.status, "pass")
  })
})
