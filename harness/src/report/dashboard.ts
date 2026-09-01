/**
 * Dashboard generation.
 *
 * Emits one self-contained HTML file plus the raw suite JSON. Self-contained
 * matters: it is served from inside a sandbox whose egress you should not
 * assume anything about, so there are no CDN fonts, no external scripts, and
 * no fetches. Everything the page needs is in the page.
 *
 * The layout is a split-flap departure board, which is what a Solari board
 * actually is — one row per task, status in the left tile, detail underneath.
 */
import type { AssertionResult, RunResult, Suite, TraceStep } from "../types.js"
import type { ReplayResult } from "../types.js"

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  )

const CSS = `
:root {
  --bg:#0d0f12; --panel:#15181d; --line:#252a31; --fg:#e6e8ea; --mut:#8b929b;
  --pass:#3ddc84; --fail:#ff6b6b; --err:#ffb454; --amber:#f5c46b; --link:#7aa2f7;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing:border-box; }
html { color-scheme: dark; }
body { margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
       font:14px/1.55 var(--mono); }
.wrap { max-width:64rem; margin:0 auto; }
header { border-bottom:1px solid var(--line); padding-bottom:1rem; margin-bottom:1.5rem; }
h1 { font-size:1.05rem; letter-spacing:.14em; text-transform:uppercase;
     margin:0 0 .5rem; color:var(--amber); }
.meta { color:var(--mut); font-size:12px; display:flex; flex-wrap:wrap; gap:.35rem 1.25rem; }
.meta b { color:var(--fg); font-weight:500; }

.tiles { display:flex; gap:.6rem; margin:0 0 1.5rem; flex-wrap:wrap; }
.tile { background:var(--panel); border:1px solid var(--line); border-radius:8px;
        padding:.7rem 1rem; min-width:6.5rem; }
.tile .n { font-size:1.5rem; line-height:1.1; }
.tile .k { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--mut); }
.n.pass{color:var(--pass)} .n.fail{color:var(--fail)} .n.error{color:var(--err)}

details.row { background:var(--panel); border:1px solid var(--line); border-radius:8px;
              margin-bottom:.5rem; overflow:hidden; }
details.row[open] { border-color:#39404a; }
summary { display:flex; align-items:center; gap:.9rem; padding:.7rem .9rem;
          cursor:pointer; list-style:none; }
summary::-webkit-details-marker { display:none; }
summary:hover { background:#191d23; }
.flap { flex:0 0 auto; min-width:4.6rem; text-align:center; padding:.28rem .5rem;
        border-radius:4px; font-size:11px; letter-spacing:.14em; text-transform:uppercase;
        background:#000; border:1px solid var(--line); }
.flap.pass{color:var(--pass);border-color:#1e5c3a} .flap.fail{color:var(--fail);border-color:#6b2b2b}
.flap.error{color:var(--err);border-color:#6b512b}
.title { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.title small { color:var(--mut); }
.stat { flex:0 0 auto; color:var(--mut); font-size:12px; }
.body { padding:.2rem .9rem 1rem; border-top:1px solid var(--line); }
h3 { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--mut);
     margin:1.1rem 0 .4rem; }
table { width:100%; border-collapse:collapse; font-size:12.5px; }
td, th { text-align:left; padding:.28rem .5rem .28rem 0; vertical-align:top; }
th { color:var(--mut); font-weight:500; }
tr + tr td { border-top:1px solid #1d2128; }
.ok{color:var(--pass)} .no{color:var(--fail)}
.scroll { overflow-x:auto; }
code { background:#0a0c0f; padding:.08rem .3rem; border-radius:3px; color:var(--amber); }
.dim { color:var(--mut); }
.hint { color:var(--mut); font-size:12px; margin:.5rem 0 0; }
footer { margin-top:2.5rem; color:var(--mut); font-size:12px;
         border-top:1px solid var(--line); padding-top:1rem; }
`

function traceTable(trace: TraceStep[]): string {
  if (trace.length === 0) return `<p class="dim">no steps recorded</p>`
  const rows = trace
    .map((t) => {
      const label = describeStep(t)
      const extra =
        t.extracted === undefined
          ? ""
          : `<span class="dim"> → ${esc(preview(t.extracted))}</span>`
      return `<tr><td class="dim">${t.index}</td><td class="${t.ok ? "ok" : "no"}">${
        t.ok ? "ok" : "fail"
      }</td><td>${esc(label)}${extra}${
        t.error ? `<br><span class="no">${esc(t.error)}</span>` : ""
      }</td><td class="dim">${t.durationMs}ms</td></tr>`
    })
    .join("")
  return `<div class="scroll"><table><tr><th>#</th><th>result</th><th>step</th><th>took</th></tr>${rows}</table></div>`
}

function describeStep(t: TraceStep): string {
  const s = t.step
  switch (s.do) {
    case "goto": return `goto ${s.path}`
    case "click": return `click ${s.selector}`
    case "fill": return `fill ${s.selector} = "${s.value}"`
    case "selectOption": return `select ${s.selector} = "${s.value}"`
    case "waitFor":
      return s.selector.startsWith("agent:") ? s.selector.slice(6) : `waitFor ${s.selector}`
    case "extractText": return `extractText ${s.selector} → ${s.as}`
    case "extractAll": return `extractAll ${s.selector} → ${s.as}`
    case "paginate": return `paginate ${s.nextSelector} (≤${s.maxPages}) → ${s.as}`
  }
}

function preview(v: unknown): string {
  const s = Array.isArray(v) ? `[${v.length}] ${v.slice(0, 3).join(", ")}` : String(v)
  return s.length > 90 ? `${s.slice(0, 89)}…` : s
}

function assertionTable(results: AssertionResult[]): string {
  if (results.length === 0) return `<p class="dim">no assertions</p>`
  return `<div class="scroll"><table>${results
    .map(
      (r) =>
        `<tr><td class="${r.ok ? "ok" : "no"}">${r.ok ? "pass" : "fail"}</td>` +
        `<td><code>${esc(r.assertion.kind)}</code></td><td class="dim">${esc(r.detail)}</td></tr>`,
    )
    .join("")}</table></div>`
}

function replaySection(run: RunResult, replay?: ReplayResult): string {
  if (!replay) {
    return (
      `<h3>Replay</h3><p class="hint">Not replayed yet. Fork the fixture VM and ` +
      `re-run this trace against a byte-identical world:<br>` +
      `<code>npm run splitflap -- replay ${esc(run.runId)}</code></p>`
    )
  }
  const verdict = replay.deterministic
    ? `<span class="ok">deterministic</span> — replay matched the original on every compared field`
    : `<span class="no">diverged</span> on ${replay.diffs.length} field(s)`
  const diffs = replay.deterministic
    ? ""
    : `<div class="scroll"><table><tr><th>field</th><th>original</th><th>replay</th></tr>${replay.diffs
        .map(
          (d) =>
            `<tr><td><code>${esc(d.field)}</code></td><td class="dim">${esc(
              preview(d.original),
            )}</td><td class="dim">${esc(preview(d.replayed))}</td></tr>`,
        )
        .join("")}</table></div>`
  return `<h3>Replay</h3><p>${verdict}</p>
<p class="hint">forked <code>${esc(replay.forkedSandboxId)}</code> from
<code>${esc(replay.fromSnapshotId)}</code> ·
server ${replay.serverResumedFromSnapshot ? "resumed with the snapshot" : "restarted after fork"}
· ${replay.durationMs}ms</p>${diffs}`
}

function runRow(run: RunResult, replay?: ReplayResult): string {
  const passed = run.assertions.filter((a) => a.ok).length
  const faults = run.faults.map((f) => f.kind).join(", ") || "none"
  const answer = Object.entries(run.answer)
    .map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td class="dim">${esc(preview(v))}</td></tr>`)
    .join("")
  const faultEvents = run.observation.faultEvents
    .map((e) => `<tr><td><code>${esc(e.kind)}</code></td><td class="dim">${esc(e.detail)}</td></tr>`)
    .join("")

  return `<details class="row">
<summary>
  <span class="flap ${run.status}">${run.status}</span>
  <span class="title">${esc(run.taskId)} <small>· ${esc(run.runId)}</small></span>
  <span class="stat">${passed}/${run.assertions.length} · ${(run.durationMs / 1000).toFixed(1)}s</span>
</summary>
<div class="body">
  <h3>Run</h3>
  <table>
    <tr><td>adapter</td><td class="dim">${esc(run.adapter)}</td></tr>
    <tr><td>seed</td><td class="dim">${run.seed}</td></tr>
    <tr><td>faults</td><td class="dim">${esc(faults)}</td></tr>
    <tr><td>recovery</td><td class="dim">${
      run.recoveryEnabled ? "enabled" : "stripped (--no-recovery)"
    }</td></tr>
    <tr><td>session</td><td class="dim">${esc(run.sessionId ?? "—")}</td></tr>
    <tr><td>recording</td><td class="dim">${
      run.replayBytes ? `${run.replayBytes} bytes of rrweb NDJSON` : "not uploaded"
    }</td></tr>
    ${run.error ? `<tr><td>error</td><td class="no">${esc(run.error)}</td></tr>` : ""}
  </table>
  <h3>Assertions</h3>${assertionTable(run.assertions)}
  ${answer ? `<h3>Answer</h3><table>${answer}</table>` : ""}
  ${faultEvents ? `<h3>Injected faults</h3><table>${faultEvents}</table>` : ""}
  <h3>Trace</h3>${traceTable(run.trace)}
  ${replaySection(run, replay)}
</div>
</details>`
}

export function renderDashboard(
  suite: Suite,
  replays: Record<string, ReplayResult> = {},
): Record<string, string> {
  const count = (s: string) => suite.runs.filter((r) => r.status === s).length
  const faults = suite.runs[0]?.faults.map((f) => f.kind).join(", ") || "none"

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>splitflap — ${esc(suite.suiteId)}</title>
<style>${CSS}</style></head>
<body><div class="wrap">
<header>
  <h1>splitflap · browser-agent eval</h1>
  <div class="meta">
    <span><b>${esc(suite.suiteId)}</b></span>
    <span>adapter <b>${esc(suite.adapter)}</b></span>
    <span>seed <b>${suite.seed}</b></span>
    <span>parallel <b>${suite.parallel}</b></span>
    <span>faults <b>${esc(faults)}</b></span>
    <span>took <b>${(suite.durationMs / 1000).toFixed(1)}s</b></span>
    <span>${esc(suite.startedAt)}</span>
  </div>
</header>

<div class="tiles">
  <div class="tile"><div class="n pass">${count("pass")}</div><div class="k">passed</div></div>
  <div class="tile"><div class="n fail">${count("fail")}</div><div class="k">failed</div></div>
  <div class="tile"><div class="n error">${count("error")}</div><div class="k">errored</div></div>
  <div class="tile"><div class="n">${suite.runs.length}</div><div class="k">tasks</div></div>
</div>

${suite.runs.map((r) => runRow(r, replays[r.runId])).join("\n")}

<footer>
  Fixture served from <code>${esc(suite.baseUrl)}</code>${
    suite.fixtureSnapshotId
      ? ` · snapshot <code>${esc(suite.fixtureSnapshotId)}</code>`
      : " · no snapshot (runs are not replayable)"
  }<br>
  Every run above met the same hermetic site and the same seeded faults.
  Replay forks the snapshot, so a divergence is the agent — not the web.
</footer>
</div></body></html>`

  return { "index.html": html, "suite.json": JSON.stringify(suite, null, 2) }
}
