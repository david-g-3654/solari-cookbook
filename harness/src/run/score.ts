/**
 * Turning a finished run into pass/fail.
 *
 * Scoring is deliberately adapter-blind: it sees where the browser ended up,
 * what text was on the final page, and whatever the agent claimed as its
 * answer. It never inspects the trace. A scripted baseline and an LLM agent
 * that reach the same end state score identically, which is the only way the
 * dashboard's columns are comparable.
 */
import type { Assertion, AssertionResult, RunStatus } from "../types.js"

/** Everything an assertion is allowed to look at. */
export interface FinalState {
  url: string
  /** `document.body.innerText` of the final page. */
  text: string
  answer: Record<string, unknown>
  /** Selectors found visible on the final page, for `selectorVisible`. */
  visibleSelectors: Set<string>
}

/** Flatten a value to the strings an assertion can match against. */
function asStrings(v: unknown): string[] {
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v.flatMap(asStrings)
  return [String(v)]
}

function shorten(s: string, n = 80): string {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`
}

export function evaluate(assertion: Assertion, state: FinalState): AssertionResult {
  switch (assertion.kind) {
    case "urlContains": {
      const ok = state.url.includes(assertion.value)
      return { assertion, ok, detail: ok ? `url ${state.url}` : `url was ${state.url}` }
    }
    case "textContains": {
      const ok = state.text.includes(assertion.value)
      return {
        assertion,
        ok,
        detail: ok ? `found "${assertion.value}"` : `page text lacks "${assertion.value}"`,
      }
    }
    case "selectorVisible": {
      const ok = state.visibleSelectors.has(assertion.selector)
      return {
        assertion,
        ok,
        detail: ok ? `${assertion.selector} visible` : `${assertion.selector} not visible`,
      }
    }
    case "answerEquals": {
      const got = state.answer[assertion.key]
      const ok = asStrings(got).length === 1 && String(got).trim() === assertion.value
      return { assertion, ok, detail: `${assertion.key} = ${shorten(String(got))}` }
    }
    case "answerContains": {
      const hay = asStrings(state.answer[assertion.key])
      const ok = hay.some((s) => s.includes(assertion.value))
      return {
        assertion,
        ok,
        detail: ok
          ? `${assertion.key} contains "${assertion.value}"`
          : `${assertion.key} (${hay.length} value(s)) lacks "${assertion.value}"`,
      }
    }
    case "answerCountAtLeast": {
      const n = asStrings(state.answer[assertion.key]).length
      const ok = n >= assertion.n
      return { assertion, ok, detail: `${assertion.key} has ${n}, need ≥ ${assertion.n}` }
    }
  }
}

export function scoreAll(assertions: Assertion[], state: FinalState): AssertionResult[] {
  return assertions.map((a) => evaluate(a, state))
}

/** A run passes only when every assertion passes. `error` beats `fail`. */
export function statusOf(results: AssertionResult[], errored: boolean): RunStatus {
  if (errored) return "error"
  return results.every((r) => r.ok) ? "pass" : "fail"
}

/** Human-readable one-liner for the CLI. */
export function summarize(results: AssertionResult[]): string {
  const passed = results.filter((r) => r.ok).length
  return `${passed}/${results.length} assertions`
}
