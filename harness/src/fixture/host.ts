/**
 * The fixture sandbox: serves the golden-task site, and is the thing we
 * snapshot so runs can be replayed against a byte-identical world.
 *
 * The lifecycle that matters:
 *   start()      boot a microVM, write the site, serve it, get a public URL
 *   snapshot()   checkpoint RAM+disk WHILE it keeps serving
 *   fork()       boot a second VM from that checkpoint — a private copy of
 *                the exact web a given run saw
 *
 * `snapshot()` is taken with the HTTP server already running, so a fork
 * normally resumes with the server live. "Normally" is doing real work in that
 * sentence, so `fork()` health-checks and restarts the server if the resume
 * did not bring it back, and reports which happened.
 */
import type { SolariClient } from "@solarisdk/sdk"
import { FIXTURE_PORT, FIXTURE_ROOT } from "../config.js"
import { retryOnConcurrencyLimit } from "../retry.js"
import { withPath } from "../url.js"
import { fixtureFiles, fixtureHash } from "./site.js"

/** Minimum surface we need from a sandbox handle. Keeps this unit testable. */
type Sandbox = Awaited<ReturnType<SolariClient["sandboxes"]["create"]>>

const BOOT_TIMEOUT_MS = 10 * 60_000

export class FixtureHost {
  private constructor(
    readonly sandbox: Sandbox,
    readonly baseUrl: string,
    /** True when a fork resumed with its server already running. */
    readonly resumedFromSnapshot: boolean,
  ) {}

  get sandboxId(): string {
    return this.sandbox.sandboxId
  }

  /** Boot a fresh fixture host from the golden template. */
  static async start(client: SolariClient, log: (m: string) => void): Promise<FixtureHost> {
    const sandbox = await retryOnConcurrencyLimit("fixture sandbox", () =>
      client.sandboxes.create({
        template: "base",
        timeoutMs: BOOT_TIMEOUT_MS,
        metadata: { app: "splitflap", role: "fixture" },
      }),
      { log },
    )
    log(`sandbox ${sandbox.sandboxId} booting`)
    await sandbox.connect()

    await writeSite(sandbox)
    await startServer(sandbox)

    const baseUrl = await resolveUrl(sandbox)
    await waitForHealthy(baseUrl, log)
    log(`fixture serving at ${baseUrl}`)
    return new FixtureHost(sandbox, baseUrl, false)
  }

  /**
   * Checkpoint the running VM. The sandbox keeps serving afterwards, so the
   * suite can run against the very state that was captured.
   *
   * Snapshots are named by the fixture's CONTENT hash and reused: the site is
   * generated from fixed inputs, so every suite serving the same bytes can
   * share one. Minting a fresh multi-gigabyte snapshot per run filled the
   * plan's storage quota in a day and then failed every subsequent run with
   * "Not snapshottable".
   */
  async snapshot(client: SolariClient, log: (m: string) => void): Promise<string | undefined> {
    const name = snapshotName()
    const existing = await findSnapshot(client, name)
    if (existing) {
      log(`reusing snapshot ${existing} — the fixture is unchanged`)
      return existing
    }
    try {
      const id = await this.sandbox.snapshot(name)
      log(`snapshot ${id} — runs from this suite are replayable`)
      return id
    } catch (err) {
      // A run without a snapshot is still a valid run; it just cannot be
      // replayed. Losing the whole suite over it would be worse.
      log(
        `could not snapshot (${(err as Error).message}) — this suite will run but ` +
          "not be replayable. `splitflap clean --snapshots` frees quota.",
      )
      // A failed checkpoint does not always leave the VM as it found it: a
      // suite that hit the storage quota went on to fail every task, because
      // the fixture had stopped serving what it served a moment earlier.
      // Confirm the world is still there before running against it.
      await this.ensureServing(log)
      return undefined
    }
  }

  /** Re-check the fixture, restarting its server if the VM was disturbed. */
  private async ensureServing(log: (m: string) => void): Promise<void> {
    if (await isHealthy(this.baseUrl)) return
    log("fixture stopped serving — restarting it")
    await startServer(this.sandbox)
    await waitForHealthy(this.baseUrl, log)
  }

  /** Boot a private copy of a previous snapshot. This is what replay runs against. */
  static async fork(
    client: SolariClient,
    snapshotId: string,
    log: (m: string) => void,
  ): Promise<FixtureHost> {
    // Booting from a snapshot occasionally comes up with a control channel
    // that closes as soon as it opens (`Control channel closed (1005)`), and
    // that can surface on the first command rather than on connect. So the
    // whole bring-up — connect, resolve, verify, restart if needed — retries
    // as one unit; retrying only the connect leaves the later failure loose.
    const { sandbox, baseUrl, resumed } = await withRetries(3, log, async () => {
      const sb = await retryOnConcurrencyLimit("fork", () =>
        client.sandboxes.create({
          fromSnapshot: snapshotId,
          timeoutMs: BOOT_TIMEOUT_MS,
          metadata: { app: "splitflap", role: "fixture-fork" },
        }),
        { log },
      )
      try {
        await sb.connect()
        const url = await resolveUrl(sb)

        // A RAM+disk snapshot often brings the HTTP server back with it, but
        // not reliably — the same snapshot has forked both ways. Verify rather
        // than assume, restart if needed, and report which happened so the
        // dashboard does not quietly imply a guarantee that does not exist.
        let wasResumed = true
        if (!(await isHealthy(url))) {
          log("forked VM did not resume its server — restarting it")
          wasResumed = false
          await startServer(sb)
          await waitForHealthy(url, log)
        }
        return { sandbox: sb, baseUrl: url, resumed: wasResumed }
      } catch (err) {
        // Do not leak a half-booted VM into the plan's concurrency budget.
        await sb.kill().catch(() => {})
        throw err
      }
    })
    log(`forked ${sandbox.sandboxId} from ${snapshotId}`)
    log(`fork serving at ${baseUrl}`)
    return new FixtureHost(sandbox, baseUrl, resumed)
  }

  /** Publish the generated dashboard into the served root. */
  async publishDashboard(files: Record<string, string>): Promise<string> {
    for (const [name, body] of Object.entries(files)) {
      await this.sandbox.files.write(`${FIXTURE_ROOT}/_dash/${name}`, body)
    }
    return withPath(this.baseUrl, "/_dash/index.html")
  }

  /**
   * Hold the sandbox open so a human can actually look at the dashboard.
   *
   * `timeoutMs` is a rolling IDLE window, not a hard deadline, and a dashboard
   * nobody has clicked yet counts as idle — so a plain sleep would let the VM
   * expire out from under the URL we just printed. Heartbeat instead.
   */
  async keepAlive(ms: number, log: (m: string) => void): Promise<void> {
    const deadline = Date.now() + ms
    const HEARTBEAT_MS = 60_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(HEARTBEAT_MS, deadline - Date.now())))
      if (Date.now() >= deadline) break
      try {
        await this.sandbox.setTimeout(BOOT_TIMEOUT_MS)
      } catch (err) {
        log(`keep-alive heartbeat failed: ${(err as Error).message}`)
        return
      }
    }
  }

  async kill(): Promise<void> {
    await this.sandbox.kill().catch(() => {})
  }
}

/** Retry a transient boot failure a few times before giving up. */
async function withRetries<T>(
  attempts: number,
  log: (m: string) => void,
  fn: () => Promise<T>,
): Promise<T> {
  let last: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if (i < attempts) {
        log(`fork attempt ${i} failed (${(err as Error).message}) — retrying`)
        await new Promise((r) => setTimeout(r, 2_000 * i))
      }
    }
  }
  throw last
}

/** Snapshot name for the current fixture content. */
export function snapshotName(): string {
  return `splitflap-fixture-${fixtureHash()}`
}

async function findSnapshot(
  client: SolariClient,
  name: string,
): Promise<string | undefined> {
  try {
    const { snapshots } = await client.sandboxes.listSnapshots({ limit: 100 })
    return snapshots.find((s) => s.name === name)?.id
  } catch {
    return undefined
  }
}

async function writeSite(sandbox: Sandbox): Promise<void> {
  const files = fixtureFiles()
  for (const [name, body] of Object.entries(files)) {
    await sandbox.files.write(`${FIXTURE_ROOT}/${name}`, body)
  }
}

async function startServer(sandbox: Sandbox): Promise<void> {
  // `commands.run` waits for exit, so the server must be backgrounded or it
  // would block until the idle timeout. Commands are not shell-interpreted,
  // hence the explicit `sh -c`.
  await sandbox.commands.run("sh", {
    args: [
      "-c",
      `mkdir -p ${FIXTURE_ROOT} && cd ${FIXTURE_ROOT} && ` +
        `nohup python3 -m http.server ${FIXTURE_PORT} >/tmp/site.log 2>&1 &`,
    ],
  })
}

/**
 * The preview URL arrives with an access token in its query string, and the
 * gateway answers 401 without it — so keep the URL whole and build paths onto
 * it with `withPath`, never by concatenation.
 */
async function resolveUrl(sandbox: Sandbox): Promise<string> {
  const { url } = await sandbox.previewUrl(FIXTURE_PORT)
  return url
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(withPath(baseUrl, "/index.html"), {
      signal: AbortSignal.timeout(5_000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function waitForHealthy(baseUrl: string, log: (m: string) => void): Promise<void> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    if (await isHealthy(baseUrl)) return
    if (attempt % 5 === 0) log(`  waiting for the fixture server (${attempt}/20)`)
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error(`fixture server never became reachable at ${baseUrl}`)
}
