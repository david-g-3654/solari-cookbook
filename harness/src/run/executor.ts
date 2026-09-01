/**
 * Step execution — the one place that touches a real page.
 *
 * Shared deliberately between the `scripted` adapter and the replayer: replay
 * re-running a trace through exactly the same code as the original run is what
 * makes a divergence meaningful. If replay had its own executor, a difference
 * could just be the two executors disagreeing.
 */
import type { Page } from "patchright-core"
import type { Step, TraceStep } from "../types.js"

const DEFAULT_TIMEOUT_MS = 15_000

/** Absolute URL for a fixture path, tolerating a trailing slash on the base. */
export function resolvePath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
}

function textOf(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

export class StepExecutor {
  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * Run one step, writing any extraction into `answer`.
   * Returns whatever was extracted (undefined for pure actions).
   */
  async run(step: Step, answer: Record<string, unknown>): Promise<unknown> {
    const page = this.page
    const t = this.timeoutMs

    switch (step.do) {
      case "goto": {
        await page.goto(resolvePath(this.baseUrl, step.path), {
          waitUntil: "domcontentloaded",
          timeout: t,
        })
        return undefined
      }

      case "click": {
        // A click may or may not navigate. Rather than guess, click and then
        // let the page settle — `domcontentloaded` resolves immediately when
        // no navigation happened, so this costs nothing in the common case.
        await page.locator(step.selector).first().click({ timeout: t })
        await page.waitForLoadState("domcontentloaded", { timeout: t }).catch(() => {})
        return undefined
      }

      case "fill": {
        await page.locator(step.selector).first().fill(step.value, { timeout: t })
        return undefined
      }

      case "selectOption": {
        await page.locator(step.selector).first().selectOption(step.value, { timeout: t })
        return undefined
      }

      case "waitFor": {
        await page.waitForSelector(step.selector, { timeout: step.timeoutMs ?? t })
        return undefined
      }

      case "extractText": {
        const value = textOf(await page.locator(step.selector).first().innerText({ timeout: t }))
        answer[step.as] = value
        return value
      }

      case "extractAll": {
        await page.waitForSelector(step.selector, { timeout: t })
        const values = (await page.locator(step.selector).allInnerTexts()).map(textOf)
        answer[step.as] = values
        return values
      }

      case "paginate": {
        const collected: string[] = []
        for (let pageNo = 1; pageNo <= step.maxPages; pageNo++) {
          await page.waitForSelector(step.itemSelector, { timeout: t })
          collected.push(
            ...(await page.locator(step.itemSelector).allInnerTexts()).map(textOf),
          )
          const next = page.locator(step.nextSelector).first()
          if ((await next.count()) === 0) break
          await next.click({ timeout: t })
          await page.waitForLoadState("domcontentloaded", { timeout: t }).catch(() => {})
        }
        answer[step.as] = collected
        return collected
      }
    }
  }

  /** Run a step and wrap the outcome as a trace entry, never throwing. */
  async trace(
    step: Step,
    index: number,
    answer: Record<string, unknown>,
  ): Promise<TraceStep> {
    const started = Date.now()
    try {
      const extracted = await this.run(step, answer)
      return {
        index,
        step,
        ...(extracted === undefined ? {} : { extracted }),
        url: this.page.url(),
        ok: true,
        durationMs: Date.now() - started,
      }
    } catch (err) {
      return {
        index,
        step,
        url: this.page.url(),
        ok: false,
        error: err instanceof Error ? err.message.split("\n")[0]! : String(err),
        durationMs: Date.now() - started,
      }
    }
  }
}

/** Collect the final page state the scorer needs. */
export async function captureFinalState(
  page: Page,
  selectorsToCheck: string[],
): Promise<{ url: string; text: string; visibleSelectors: Set<string> }> {
  const url = page.url()
  const text = await page
    .locator("body")
    .innerText({ timeout: 5_000 })
    .catch(() => "")
  const visible = new Set<string>()
  for (const sel of selectorsToCheck) {
    const ok = await page
      .locator(sel)
      .first()
      .isVisible({ timeout: 1_000 })
      .catch(() => false)
    if (ok) visible.add(sel)
  }
  return { url, text, visibleSelectors: visible }
}
