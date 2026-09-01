# splitflap

A browser-agent eval & replay harness on [Solari](https://getsolari.com).

Run a browser agent against a suite of golden tasks on N parallel cloud
browsers, inject failure modes on purpose, and get a pass/fail board — plus the
ability to **replay any run against a byte-identical copy of the world it
originally saw**.

```bash
cd harness
npm install
cp .env.example .env        # paste your key from console.getsolari.com
npm run splitflap -- run --faults latency,loginWall --parallel 5
```

```
snapshot snap_7f3a91c2 — runs from this suite are replayable

  PASS   smoke-read         2/2 assertions  6.1s
  PASS   catalog-browse     3/3 assertions  8.4s
  PASS   paginate-collect   3/3 assertions  12.4s
  PASS   login-flow         3/3 assertions  9.1s
  PASS   checkout-form      3/3 assertions  10.2s

5/5 tasks passed in 41.2s

dashboard: https://abc123.preview.getsolari.com/_dash/index.html
```

## Why this exists

Browser agents fail in ways that are miserable to debug, because a failed run
has three suspects and no way to tell them apart:

1. the **agent** did something dumb,
2. the **site** changed under you,
3. the **model** rolled a different sample.

Most harnesses can only report the failure. This one pins suspects 2 and 3 so
you can convict suspect 1.

## How it pins the world

| Source of nondeterminism | How it is pinned |
| --- | --- |
| The site's responses | Tasks run against a hermetic fixture site served from a Solari sandbox. Before the suite starts, the microVM is **snapshotted while it is still serving**. Replay **forks** that snapshot, so the replayed run gets the same bytes — not a re-fetch, a copy. |
| The agent's decisions | Replay re-executes the **recorded action trace** instead of asking the model again. Deterministic, and it costs no tokens. |
| Timing and failure modes | Faults are driven by a seeded PRNG and integer counters, never by wall-clock. Same seed → the same requests are delayed, 5xx'd and walled at the same points. |

When a replay diverges, the divergence is real. That is the difference between
a flake and a bug.

```bash
npm run splitflap -- replay suite-20260901T140000Z-paginate-collect
```

```
forked sbx_fork_a2 from snap_7f3a91c2
DETERMINISTIC — replay matched the original on every compared field
```

### What replay pins, precisely

Replay compares end status, every answer key, the navigation path sequence, the
injected-fault sequence, and per-step outcomes. It deliberately **ignores
timings** — a replay that took 200ms longer is not a different outcome, and
treating it as one would make the feature cry wolf.

Hosts are compared by path, not by origin, because a fork always gets a
different preview URL.

**The honest limit.** The `scripted` adapter records a complete, semantic
trace, so its runs replay end to end. The LLM adapters record what the agent
*reported* doing — prose, not selectors — so those runs replay the
harness-driven steps and diff observations only. Replay verifies the
environment, not the model.

## The five golden tasks

Run `npm run splitflap -- tasks` to list them.

| Task | What it exercises |
| --- | --- |
| `smoke-read` | Load a page, read text. The baseline that must always pass. |
| `catalog-browse` | Follow a link, extract a list. |
| `paginate-collect` | Traverse 3 pages, accumulate 24 items. Breaks under missing waits. |
| `login-flow` | Fill a form, submit, assert on the post-login page. |
| `checkout-form` | Multi-field form with a `<select>`, then a confirmation. |

They run against a **hermetic fixture site** — a small multi-page shop served
from inside a Solari sandbox, generated from fixed inputs with no clocks and no
randomness. That is a deliberate choice: if tasks pointed at real sites, a red
cell would mean "the agent regressed" *or* "someone else's site was down", and
you would learn to ignore the board. Here a red cell always means the agent.

## The failure modes

Injected per-run with `--faults`, via request interception on the browser
context (so they apply to pages the agent opens for itself, not just ours).

| Fault | What it does |
| --- | --- |
| `latency` | Adds 250ms + up to 150ms of seeded jitter to every request. Exposes missing waits. |
| `http5xx` | Returns one hard 503 on a page fetch. An agent that never retries fails. |
| `loginWall` | Serves a sign-in interstitial on the 2nd navigation, mid-run, where no task script expects it. Clearing it requires actually filling and submitting the form. |

The login wall is the interesting one. Every multi-navigation task ships with a
recovery script, so a well-behaved agent gets past it. Strip that to prove the
harness detects a real robustness regression rather than noise:

```bash
npm run splitflap -- run --faults loginWall --no-recovery
```

## Adapters

| Adapter | Needs | Notes |
| --- | --- | --- |
| `scripted` | nothing | Deterministic, no model. The control, and what CI runs. |
| `stagehand` | `npm i @browserbasehq/stagehand` + a model key | Attaches to the same session over CDP. |
| `browser-use` | `pip install browser-use` + a model key | Python; runs out-of-process over a stdin/stdout JSON bridge. |

All three attach to the **same** Solari session the harness prepared, so every
adapter meets the same injected faults, starts on the same page, and is scored
by the same assertions against the same end state. That is what makes the
dashboard's columns comparable.

Set the model with `SPLITFLAP_MODEL` (default `anthropic/claude-sonnet-4-5`;
`openai/…` also works).

## Commands

```
run [options]              run the golden tasks on parallel cloud browsers
  --tasks a,b              only these task ids (default: all 5)
  --adapter NAME           scripted | stagehand | browser-use
  --faults a,b             latency | http5xx | loginWall
  --parallel N             browsers in flight (default: 5)
  --seed N                 fault seed; same seed, same world (default: 1)
  --no-recovery            strip login-wall recovery (regression demo)
  --keep-alive MIN         keep the dashboard up this long (default: 10)

replay <runId> [--keep-fork]
serve [suiteId]            re-publish a stored suite's dashboard
tasks                      list the golden tasks
suites                     list stored suites
```

`run` exits non-zero if any task failed, so it drops into CI as-is.

`--parallel` is a request, not a requirement: every plan caps concurrent
sessions, and a suite that asks for more waits for a slot rather than losing
runs to 429s. If an interrupted suite leaves a sandbox holding one, `clean`
frees it.

## How it uses Solari

| Primitive | Used for |
| --- | --- |
| Cloud browsers | One session per run, N in flight. Independent, so a wedged run cannot corrupt its neighbours. |
| Session recording | `recording: true` per session; the rrweb NDJSON is downloaded after release and stored beside the run. |
| Sandbox | Hosts the fixture site, and later the dashboard. |
| **Snapshot / fork** | The replay mechanism. `snapshot()` checkpoints the VM while it keeps serving; `create({ fromSnapshot })` boots a private copy. |
| Preview URL | Serves the fixture to the cloud browsers, and the dashboard to you. |

## Gotchas encoded here

Things that cost an afternoon if you meet them cold — each is commented at the
site where it bites:

- `solari.close()` is **required** in Node, or the process hangs after printing.
- Recording is **per session**, and the upload is async *after* release. Poll.
- `browser.close()` releases the session — do it *before* polling for the replay.
- Sandbox commands are not shell-interpreted; background a server with `sh -c … &`.
- `kill()` destroys a VM; `close()` only drops your control channel.
- A forked VM *should* resume with its server running. `fork()` health-checks
  and restarts it if not, and the dashboard reports which happened.

## Status

**Verified live on Solari.** A full suite, a fork-and-replay, and the published
dashboard have all run against the real API:

```
5/5 tasks passed in 19.2s
DETERMINISTIC — replay matched the original on every compared field
```

- **Parallel cloud browsers** — 5 tasks, `--parallel 5`, on a free plan whose
  cap is 3 concurrent sessions. The suite self-throttled and all five passed.
- **Session recording** — rrweb NDJSON downloaded for every run (5–31 KB).
- **Snapshot / fork** — replay forked the fixture snapshot and the VM **resumed
  with its HTTP server still running**, no restart needed.
- **Replay determinism** — the login wall fired at the same navigation, was
  recovered from, and every compared field matched. As a negative control, a
  deliberately corrupted stored answer was correctly reported as a divergence
  on that field alone.
- **Dashboard** — HTTP 200 on its `*.preview.getsolari.com` URL, with the
  replay verdict and fork provenance rendered.

Plus, offline: `npm test` (18 unit tests) and `npm run test:integration`
(12 tests driving the real harness through a real browser).

**Not yet verified: the two LLM adapters**, which need a model key. Both are
written against the frameworks' real APIs, but neither has been run. The open
question there is whether context-level routes reach pages Stagehand and
Browser-Use open over CDP — faults are installed on the browser context
precisely so they should, and it holds for the `scripted` adapter, but it needs
confirming.

## What the live run taught us

Two bugs only a real run could surface, both now fixed and regression-tested:

**Preview URLs carry an access token in their query string.** Building a target
by concatenation (`base + "/catalog.html"`) puts the path *inside* the query,
leaving `pathname` as `/`. Solari's gateway is lenient enough to route it
anyway — so an entire suite passed while every `goto` was nominally pointed at
the site root. Paths are now set properly, with the token preserved.

**Replay cried wolf on its first run.** The token is per-sandbox, so a fork
always carries a different one, and comparing raw query strings reported a
divergence on every single replay. Normalisation now drops `pt_token` and keeps
everything else — `sf_auth=1` and submitted form fields are real signal.

## Tests

```bash
npm test              # 18 unit tests — no network, no browser
npm run test:integration   # 12 tests — real browser, real server, ~40s
npm run test:all
```

Integration tests drive `executeTask`, which is the same entry point the cloud
runner uses — so they test the code that ships rather than a reimplementation
of it.

## Layout

```
src/
  cli.ts              run | replay | serve | tasks | suites
  tasks/              the 5 golden tasks
  fixture/            the hermetic site, and the sandbox that serves it
  faults/             seeded fault interception
  adapters/           scripted, stagehand, browser-use (+ python bridge)
  run/                executor, task execution, parallel runner, scoring
  replay/             fork-and-diff
  report/             store + dashboard
```

MIT licensed, like the rest of the cookbook.
