/**
 * The OpenRouter bridge's mapping logic.
 *
 * This code cannot currently be exercised end to end — Stagehand 4.x will not
 * attach to a Solari browser at all (see src/adapters/stagehand.ts) — so the
 * pure mapping is tested directly rather than shipped unverified.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  buildBody, toOpenAiMessages, toResult,
  type ChatCompletion, type GenerateParams,
} from "../src/adapters/openrouter-llm.js"

describe("Stagehand message → OpenAI message", () => {
  test("plain text becomes a string, not a parts array", () => {
    const out = toOpenAiMessages({ role: "user", content: [{ type: "text", text: "hello" }] })
    assert.deepEqual(out, [{ role: "user", content: "hello" }])
  })

  test("an image forces the parts array and a data: URL", () => {
    const out = toOpenAiMessages({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
    })
    assert.equal(out.length, 1)
    assert.deepEqual(out[0]!.content, [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ])
  })

  test("an assistant turn of only tool calls carries no content", () => {
    const out = toOpenAiMessages({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "click", input: { selector: "#go" } }],
    })
    assert.equal(out.length, 1)
    assert.equal("content" in out[0]!, false, "OpenAI rejects content: undefined here")
    assert.deepEqual(out[0]!.tool_calls, [
      { id: "c1", type: "function", function: { name: "click", arguments: '{"selector":"#go"}' } },
    ])
  })

  test("tool results are split into their own role:tool messages", () => {
    // Stagehand nests results inside a user message; OpenAI wants them separate.
    const out = toOpenAiMessages({
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "clicked" }] },
        { type: "text", text: "now what?" },
      ],
    })
    assert.equal(out.length, 2)
    assert.deepEqual(out[0], { role: "tool", tool_call_id: "c1", content: "clicked" })
    assert.deepEqual(out[1], { role: "user", content: "now what?" })
  })

  test("a tool result alone produces no trailing empty user message", () => {
    const out = toOpenAiMessages({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "ok" }] }],
    })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.role, "tool")
  })
})

describe("request body", () => {
  const base: GenerateParams = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }

  test("the system prompt leads the message list", () => {
    const body = buildBody({ ...base, systemPrompt: "be brief" }, "anthropic/claude-sonnet-4.5")
    const msgs = body.messages as Array<{ role: string }>
    assert.equal(msgs[0]!.role, "system")
    assert.equal(body.model, "anthropic/claude-sonnet-4.5")
  })

  test("absent options are omitted, not sent as undefined", () => {
    const body = buildBody(base, "m")
    for (const k of ["temperature", "stop", "tools", "tool_choice", "response_format"]) {
      assert.equal(k in body, false, `${k} should be omitted entirely`)
    }
  })

  test("tools and a json schema map onto the OpenAI shapes", () => {
    const body = buildBody(
      {
        ...base,
        tools: [{ name: "click", description: "click it", inputSchema: { type: "object" } }],
        toolChoice: { mode: "required" },
        responseFormat: { type: "json_schema", name: "Out", schema: { type: "object" } },
      },
      "m",
    )
    assert.deepEqual(body.tools, [
      {
        type: "function",
        function: { name: "click", description: "click it", parameters: { type: "object" } },
      },
    ])
    assert.equal(body.tool_choice, "required")
    assert.deepEqual(body.response_format, {
      type: "json_schema",
      json_schema: { name: "Out", schema: { type: "object" }, strict: false },
    })
  })
})

describe("response → Stagehand result", () => {
  const completion = (over: Partial<ChatCompletion> = {}): ChatCompletion => ({
    choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    ...over,
  })

  test("text mode returns a text block and mapped usage", () => {
    const r = toResult(completion(), false)
    assert.equal(r.outputFormat, "text")
    assert.deepEqual(r.content, [{ type: "text", text: "hello" }])
    assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14 })
    assert.equal(r.stopReason, "stop")
    assert.equal("structuredContent" in r, false, "text results must not carry it")
  })

  test("json mode parses the content into structuredContent", () => {
    const r = toResult(
      completion({ choices: [{ message: { content: '{"value":"x"}' } }] }),
      true,
    )
    assert.equal(r.outputFormat, "json_schema")
    assert.deepEqual(r.structuredContent, { value: "x" })
  })

  test("tool calls become tool_use blocks", () => {
    const r = toResult(
      completion({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "click", arguments: '{"a":1}' } }],
          },
        }],
      }),
      false,
    )
    assert.deepEqual(r.content, [{ type: "tool_use", id: "c1", name: "click", input: { a: 1 } }])
  })

  test("malformed tool arguments degrade to {} rather than throwing", () => {
    // A bad action should surface as a failed step, not a crashed harness.
    const r = toResult(
      completion({
        choices: [{
          message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "not json" } }] },
        }],
      }),
      false,
    )
    assert.deepEqual((r.content as Array<{ input: unknown }>)[0]!.input, {})
  })

  test("an empty response still carries one content block", () => {
    // Stagehand's schema expects at least a block; an empty array fails validation.
    const r = toResult({ choices: [{ message: { content: "" } }] }, false)
    assert.deepEqual(r.content, [{ type: "text", text: "" }])
    assert.equal("usage" in r, false, "usage is omitted when the API sent none")
  })
})
