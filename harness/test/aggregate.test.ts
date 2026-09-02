import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { aggregate, describeAggregate } from "../src/report/aggregate.js"
import type { RunResult, Suite } from "../src/types.js"

const run = (over: Partial<RunResult>): RunResult => ({
  runId: "r", taskId: "t", adapter: "browser-use", status: "pass", seed: 1,
  startedAt: "", durationMs: 1000, baseUrl: "", faults: [], recoveryEnabled: true,
  trace: [], observation: { navigations: [], faultEvents: [], consoleErrors: [] },
  answer: {}, assertions: [], ...over,
})

const suite = (runs: RunResult[]): Suite => ({
  suiteId: "s", startedAt: "", durationMs: 0, seed: 1, adapter: "browser-use",
  parallel: 1, repeat: runs.length, baseUrl: "", runs,
})

const failed = (kind: string) => ({
  assertion: { kind, value: "x" } as never, ok: false, detail: "",
})
const passed = (kind: string) => ({
  assertion: { kind, value: "x" } as never, ok: true, detail: "",
})

describe("stability", () => {
  test("all passing is stable, not flaky", () => {
    const [a] = aggregate(suite([run({ status: "pass" }), run({ status: "pass" })]))
    assert.equal(a!.stability, "stable-pass")
    assert.equal(a!.passRate, 1)
  })

  test("all failing is stable-fail — a consistent bug, not noise", () => {
    const [a] = aggregate(suite([run({ status: "fail" }), run({ status: "fail" })]))
    assert.equal(a!.stability, "stable-fail")
  })

  test("a mix is flaky, which is the case N=1 cannot see", () => {
    const [a] = aggregate(
      suite([run({ status: "pass" }), run({ status: "fail" }), run({ status: "pass" })]),
    )
    assert.equal(a!.stability, "flaky")
    assert.equal(a!.passes, 2)
    assert.equal(Math.round(a!.passRate * 100), 67)
  })

  test("an errored attempt counts against the pass rate", () => {
    const [a] = aggregate(suite([run({ status: "pass" }), run({ status: "error" })]))
    assert.equal(a!.stability, "flaky")
    assert.equal(a!.passes, 1)
  })
})

describe("which assertion is unreliable", () => {
  test("failures are counted per kind, worst first", () => {
    const [a] = aggregate(
      suite([
        run({ status: "fail", assertions: [failed("answerCountAtLeast"), failed("selectorVisible")] }),
        run({ status: "fail", assertions: [failed("answerCountAtLeast"), passed("selectorVisible")] }),
        run({ status: "pass", assertions: [passed("answerCountAtLeast"), passed("selectorVisible")] }),
      ]),
    )
    assert.deepEqual(a!.unreliableAssertions, [
      { kind: "answerCountAtLeast", failures: 2 },
      { kind: "selectorVisible", failures: 1 },
    ])
  })
})

describe("false success", () => {
  test("an agent that answered but failed its checks is a false success", () => {
    // The checkout case: it reported an order reference for an order that was
    // never placed.
    const [a] = aggregate(
      suite([run({ status: "fail", answer: { ref: "6724099" }, assertions: [failed("answerContains")] })]),
    )
    assert.equal(a!.falseSuccesses, 1)
  })

  test("an agent that errored out is NOT a false success", () => {
    // Failing loudly is manageable; claiming success is not. Keep them apart.
    const [a] = aggregate(
      suite([run({ status: "error", error: "timeout", answer: { ref: "x" } })]),
    )
    assert.equal(a!.falseSuccesses, 0)
  })

  test("a passing run is never a false success", () => {
    const [a] = aggregate(suite([run({ status: "pass", answer: { ref: "SF-ORDER-88231" } })]))
    assert.equal(a!.falseSuccesses, 0)
  })
})

describe("shape", () => {
  test("median duration ignores an outlier attempt", () => {
    const [a] = aggregate(
      suite([run({ durationMs: 1000 }), run({ durationMs: 2000 }), run({ durationMs: 60000 })]),
    )
    assert.equal(a!.medianDurationMs, 2000)
  })

  test("attempts are grouped by task and ordered", () => {
    const out = aggregate(
      suite([
        run({ taskId: "b", attempt: 1 }),
        run({ taskId: "a", attempt: 2 }),
        run({ taskId: "a", attempt: 1 }),
      ]),
    )
    assert.deepEqual(out.map((x) => x.taskId), ["a", "b"])
    assert.deepEqual(out[0]!.runs.map((r) => r.attempt), [1, 2])
  })

  test("the CLI line names the flaky assertion", () => {
    const [a] = aggregate(
      suite([
        run({ status: "pass", assertions: [passed("urlContains")] }),
        run({ status: "fail", assertions: [failed("urlContains")] }),
      ]),
    )
    const line = describeAggregate(a!)
    assert.match(line, /FLAKY/)
    assert.match(line, /1\/2 passed/)
    assert.match(line, /urlContains failed 1×/)
  })
})
