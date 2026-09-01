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
import { fixtureFiles } from "./site.js"

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
   */
  async snapshot(name: string): Promise<string> {
    return await this.sandbox.snapshot(name)
  }

  /** Boot a private copy of a previous snapshot. This is what replay runs against. */
  static async fork(
    client: SolariClient,
    snapshotId: string,
    log: (m: string) => void,
  ): Promise<FixtureHost> {
    const sandbox = await retryOnConcurrencyLimit("fork", () =>
      client.sandboxes.create({
        fromSnapshot: snapshotId,
        timeoutMs: BOOT_TIMEOUT_MS,
        metadata: { app: "splitflap", role: "fixture-fork" },
      }),
      { log },
    )
    log(`forked ${sandbox.sandboxId} from ${snapshotId}`)
    await sandbox.connect()

    const baseUrl = await resolveUrl(sandbox)

    // A RAM+disk snapshot should bring the HTTP server back with it. Verify
    // rather than assume — and if it did not, restart it so replay still works
    // (the run is still valid; only the "resumed" flag changes).
    let resumed = true
    if (!(await isHealthy(baseUrl))) {
      log("forked VM did not resume its server — restarting it")
      resumed = false
      await startServer(sandbox)
      await waitForHealthy(baseUrl, log)
    }
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
