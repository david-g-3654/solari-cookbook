/**
 * Failure-mode injection.
 *
 * Faults are applied client-side through Playwright request interception rather
 * than by teaching the fixture server to misbehave. Three reasons:
 *   - they work against ANY target, not just our fixture;
 *   - they are per-run, so eight parallel runs can each get a different world;
 *   - they are driven by a seeded RNG and integer counters, so a replay with
 *     the same seed injects the same faults at the same points.
 *
 * That last property is the whole ballgame: if faults were wall-clock or
 * randomly timed, a replay divergence would tell you nothing.
 */
import type { FaultEvent, FaultSpec } from "../types.js"

/** Minimal deterministic PRNG (mulberry32). Same seed, same stream, forever. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Substring match; `undefined` matches everything. */
function matches(url: string, pattern?: string): boolean {
  return pattern === undefined || url.includes(pattern)
}

/** Query flag the login wall sets on its way out, so we only wall once. */
export const AUTH_PARAM = "sf_auth"

export const LOGIN_WALL_MARKER = "sf-login-wall"

function loginWallHtml(returnTo: string): string {
  // The form GETs the page it interrupted with `sf_auth=1` attached. The
  // interceptor sees that flag and stops walling, and a static file server
  // ignores the query string — so "logging in" really does resume the run.
  const sep = returnTo.includes("?") ? "&" : "?"
  const action = `${returnTo}${sep}${AUTH_PARAM}=1`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in required</title>
<style>body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;padding:3rem;max-width:26rem}
input{display:block;width:100%;padding:.5rem;margin:.35rem 0 .9rem;font:inherit}
button{padding:.5rem 1rem;font:inherit}</style></head>
<body>
<div id="${LOGIN_WALL_MARKER}">
  <h1>Sign in to continue</h1>
  <p>Your session expired. Sign in to return to the page you requested.</p>
  <form id="sf-login-form" method="GET" action="${action}">
    <label for="sf-user">Username</label><input id="sf-user" name="u">
    <label for="sf-pass">Password</label><input id="sf-pass" name="p" type="password">
    <button id="sf-login-submit" type="submit">Sign in</button>
  </form>
</div>
</body></html>`
}

/**
 * Anything with Playwright's `route` shape. Typed structurally so this module
 * stays testable without booting a browser.
 */
export interface RouteLike {
  request(): {
    url(): string
    resourceType(): string
    isNavigationRequest(): boolean
  }
  continue(): Promise<void>
  fulfill(opts: { status?: number; contentType?: string; body?: string }): Promise<void>
}

export interface FaultChainOptions {
  faults: FaultSpec[]
  seed: number
  /** Injected so tests don't actually sleep. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * The stateful interception logic, extracted from Playwright so it can be unit
 * tested directly. `handle` is what the route handler calls per request.
 */
export class FaultChain {
  readonly events: FaultEvent[] = []
  private readonly faults: FaultSpec[]
  private readonly rand: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** Per-fault counters, indexed alongside `faults`. */
  private readonly hits: number[]
  private navigations = 0
  private wallCleared = false
  private wallServed = false

  constructor(opts: FaultChainOptions) {
    this.faults = opts.faults
    this.rand = rng(opts.seed)
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.hits = opts.faults.map(() => 0)
  }

  /** How many faults are configured; zero means routing can be skipped. */
  get faultCount(): number {
    return this.faults.length
  }

  private record(kind: FaultEvent["kind"], url: string, detail: string): void {
    this.events.push({ kind, url, detail })
  }

  async handle(route: RouteLike): Promise<void> {
    const req = route.request()
    const url = req.url()
    const isNav = req.isNavigationRequest() && req.resourceType() === "document"

    if (isNav) {
      this.navigations++
      if (url.includes(`${AUTH_PARAM}=1`)) this.wallCleared = true
    }

    // Login wall first: it short-circuits the response entirely.
    for (let i = 0; i < this.faults.length; i++) {
      const f = this.faults[i]!
      if (f.kind !== "loginWall") continue
      const at = f.afterNavigations ?? 1
      if (isNav && !this.wallServed && !this.wallCleared && this.navigations >= at) {
        this.wallServed = true
        this.hits[i]!++
        this.record("loginWall", url, `served wall on navigation #${this.navigations}`)
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: loginWallHtml(url),
        })
        return
      }
    }

    // Then 5xx, which also short-circuits.
    for (let i = 0; i < this.faults.length; i++) {
      const f = this.faults[i]!
      if (f.kind !== "http5xx") continue
      const times = f.times ?? 1
      if (matches(url, f.match) && this.hits[i]! < times) {
        this.hits[i]!++
        const status = f.status ?? 503
        this.record("http5xx", url, `returned ${status} (${this.hits[i]}/${times})`)
        await route.fulfill({
          status,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body><h1>${status}</h1><p>Injected by splitflap.</p></body></html>`,
        })
        return
      }
    }

    // Latency is additive and lets the request through.
    let delay = 0
    for (let i = 0; i < this.faults.length; i++) {
      const f = this.faults[i]!
      if (f.kind !== "latency") continue
      if (!matches(url, f.match)) continue
      const jitter = f.jitterMs ? Math.floor(this.rand() * f.jitterMs) : 0
      delay += f.ms + jitter
      this.hits[i]!++
    }
    if (delay > 0) {
      this.record("latency", url, `delayed ${delay}ms`)
      await this.sleep(delay)
    }
    await route.continue()
  }
}

/** Named presets so the CLI can take `--faults latency,http5xx,loginWall`. */
export const FAULT_PRESETS: Record<string, FaultSpec> = {
  // Slow enough to expose missing waits, short enough to keep a suite quick.
  latency: { kind: "latency", ms: 250, jitterMs: 150 },
  // One hard 503 on a page fetch; an agent that never retries will fail.
  http5xx: { kind: "http5xx", status: 503, match: ".html", times: 1 },
  // An interstitial appears mid-run, exactly where no task script expects it.
  loginWall: { kind: "loginWall", afterNavigations: 2 },
}

export function resolveFaults(names: string[]): FaultSpec[] {
  return names.map((n) => {
    const preset = FAULT_PRESETS[n.trim()]
    if (!preset) {
      throw new Error(
        `unknown fault "${n}" — expected one of: ${Object.keys(FAULT_PRESETS).join(", ")}`,
      )
    }
    return preset
  })
}
