/**
 * The recording proxy and its cache keying, against a fake upstream.
 *
 * This is the half of determinism Stage 1 was missing, so the properties that
 * matter are: a replay never reaches upstream, a fork's different host and
 * token do not cause a miss, and a genuinely different question does.
 */
import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { LlmProxy } from "../src/llm/proxy.js"
import { CassetteReader, canonicalise, requestKey, summarise } from "../src/llm/cassette.js"

// ------------------------------------------------------------ fake upstream

let upstream: Server
let upstreamUrl: string
let upstreamCalls = 0
let upstreamPaths: string[] = []

function completion(text: string) {
  return { choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { total_tokens: 7 } }
}

before(async () => {
  upstream = createServer((req, res) => {
    upstreamCalls++
    upstreamPaths.push(req.url ?? "")
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(completion(`reply #${upstreamCalls}`)))
    })
  })
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`
})

after(async () => { await new Promise((r) => upstream.close(r)) })

const ask = (base: string, content: string) =>
  fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content }] }),
  }).then((r) => r.json() as Promise<{ choices?: Array<{ message?: { content?: string } }>; error?: unknown }>)

// -------------------------------------------------------------- key hygiene

describe("cache keying", () => {
  test("key order does not change the key", () => {
    const a = { model: "m", messages: [{ role: "user", content: "hi" }] }
    const b = { messages: [{ role: "user", content: "hi" }], model: "m" }
    assert.equal(requestKey(a), requestKey(b))
  })

  test("a fork's preview host and token do not change the key", () => {
    // The agent is looking at a page whose URL is in the prompt. A fork gets
    // its own subdomain and token, and neither is a different question.
    const original = { messages: [{ role: "user", content: "page https://aaa111-3000.preview.getsolari.com/catalog.html?pt_token=AAA.BBB" }] }
    const forked = { messages: [{ role: "user", content: "page https://zzz999-3000.preview.getsolari.com/catalog.html?pt_token=ZZZ.YYY" }] }
    assert.equal(requestKey(original), requestKey(forked))
    assert.match(canonicalise(original), /https:\/\/FIXTURE/)
  })

  test("wall-clock in the system prompt does not change the key", () => {
    // Browser-Use stamps the current time into its prompt, so two runs a
    // couple of minutes apart would otherwise miss on every single lookup.
    const at = (t: string) => ({
      messages: [{ role: "system", content: `current date/time is ${t}` }],
    })
    assert.equal(requestKey(at("2026-09-02 01:56 UTC")), requestKey(at("2026-09-02 01:58 UTC")))
    assert.equal(requestKey(at("2026-09-02 01:56 UTC")), requestKey(at("2026-11-30 22:04 UTC")))
    assert.match(canonicalise(at("2026-09-02 01:56 UTC")), /<TIMESTAMP>/)
  })

  test("a bare date is normalised too", () => {
    const day = (d: string) => ({ messages: [{ role: "user", content: `Today:${d}` }] })
    assert.equal(requestKey(day("2026-09-02")), requestKey(day("2026-09-03")))
  })

  test("a framework's per-session tab id does not change the key", () => {
    // Browser-Use labels tabs with a random 4-hex id and puts it in the prompt.
    const tabbed = (id: string) => ({
      messages: [{ role: "user", content: `Current tab: ${id}\nTab ${id}: https://x/y - Title` }],
    })
    assert.equal(requestKey(tabbed("EC98")), requestKey(tabbed("55FC")))
  })

  test("normalisation does not eat ordinary page text", () => {
    // The tab rules are anchored to their wording; bare hex-looking words in
    // page content must still distinguish two different pages.
    assert.notEqual(
      requestKey({ messages: [{ role: "user", content: "product code ABCD in stock" }] }),
      requestKey({ messages: [{ role: "user", content: "product code BEEF in stock" }] }),
    )
  })

  test("a genuinely different prompt is a different key", () => {
    assert.notEqual(
      requestKey({ messages: [{ role: "user", content: "click login" }] }),
      requestKey({ messages: [{ role: "user", content: "click checkout" }] }),
    )
  })

  test("summaries read as the last message", () => {
    assert.match(summarise({ messages: [{ role: "user", content: "  what   now?  " }] }), /^user: what now\?$/)
  })
})

describe("repeated identical requests", () => {
  test("replay hands back the answers in the order they were given", () => {
    const reader = new CassetteReader({
      runId: "r", model: "m",
      entries: [
        { index: 0, key: "k", model: "m", summary: "", request: "", response: "first" },
        { index: 1, key: "k", model: "m", summary: "", request: "", response: "second" },
      ],
    })
    assert.equal(reader.take("k"), "first")
    assert.equal(reader.take("k"), "second")
    // Past the end, the last answer stands rather than becoming a miss.
    assert.equal(reader.take("k"), "second")
    assert.equal(reader.take("unknown"), undefined)
  })
})

// ------------------------------------------------------------------- proxy

describe("record then replay", () => {
  test("recording forwards upstream and captures the exchange", async () => {
    const proxy = await LlmProxy.start({ upstreamBaseUrl: upstreamUrl, apiKey: "k" })
    try {
      proxy.bind({ runId: "run-1", mode: "record", model: "m", missPolicy: "live" })
      const before = upstreamCalls
      const out = await ask(proxy.baseUrlFor("run-1"), "hello")
      assert.match(out.choices![0]!.message!.content!, /^reply #/)
      assert.equal(upstreamCalls, before + 1, "record must reach upstream")

      // The upstream base already ends in /v1; forwarding the client's /v1
      // too would produce /v1/v1/chat/completions and 404 against a real API.
      assert.equal(
        upstreamPaths.at(-1),
        "/v1/chat/completions",
        "the version segment must not be doubled",
      )

      const cassette = proxy.cassetteFor("run-1")!
      assert.equal(cassette.entries.length, 1)
      assert.equal(cassette.entries[0]!.summary, "user: hello")
      assert.deepEqual(proxy.statsFor("run-1"), { hits: 0, misses: 0, live: 1 })
    } finally { await proxy.stop() }
  })

  test("replay answers from the cassette without touching upstream", async () => {
    const proxy = await LlmProxy.start({ upstreamBaseUrl: upstreamUrl, apiKey: "k" })
    try {
      proxy.bind({ runId: "rec", mode: "record", model: "m", missPolicy: "live" })
      const recorded = await ask(proxy.baseUrlFor("rec"), "hello")
      const cassette = proxy.cassetteFor("rec")!

      proxy.bind({
        runId: "rep", mode: "replay", model: "m", missPolicy: "live",
        reader: new CassetteReader({ ...cassette, runId: "rep" }),
      })
      const before = upstreamCalls
      const replayed = await ask(proxy.baseUrlFor("rep"), "hello")

      assert.equal(upstreamCalls, before, "replay must not reach upstream")
      assert.deepEqual(replayed, recorded, "and must return the same bytes")
      assert.deepEqual(proxy.statsFor("rep"), { hits: 1, misses: 0, live: 0 })
    } finally { await proxy.stop() }
  })

  test("an unrecorded question is a miss, and is reported", async () => {
    const proxy = await LlmProxy.start({ upstreamBaseUrl: upstreamUrl, apiKey: "k" })
    try {
      proxy.bind({ runId: "rec2", mode: "record", model: "m", missPolicy: "live" })
      await ask(proxy.baseUrlFor("rec2"), "hello")

      proxy.bind({
        runId: "rep2", mode: "replay", model: "m", missPolicy: "live",
        reader: new CassetteReader({ ...proxy.cassetteFor("rec2")!, runId: "rep2" }),
      })
      // The agent diverged: it asked something it never asked before.
      const before = upstreamCalls
      await ask(proxy.baseUrlFor("rep2"), "something else entirely")
      assert.equal(upstreamCalls, before + 1, "`live` policy falls through so the run completes")
      assert.equal(proxy.statsFor("rep2")!.misses, 1)
    } finally { await proxy.stop() }
  })

  test("--on-cache-miss error refuses instead of resampling", async () => {
    const proxy = await LlmProxy.start({ upstreamBaseUrl: upstreamUrl, apiKey: "k" })
    try {
      proxy.bind({
        runId: "strict", mode: "replay", model: "m", missPolicy: "error",
        reader: new CassetteReader({ runId: "strict", model: "m", entries: [] }),
      })
      const before = upstreamCalls
      const out = await ask(proxy.baseUrlFor("strict"), "anything")
      assert.ok(out.error, "should refuse")
      assert.equal(upstreamCalls, before, "and must not reach upstream")
    } finally { await proxy.stop() }
  })

  test("parallel runs keep separate cassettes", async () => {
    const proxy = await LlmProxy.start({ upstreamBaseUrl: upstreamUrl, apiKey: "k" })
    try {
      proxy.bind({ runId: "a", mode: "record", model: "m", missPolicy: "live" })
      proxy.bind({ runId: "b", mode: "record", model: "m", missPolicy: "live" })
      await Promise.all([
        ask(proxy.baseUrlFor("a"), "for a"),
        ask(proxy.baseUrlFor("b"), "for b"),
        ask(proxy.baseUrlFor("a"), "for a again"),
      ])
      assert.equal(proxy.cassetteFor("a")!.entries.length, 2)
      assert.equal(proxy.cassetteFor("b")!.entries.length, 1)
    } finally { await proxy.stop() }
  })

  test("an unbound run is refused rather than silently proxied", async () => {
    const proxy = await LlmProxy.start({ upstreamBaseUrl: upstreamUrl, apiKey: "k" })
    try {
      const out = await ask(proxy.baseUrlFor("never-bound"), "hi")
      assert.ok(out.error, "unknown runs must not reach upstream on someone else's key")
    } finally { await proxy.stop() }
  })
})
