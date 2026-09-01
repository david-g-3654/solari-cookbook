import { test } from "node:test"
import assert from "node:assert/strict"
import { FaultChain, rng, AUTH_PARAM, LOGIN_WALL_MARKER } from "../src/faults/index.js"
import type { RouteLike } from "../src/faults/index.js"

interface Call { action: "continue" | "fulfill"; status?: number; body?: string }

function fakeRoute(url: string, opts: { nav?: boolean } = {}) {
  const calls: Call[] = []
  const route: RouteLike = {
    request: () => ({
      url: () => url,
      resourceType: () => (opts.nav ? "document" : "fetch"),
      isNavigationRequest: () => Boolean(opts.nav),
    }),
    async continue() { calls.push({ action: "continue" }) },
    async fulfill(o) { calls.push({ action: "fulfill", status: o.status, body: o.body }) },
  }
  return { route, calls }
}

test("rng is deterministic per seed and differs across seeds", () => {
  const a = rng(42), b = rng(42), c = rng(43)
  const seqA = [a(), a(), a()]
  assert.deepEqual(seqA, [b(), b(), b()])
  assert.notDeepEqual(seqA, [c(), c(), c()])
})

test("http5xx fails exactly `times` matching requests, then passes", async () => {
  const chain = new FaultChain({
    faults: [{ kind: "http5xx", status: 503, match: ".html", times: 2 }],
    seed: 1,
  })
  const statuses: (number | undefined)[] = []
  for (let i = 0; i < 4; i++) {
    const { route, calls } = fakeRoute("https://x.test/catalog.html", { nav: true })
    await chain.handle(route)
    statuses.push(calls[0]!.action === "fulfill" ? calls[0]!.status : undefined)
  }
  assert.deepEqual(statuses, [503, 503, undefined, undefined])
  assert.equal(chain.events.length, 2)
})

test("http5xx ignores non-matching URLs", async () => {
  const chain = new FaultChain({
    faults: [{ kind: "http5xx", match: ".html", times: 1 }],
    seed: 1,
  })
  const { route, calls } = fakeRoute("https://x.test/style.css")
  await chain.handle(route)
  assert.equal(calls[0]!.action, "continue")
  assert.equal(chain.events.length, 0)
})

test("loginWall serves once on the Nth navigation, then clears after auth", async () => {
  const chain = new FaultChain({
    faults: [{ kind: "loginWall", afterNavigations: 2 }],
    seed: 1,
  })

  const first = fakeRoute("https://x.test/index.html", { nav: true })
  await chain.handle(first.route)
  assert.equal(first.calls[0]!.action, "continue", "nav #1 passes through")

  const second = fakeRoute("https://x.test/catalog.html", { nav: true })
  await chain.handle(second.route)
  assert.equal(second.calls[0]!.action, "fulfill", "nav #2 hits the wall")
  assert.match(second.calls[0]!.body!, new RegExp(LOGIN_WALL_MARKER))
  assert.match(second.calls[0]!.body!, new RegExp(`${AUTH_PARAM}=1`))

  // The wall's form re-requests the page with the auth flag: it must pass.
  const retry = fakeRoute(`https://x.test/catalog.html?${AUTH_PARAM}=1&u=a&p=b`, { nav: true })
  await chain.handle(retry.route)
  assert.equal(retry.calls[0]!.action, "continue", "authed retry passes")

  // And the wall must not come back for the rest of the run.
  const later = fakeRoute("https://x.test/checkout.html", { nav: true })
  await chain.handle(later.route)
  assert.equal(later.calls[0]!.action, "continue", "wall does not re-arm")
})

test("loginWall does not intercept subresources", async () => {
  const chain = new FaultChain({ faults: [{ kind: "loginWall", afterNavigations: 1 }], seed: 1 })
  const { route, calls } = fakeRoute("https://x.test/app.js")
  await chain.handle(route)
  assert.equal(calls[0]!.action, "continue")
})

test("latency delay is additive and reproducible for a given seed", async () => {
  const slept: number[] = []
  const make = (seed: number) =>
    new FaultChain({
      faults: [
        { kind: "latency", ms: 100, jitterMs: 50 },
        { kind: "latency", ms: 20 },
      ],
      seed,
      sleep: async (ms) => { slept.push(ms) },
    })

  const a = make(7)
  for (let i = 0; i < 3; i++) await a.handle(fakeRoute("https://x.test/a").route)
  const runA = slept.splice(0)

  const b = make(7)
  for (let i = 0; i < 3; i++) await b.handle(fakeRoute("https://x.test/a").route)
  const runB = slept.splice(0)

  assert.deepEqual(runA, runB, "same seed replays the same delays")
  for (const ms of runA) {
    assert.ok(ms >= 120 && ms < 170, `expected 120..169, got ${ms}`)
  }

  const c = make(99)
  for (let i = 0; i < 3; i++) await c.handle(fakeRoute("https://x.test/a").route)
  assert.notDeepEqual(slept.splice(0), runA, "a different seed gives different jitter")
})

test("a 5xx short-circuits before latency is paid", async () => {
  const slept: number[] = []
  const chain = new FaultChain({
    faults: [
      { kind: "latency", ms: 500 },
      { kind: "http5xx", match: ".html", times: 1 },
    ],
    seed: 1,
    sleep: async (ms) => { slept.push(ms) },
  })
  const { route, calls } = fakeRoute("https://x.test/a.html", { nav: true })
  await chain.handle(route)
  assert.equal(calls[0]!.action, "fulfill")
  assert.deepEqual(slept, [], "no sleep on a short-circuited request")
})
