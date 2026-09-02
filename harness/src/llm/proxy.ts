/**
 * A recording proxy for OpenAI-compatible chat completions.
 *
 * Every agent framework worth wrapping already accepts a base URL, so rather
 * than hooking each one's internals this sits in front of the model endpoint
 * and records the traffic. Browser-Use, Stagehand and anything added later all
 * work through the same implementation, and what gets recorded is the exact
 * bytes rather than some framework's idea of them.
 *
 * One server fronts every run in a suite; requests are routed by a run id in
 * the path, so eight parallel runs keep eight separate cassettes without
 * eight servers.
 *
 * It binds to 127.0.0.1 and holds the upstream key in memory: the key is never
 * written to a cassette, and nothing off-machine can reach the listener.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import {
  CassetteReader, canonicalise, firstDifference, requestKey, saveCassette, summarise,
  type Cassette, type CassetteEntry,
} from "./cassette.js"

export type ProxyMode = "record" | "replay"

/** What to do when a replay asks something that was never recorded. */
export type MissPolicy = "live" | "error"

export interface RunBinding {
  runId: string
  mode: ProxyMode
  model: string
  reader?: CassetteReader
  missPolicy: MissPolicy
  entries: CassetteEntry[]
  stats: { hits: number; misses: number; live: number }
}

export interface ProxyOptions {
  /** Upstream OpenAI-compatible base, e.g. https://openrouter.ai/api/v1 */
  upstreamBaseUrl: string
  apiKey: string
  log?: (msg: string) => void
}

export class LlmProxy {
  private readonly bindings = new Map<string, RunBinding>()

  private constructor(
    private readonly server: Server,
    readonly port: number,
    private readonly opts: ProxyOptions,
  ) {}

  static async start(opts: ProxyOptions): Promise<LlmProxy> {
    let proxy: LlmProxy
    const server = createServer((req, res) => {
      proxy.handle(req, res).catch((err: Error) => {
        respond(res, 502, { error: { message: `splitflap proxy: ${err.message}` } })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    proxy = new LlmProxy(server, (server.address() as AddressInfo).port, opts)
    return proxy
  }

  /** Base URL an adapter should be pointed at for this run. */
  baseUrlFor(runId: string): string {
    return `http://127.0.0.1:${this.port}/${encodeURIComponent(runId)}/v1`
  }

  bind(binding: Omit<RunBinding, "entries" | "stats">): void {
    this.bindings.set(binding.runId, { ...binding, entries: [], stats: { hits: 0, misses: 0, live: 0 } })
  }

  cassetteFor(runId: string): Cassette | undefined {
    const b = this.bindings.get(runId)
    if (!b) return undefined
    return { runId, model: b.model, entries: b.entries }
  }

  statsFor(runId: string): RunBinding["stats"] | undefined {
    return this.bindings.get(runId)?.stats
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [, runId, ...rest] = (req.url ?? "").split("?")[0]!.split("/")
    const binding = runId ? this.bindings.get(decodeURIComponent(runId)) : undefined
    if (!binding) {
      respond(res, 404, { error: { message: "unknown run — is the proxy bound?" } })
      return
    }
    // The upstream base already ends in /v1, and OpenAI clients append their
    // own — so the version segment has to be dropped here or the request goes
    // to /v1/v1/chat/completions and 404s.
    const segments = rest[0] === "v1" ? rest.slice(1) : rest
    const path = `/${segments.join("/")}`
    const body = await readBody(req)

    // Anything that is not a completion (model listings, health checks) is a
    // straight pass-through: there is nothing meaningful to record.
    if (!path.endsWith("/chat/completions") || req.method !== "POST") {
      const upstream = await this.forward(path, body, req.method ?? "GET")
      respond(res, upstream.status, upstream.json)
      return
    }

    const parsed = JSON.parse(body || "{}") as Record<string, unknown>
    // Streaming would have to be recorded frame by frame; the agent
    // frameworks here do not need it, so refuse rather than silently
    // recording something that cannot be replayed.
    if (parsed.stream === true) parsed.stream = false

    const canonical = canonicalise(parsed)
    const key = requestKey(parsed)

    if (binding.mode === "replay" && binding.reader) {
      const recorded = binding.reader.take(key)
      if (recorded !== undefined) {
        binding.stats.hits++
        respond(res, 200, recorded)
        return
      }
      binding.stats.misses++
      // Show WHAT differed. A miss usually means either the agent genuinely
      // took a different path, or something volatile is leaking into the
      // prompt and needs canonicalising — and only the diff tells you which.
      const expected = binding.reader.at(binding.stats.hits + binding.stats.misses - 1)
      this.opts.log?.(
        `[${binding.runId}] LLM cache miss (${binding.stats.misses}) — the agent asked ` +
          `something it did not ask when recording` +
          (expected?.request ? `\n  ${firstDifference(expected.request, canonical)}` : ""),
      )
      if (binding.missPolicy === "error") {
        respond(res, 409, {
          error: { message: "splitflap: request not in cassette (--on-cache-miss error)" },
        })
        return
      }
    }

    const upstream = await this.forward(path, JSON.stringify(parsed), "POST")
    if (upstream.status !== 200) {
      // Only 200s are recorded, so a failing upstream call would otherwise
      // vanish: the cassette just ends and the agent dies with no explanation.
      this.opts.log?.(
        `[${binding.runId}] upstream ${upstream.status}: ` +
          `${JSON.stringify(upstream.json).slice(0, 200)}`,
      )
    }
    if (upstream.status === 200) {
      binding.stats.live++
      binding.entries.push({
        index: binding.entries.length,
        key,
        model: String(parsed.model ?? binding.model),
        summary: summarise(parsed),
        request: canonical,
        response: upstream.json,
      })
    }
    respond(res, upstream.status, upstream.json)
  }

  private async forward(
    path: string,
    body: string,
    method: string,
  ): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${this.opts.upstreamBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
        "x-title": "splitflap",
      },
      ...(method === "POST" ? { body } : {}),
    })
    const text = await res.text()
    try {
      return { status: res.status, json: JSON.parse(text) }
    } catch {
      return { status: res.status, json: { error: { message: text.slice(0, 400) } } }
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (c: Buffer) => { data += c.toString() })
    req.on("end", () => resolve(data))
    req.on("error", reject)
  })
}

function respond(res: ServerResponse, status: number, json: unknown): void {
  const payload = JSON.stringify(json)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
  res.end(payload)
}

export { saveCassette }
