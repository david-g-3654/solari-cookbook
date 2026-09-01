/**
 * Browser-Use adapter (optional — `pip install browser-use`).
 *
 * Browser-Use is Python, so this spawns `browser_use_bridge.py` and hands it
 * the run's CDP endpoint. The agent then drives the same Solari session the
 * harness prepared, which is what puts it under the same injected faults as
 * every other adapter.
 *
 * Like Stagehand, its trace is a record of what the agent reported doing
 * rather than a replayable selector script — see README, "What replay pins".
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import type { Adapter, AdapterRunContext } from "./types.js"
import type { TraceStep } from "../types.js"

const SENTINEL = "__SPLITFLAP__"
const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "browser_use_bridge.py")
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5"

interface BridgeResponse {
  ok: boolean
  answer?: Record<string, unknown>
  steps?: string[]
  raw?: string
  error?: string
}

export const browserUseAdapter: Adapter = {
  name: "browser-use",
  requiresModel: true,

  async run(ctx: AdapterRunContext): Promise<Record<string, unknown>> {
    const model = process.env.SPLITFLAP_MODEL ?? DEFAULT_MODEL
    requireModelKey(model)

    // Same starting page as every other adapter, so the comparison is fair.
    ctx.emit(await ctx.executor.trace({ do: "goto", path: ctx.task.path }, 0, {}))

    const started = Date.now()
    const res = await runBridge({
      cdpUrl: ctx.cdpEndpoint,
      goal: ctx.task.goal,
      extract: ctx.task.extract ?? null,
      model,
      maxSteps: 25,
    }, ctx.log)

    if (!res.ok) throw new Error(res.error ?? "browser-use bridge failed")

    for (const [i, name] of (res.steps ?? []).entries()) {
      ctx.emit(agentTrace(i + 1, `act: ${name}`, ctx.page.url(), 0))
    }
    ctx.emit(
      agentTrace(
        (res.steps?.length ?? 0) + 1,
        "final answer",
        ctx.page.url(),
        Date.now() - started,
        res.raw,
      ),
    )

    return res.answer ?? {}
  },
}

function requireModelKey(model: string): void {
  const provider = model.split("/")[0]
  const envVar = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"
  if (!process.env[envVar]) {
    throw new Error(`the browser-use adapter needs a model key: set ${envVar}`)
  }
}

function runBridge(
  request: unknown,
  log: (m: string) => void,
): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const python = process.env.SPLITFLAP_PYTHON ?? "python3"
    const child = spawn(python, [BRIDGE], { stdio: ["pipe", "pipe", "pipe"] })

    let out = ""
    let err = ""
    child.stdout.on("data", (b: Buffer) => {
      const chunk = b.toString()
      out += chunk
      // Surface the agent's own progress lines; they are the only visibility
      // into a run that can take a minute.
      for (const line of chunk.split("\n")) {
        if (line.trim() && !line.startsWith(SENTINEL)) log(`  browser-use | ${line.trim()}`)
      }
    })
    child.stderr.on("data", (b: Buffer) => { err += b.toString() })

    child.on("error", (e) =>
      reject(new Error(`could not start ${python} for the browser-use bridge: ${e.message}`)),
    )

    child.on("close", () => {
      const line = out.split("\n").reverse().find((l) => l.startsWith(SENTINEL))
      if (!line) {
        reject(
          new Error(
            `browser-use bridge produced no result${err ? `: ${err.trim().split("\n").pop()}` : ""}`,
          ),
        )
        return
      }
      try {
        resolve(JSON.parse(line.slice(SENTINEL.length)) as BridgeResponse)
      } catch (e) {
        reject(new Error(`unparseable bridge response: ${(e as Error).message}`))
      }
    })

    child.stdin.write(JSON.stringify(request))
    child.stdin.end()
  })
}

function agentTrace(
  index: number,
  note: string,
  url: string,
  durationMs: number,
  extracted?: unknown,
): TraceStep {
  return {
    index,
    step: { do: "waitFor", selector: `agent:${note}` },
    ...(extracted === undefined ? {} : { extracted }),
    url,
    ok: true,
    durationMs,
  }
}
