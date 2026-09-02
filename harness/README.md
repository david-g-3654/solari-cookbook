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
| The agent's decisions | A **cassette** records every model call. Replay re-runs the real agent with its recorded answers served back — deterministic, and it costs no tokens. Scripted runs re-execute their recorded action trace instead. |
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

### Two replay modes

| Mode | When | What it proves |
| --- | --- | --- |
| `trace` | no cassette (the `scripted` adapter) | the recorded selector script reproduces |
| `agent` | a cassette exists | the **real agent**, re-run with its recorded answers, reaches the same place |

A cache **miss** is itself a finding: the agent asked something it did not ask
when recording, so it took a different path. That counts as a divergence even
if it happened to land in the same place. `--on-cache-miss error` refuses to
resample at all, for a hard determinism gate; the default falls through to a
live call so the replay finishes and reports how far it drifted.

### Single-variable experiments

This is what the two halves are for. Pin both, then unpin exactly one:

| Pinned | Unpinned | What a divergence means |
| --- | --- | --- |
| world + responses | — | your agent code changed |
| world | responses (new cassette) | the model's own nondeterminism |
| world | the model (`SPLITFLAP_MODEL=…`) | a controlled A/B between models |

### What gets normalised, and why

A cache key is a hash of the request, so anything volatile in the prompt would
miss on every lookup. Normalised away: the fork's preview host and access
token, wall-clock (Browser-Use writes `current date/time is 2026-09-02 01:56
UTC` into its system prompt — two runs minutes apart otherwise ask literally
different questions), and per-session tab ids.

The trade-off is deliberate: a prompt differing only by what o'clock it is is
not a different question. The cost is that a task genuinely about dates would
have real differences normalised too. Substitutions are *named* in the
canonical text (`<TIMESTAMP>`, `<TAB>`) rather than deleted, so a miss report
still shows where they landed — and a miss prints the first differing region
of the prompt, which is how each of these was found in the first place.

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

## Repetition, and what it separates

A single run of a stochastic agent tells you almost nothing. `paginate-collect`
returned 16 of 24 SKUs once — that could be a 0% pass rate or a 60% one, and
those call for very different responses.

```bash
npm run splitflap -- run --repeat 5 --faults latency
```

```
  PASS   catalog-browse       3/3 passed  27.1s median
  FLAKY  paginate-collect     2/5 passed  41.0s median  · answerCountAtLeast failed 3×
```

Every attempt at a task shares that task's seed, so the world and the injected
faults are byte-identical across attempts. The spread you measure is the
agent's own nondeterminism, not the web's — which is exactly the distinction
`--repeat` exists to draw. Three outcomes, and the middle one is invisible at
N=1:

- **stable-pass** — passed every attempt
- **flaky** — passed some. The rate is the finding, and the report names which
  assertion was unreliable and how often
- **stable-fail** — a consistent bug, not noise

It also counts **false successes**: runs that produced an answer while failing
their checks. An agent that fails loudly is manageable; one that reports an
order reference for an order it never placed is not, and the two should never
share a cell on a dashboard.

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
| `browser-use` | `pip install browser-use` (Python 3.11+) + a model key | Runs out-of-process over a stdin/stdout JSON bridge. **Verified live.** |
| `stagehand` | `npm i @browserbasehq/stagehand` (Node ≥22.18) + a model key | **4.x cannot attach to a Solari browser** — see Status. |

Set the model with `SPLITFLAP_MODEL` as `provider/model`:

```bash
SPLITFLAP_MODEL=openrouter/anthropic/claude-sonnet-4.5   # OPENROUTER_API_KEY
SPLITFLAP_MODEL=anthropic/claude-sonnet-4-5              # ANTHROPIC_API_KEY
SPLITFLAP_MODEL=openai/gpt-4.1-mini                      # OPENAI_API_KEY
```

OpenRouter gets special handling because it is one key for every model, which
is how people usually have access to several. Browser-Use takes it directly —
it is the OpenAI wire format with a different base URL. Stagehand does not:
its model config names only openai, anthropic, google, groq and cerebras, with
no base-URL override. So `openrouter/…` is routed through Stagehand's
`ClientLLM` escape hatch instead — see
[`openrouter-llm.ts`](src/adapters/openrouter-llm.ts), which maps its message,
tool-call and JSON-schema contract onto OpenRouter's chat completions.

All three attach to the **same** Solari session the harness prepared, so every
adapter meets the same injected faults, starts on the same page, and is scored
by the same assertions against the same end state. That is what makes the
dashboard's columns comparable.

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

replay <runId> [--keep-fork] [--on-cache-miss live|error]
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
- **Snapshot / fork** — replay forks the fixture snapshot. The VM sometimes
  resumes with its HTTP server still running and sometimes does not; the same
  snapshot has forked both ways. The harness health-checks, restarts the server
  when needed, and reports which happened rather than implying a guarantee.
- **Replay determinism** — the login wall fired at the same navigation, was
  recovered from, and every compared field matched. As a negative control, a
  deliberately corrupted stored answer was correctly reported as a divergence
  on that field alone.
- **Dashboard** — HTTP 200 on its `*.preview.getsolari.com` URL, with the
  replay verdict and fork provenance rendered.

**Stage 2 verified live too** — a Browser-Use run recorded a cassette, and
replaying it re-ran the agent to an identical outcome:

```
replaying in agent mode (2 recorded calls)
model: 2 answered from the cassette, 0 miss(es)
DETERMINISTIC — replay matched the original on every compared field,
               with the agent re-run against its recorded responses
```

Zero live calls: an LLM agent run reproduced exactly, for no tokens.

Plus, offline: `npm test` (57 unit tests) and `npm run test:integration`
(12 tests driving the real harness through a real browser).

**Browser-Use verified live**, through OpenRouter, against a real cloud
browser — the full 5-task suite, plus a targeted run that settled the open
question about fault routing:

> `loginWall — served wall on navigation #2` at `/catalog.html`

That navigation was performed by **Browser-Use**, not by the harness. So
context-level interception does reach pages an agent drives over CDP, which is
what makes the comparison between adapters fair. The agent's own recorded
reaction is the interesting part:

```
0 goto /index.html      (harness)
1 act: click            → hit the injected wall
2 act: go_back
3 act: click            → through
4 act: done             → all 8 items, 3/3 assertions
```

No recovery script was involved. It improvised, and the harness caught it.

**Stagehand 4.x cannot drive a Solari cloud browser.** Not a bug on either
side — an architectural mismatch, found by running it:

> This Chrome build does not support `Extensions.loadUnpacked`.
> Launch with `--load-extension` and connect using `extensionId` instead.

Stagehand 4 drives the page through a Chrome extension it loads over CDP.
Solari's browser build does not support that command, and the extension has to
be present at launch — a launch that belongs to Solari. The adapter now fails
with that explanation rather than the raw CDP error, and honours
`SPLITFLAP_STAGEHAND_EXTENSION_ID` if an image ever ships the extension.

Stagehand **3.x** drives Playwright over plain CDP with no extension, so
pinning to 3.x would work. Its API differs enough (`new Stagehand({ env,
localBrowserLaunchOptions: { cdpUrl } })`, `init()`, `stagehand.page.act()`,
and an `llmClient` for the model) that the adapter would need rewriting.

## What the eval actually caught

The full golden suite through Browser-Use (`openrouter/anthropic/claude-sonnet-4.5`,
`--faults latency,loginWall`) scored **3/5**, against 5/5 for the scripted
baseline under the same faults. Both failures are real agent behaviour, and
they fail in different ways:

**`paginate-collect` — 16 of 24 SKUs.** The agent walked two of the three
catalog pages and stopped. `#last-page` was never reached. The scripted control
collects all 24 under identical faults, so the task is passable; the agent just
gave up early on a long traversal.

**`checkout-form` — an order reference for an order that was never placed.**
This is the one worth the whole exercise. The agent filled the form and
submitted, the injected login wall intercepted that navigation, and the agent
never noticed it had been bounced to a sign-in page. It reported
`ref: "6724099"` — a confabulated reference. Reproduced twice.

Note what the assertions did here. `urlContains "checkout-done"` **passed**,
because the wall is served *in place of* that URL — same address, different
body. Only `selectorVisible #order-confirmed` and the reference check caught
it. An eval resting on the URL alone would have scored this a pass and told you
your agent could check out.

## What the live runs taught us

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
npm test              # 57 unit tests — no network, no browser
npm run test:integration   # 12 tests — real browser, real server, ~40s
npm run test:all
```

Integration tests drive `executeTask`, which is the same entry point the cloud
runner uses — so they test the code that ships rather than a reimplementation
of it.

## Layout

```
src/
  cli.ts              run | replay | serve | clean | tasks | suites
  config.ts           env loading, paths, fixture port
  url.ts              building paths onto a token-carrying preview URL
  llm/
    proxy.ts          recording proxy in front of the model endpoint
    cassette.ts       cassette storage, key canonicalisation, miss diffs
  retry.ts            waiting out the plan's concurrency cap
  tasks/              the 5 golden tasks
  fixture/            the hermetic site, and the sandbox that serves it
  faults/             seeded fault interception
  adapters/
    scripted.ts       the deterministic control
    browser-use.ts    + browser_use_bridge.py (out-of-process, Python)
    stagehand.ts      + openrouter-llm.ts (its ClientLLM bridge)
    model.ts          provider/model resolution, incl. OpenRouter
  run/
    execute-task.ts   drive one task in a browser context (Solari-agnostic)
    executor.ts       step execution
    recovery.ts       interstitial recovery, shared by run and replay
    runner.ts         N parallel Solari sessions
    score.ts          assertions -> pass/fail
  replay/             fork-and-diff
  report/
    aggregate.ts      repeat-N pass rates and stability
    store.ts, dashboard.ts
```

MIT licensed, like the rest of the cookbook.
