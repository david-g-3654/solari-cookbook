/**
 * Cassettes: the recorded LLM side of a run.
 *
 * Stage 1 pinned the world (fork the fixture VM) but not the model, so a
 * replayed LLM run verified the environment and nothing else. A cassette pins
 * the other half: every chat completion the agent asked for, keyed by the
 * content of the request, so a replay can answer from the recording instead of
 * resampling.
 *
 * With both pinned you can unpin exactly one thing on purpose, which is the
 * whole point:
 *   same world + same responses   → any divergence is your agent code
 *   same world + fresh responses  → measures the model's own nondeterminism
 *   same world + a different model → a controlled A/B
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stateDir } from "../config.js"

export interface CassetteEntry {
  /** Order the call was made in. Diagnostic only — lookup is by key. */
  index: number
  /** Hash of the canonicalised request body. */
  key: string
  model: string
  /** Tail of the last user message, so a cassette is readable by a human. */
  summary: string
  /**
   * The canonicalised request. Stored so that a replay MISS can show what
   * actually differed instead of only asserting that something did — the
   * difference between "the agent diverged" and a usable bug report.
   */
  request: string
  /** The upstream response body, verbatim. This is what replay returns. */
  response: unknown
}

export interface Cassette {
  runId: string
  model: string
  entries: CassetteEntry[]
}

/**
 * Volatile substrings that differ between a run and its replay purely by
 * construction, and would otherwise make every cache key miss.
 *
 * A fork gets its own preview subdomain and its own access token, and both end
 * up inside the prompt — the agent is looking at a page whose URL contains
 * them. Exactly the normalisation the replay differ needs, for the same
 * reason.
 *
 * Wall-clock is the other one, and it is not obvious until it bites: agent
 * frameworks stamp the current time into their system prompt (Browser-Use
 * writes "current date/time is 2026-09-02 01:56 UTC"), so two runs two minutes
 * apart ask literally different questions and every single lookup misses.
 *
 * The trade-off is deliberate: a prompt that differs only by what o'clock it is
 * is not a different question. The cost is that a task genuinely about dates
 * would have real differences normalised away too — which is why the
 * substitutions are named in the canonical text rather than deleted, so a
 * `firstDifference` report still shows where they landed.
 */
const VOLATILE: Array<[RegExp, string]> = [
  [/https?:\/\/[a-z0-9]+-\d+\.preview\.getsolari\.com/gi, "https://FIXTURE"],
  [/pt_token=[A-Za-z0-9._~-]+/g, "pt_token=TOKEN"],
  // Date-times first, so the bare-date rule cannot eat half of one.
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?\s?(?:UTC|GMT|Z)?/g, "<TIMESTAMP>"],
  [/\d{4}-\d{2}-\d{2}/g, "<DATE>"],
  // Framework-specific session identifiers. Browser-Use labels tabs with a
  // random 4-hex id per session and puts them in the prompt ("Current tab:
  // EC98", "Tab EC98: https://…"), so the same page reads differently every
  // run. Anchored to the surrounding wording rather than matching bare hex,
  // which would eat real page content. Expect this list to grow as adapters
  // are added — each entry should name what it is and why it cannot matter.
  [/Current tab: [0-9A-F]{4}\b/g, "Current tab: <TAB>"],
  // No \b before "Tab": the prompt is matched inside its JSON encoding, where
  // a preceding newline is the two characters \ and n — and "n" is a word
  // character, so a word boundary never matches there.
  [/Tab [0-9A-F]{4}:/g, "Tab <TAB>:"],
]

export function canonicalise(body: unknown): string {
  let json = stableStringify(body)
  for (const [pattern, replacement] of VOLATILE) json = json.replace(pattern, replacement)
  return json
}

/** Key order must not affect the hash — JSON.stringify does not guarantee it. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const obj = value as Record<string, unknown>
  const parts = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
  return `{${parts.join(",")}}`
}

export function requestKey(body: unknown): string {
  return createHash("sha256").update(canonicalise(body)).digest("hex").slice(0, 32)
}

/**
 * Where two canonicalised requests first diverge, with surrounding context.
 * Answers "what did the agent see differently?" in one line.
 */
export function firstDifference(a: string, b: string, window = 90): string {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (i === a.length && i === b.length) return "(identical)"
  const from = Math.max(0, i - 30)
  const show = (s: string) => s.slice(from, i + window).replace(/\s+/g, " ")
  return `at char ${i}:\n    recorded: …${show(a)}…\n    replay:   …${show(b)}…`
}

/** A short, human-readable trace of what was asked. */
export function summarise(body: unknown): string {
  const messages = (body as { messages?: Array<{ role: string; content: unknown }> })?.messages
  const last = messages?.[messages.length - 1]
  const text =
    typeof last?.content === "string"
      ? last.content
      : Array.isArray(last?.content)
        ? last.content
            .map((c) => (c as { text?: string }).text ?? "")
            .join(" ")
        : ""
  const flat = text.replace(/\s+/g, " ").trim()
  return `${last?.role ?? "?"}: ${flat.slice(0, 120)}`
}

// ------------------------------------------------------------------ storage

const dir = () => join(stateDir(), "cassettes")

export function saveCassette(c: Cassette): string {
  mkdirSync(dir(), { recursive: true })
  const path = join(dir(), `${c.runId}.json`)
  writeFileSync(path, JSON.stringify(c, null, 2))
  return path
}

export function loadCassette(runId: string): Cassette | undefined {
  const path = join(dir(), `${runId}.json`)
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, "utf8")) as Cassette
}

/** Index a cassette for lookup. Repeated identical requests replay in order. */
export class CassetteReader {
  private readonly byKey = new Map<string, CassetteEntry[]>()
  private readonly consumed = new Map<string, number>()

  constructor(readonly cassette: Cassette) {
    for (const entry of cassette.entries) {
      const list = this.byKey.get(entry.key) ?? []
      list.push(entry)
      this.byKey.set(entry.key, list)
    }
  }

  /** Recorded call at this position, for explaining a miss. */
  at(index: number): CassetteEntry | undefined {
    return this.cassette.entries[index]
  }

  /**
   * Take the next recorded response for this request, or undefined on a miss.
   * An agent that asks the same question twice gets the two answers it
   * originally got, in order.
   */
  take(key: string): unknown | undefined {
    const list = this.byKey.get(key)
    if (!list) return undefined
    const used = this.consumed.get(key) ?? 0
    const entry = list[used] ?? list[list.length - 1]
    this.consumed.set(key, used + 1)
    return entry?.response
  }
}
