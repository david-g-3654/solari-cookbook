import { test } from "node:test"
import assert from "node:assert/strict"
import { scoreAll, statusOf } from "../src/run/score.js"
import { diffAgainstOriginal } from "../src/replay/replay.js"
import type { RunResult, TraceStep } from "../src/types.js"

const state = (over: Partial<Parameters<typeof scoreAll>[1]> = {}) => ({
  url: "https://host.test/catalog.html",
  text: "Catalog page 1 of 3",
  answer: { items: ["Split-flap module", "Flip digit"], ref: "SF-ORDER-88231" } as Record<string, unknown>,
  visibleSelectors: new Set(["#last-page"]),
  ...over,
})

test("assertions score against end state, not the trace", () => {
  const results = scoreAll(
    [
      { kind: "urlContains", value: "catalog" },
      { kind: "textContains", value: "Catalog page" },
      { kind: "selectorVisible", selector: "#last-page" },
      { kind: "answerContains", key: "items", value: "Flip digit" },
      { kind: "answerCountAtLeast", key: "items", n: 2 },
      { kind: "answerEquals", key: "ref", value: "SF-ORDER-88231" },
    ],
    state(),
  )
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true, true, true])
  assert.equal(statusOf(results, false), "pass")
})

test("a missing selector, a short list and a wrong url all fail", () => {
  const results = scoreAll(
    [
      { kind: "selectorVisible", selector: "#nope" },
      { kind: "answerCountAtLeast", key: "items", n: 24 },
      { kind: "urlContains", value: "checkout" },
    ],
    state(),
  )
  assert.deepEqual(results.map((r) => r.ok), [false, false, false])
  assert.equal(statusOf(results, false), "fail")
})

test("answerCountAtLeast counts list entries, not characters", () => {
  const one = scoreAll([{ kind: "answerCountAtLeast", key: "ref", n: 2 }], state())
  assert.equal(one[0]!.ok, false, "a single string counts as one value")
})

test("an errored run is `error`, even with passing assertions", () => {
  const results = scoreAll([{ kind: "urlContains", value: "catalog" }], state())
  assert.equal(statusOf(results, true), "error")
})

// ------------------------------------------------------------ replay diff

const step = (i: number, url: string, ok = true): TraceStep => ({
  index: i, step: { do: "goto", path: "/index.html" }, url, ok, durationMs: 10,
})

const baseRun = (): RunResult => ({
  runId: "r1", taskId: "smoke-read", adapter: "scripted", status: "pass", seed: 1,
  startedAt: "2026-09-01T00:00:00Z", durationMs: 100, baseUrl: "https://a.test",
  faults: [], answer: { tagline: "Parts for boards." }, assertions: [],
  trace: [step(0, "https://a.test/index.html")],
  observation: {
    navigations: ["https://a.test/index.html"],
    faultEvents: [{ kind: "latency", url: "https://a.test/index.html", detail: "delayed 120ms" }],
    consoleErrors: [],
  },
})

test("an identical replay on a different host is deterministic", () => {
  const diffs = diffAgainstOriginal(baseRun(), {
    status: "pass",
    answer: { tagline: "Parts for boards." },
    // Fork host differs — that must NOT count as a divergence.
    navigations: ["https://b.test/index.html"],
    trace: [step(0, "https://b.test/index.html")],
    faultKinds: ["latency:delayed 120ms"],
  })
  assert.deepEqual(diffs, [], "only paths are compared, not hosts")
})

test("a changed answer is reported as a divergence", () => {
  const diffs = diffAgainstOriginal(baseRun(), {
    status: "pass",
    answer: { tagline: "Something else." },
    navigations: ["https://b.test/index.html"],
    trace: [step(0, "https://b.test/index.html")],
    faultKinds: ["latency:delayed 120ms"],
  })
  assert.equal(diffs.length, 1)
  assert.equal(diffs[0]!.field, "answer.tagline")
})

test("a different navigation path and a different fault stream both diverge", () => {
  const diffs = diffAgainstOriginal(baseRun(), {
    status: "fail",
    answer: { tagline: "Parts for boards." },
    navigations: ["https://b.test/somewhere-else.html"],
    trace: [step(0, "https://b.test/somewhere-else.html", false)],
    faultKinds: [],
  })
  const fields = diffs.map((d) => d.field).sort()
  assert.deepEqual(fields, ["faults", "navigations", "status", "trace.ok", "trace.urls"])
})

test("agent-note pseudo-steps are excluded from the step diff", () => {
  const run = baseRun()
  run.trace = [
    step(0, "https://a.test/index.html"),
    { index: 1, step: { do: "waitFor", selector: "agent:act: clicked" }, url: "https://a.test/index.html", ok: true, durationMs: 5 },
  ]
  const diffs = diffAgainstOriginal(run, {
    status: "pass",
    answer: { tagline: "Parts for boards." },
    navigations: ["https://b.test/index.html"],
    // Replay only re-ran the one real step.
    trace: [step(0, "https://b.test/index.html")],
    faultKinds: ["latency:delayed 120ms"],
  })
  assert.deepEqual(diffs, [])
})
