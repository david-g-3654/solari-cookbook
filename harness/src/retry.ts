/**
 * Retrying past the plan's concurrency cap.
 *
 * Every Solari plan caps concurrent sessions (3 on free), and browsers,
 * sandboxes and desktops all draw on it. A suite asking for more parallelism
 * than the cap allows is not an error — the slots free up as runs finish — so
 * the pool should wait for one rather than failing the task.
 *
 * This is what makes `--parallel` a request rather than a requirement: ask for
 * 8 on a 3-session plan and the suite self-throttles to 3 instead of losing
 * five runs to 429s.
 */
const INITIAL_DELAY_MS = 2_000
const MAX_DELAY_MS = 10_000

export function isConcurrencyLimit(err: unknown): boolean {
  const e = err as { code?: string; status?: number }
  return e?.code === "ConcurrencyLimitExceeded" || e?.status === 429
}

export async function retryOnConcurrencyLimit<T>(
  what: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; log?: (m: string) => void } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 3 * 60_000)
  let delay = INITIAL_DELAY_MS
  let announced = false

  for (;;) {
    try {
      return await fn()
    } catch (err) {
      if (!isConcurrencyLimit(err) || Date.now() + delay > deadline) throw err
      if (!announced) {
        opts.log?.(`${what}: at the plan's concurrency cap, waiting for a slot`)
        announced = true
      }
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 1.5, MAX_DELAY_MS)
    }
  }
}
