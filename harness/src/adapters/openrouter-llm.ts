/**
 * An OpenRouter-backed `ClientLLM` for Stagehand.
 *
 * Stagehand's built-in model config only names openai, anthropic, google, groq
 * and cerebras, and offers no base-URL override — so an OpenRouter key cannot
 * be used through it, even though OpenRouter speaks the OpenAI wire format.
 * What it does offer is `model: { generate }`, a callback that hands you the
 * whole request and takes the whole response. This is that callback.
 *
 * The mapping is mechanical but not quite one-to-one; three places bite:
 *
 *   - Stagehand carries tool RESULTS inside a user message's content array,
 *     while OpenAI wants them as separate `role: "tool"` messages. One
 *     Stagehand message can therefore become several OpenAI ones.
 *   - Stagehand's structured mode wants the parsed object back in
 *     `structuredContent`, with `outputFormat` naming which shape it is.
 *   - Every schema here is a zod `strictObject`, so an extra field is a
 *     validation error rather than something harmlessly ignored. Build the
 *     results exactly, and omit rather than pass `undefined`.
 */
import { OPENROUTER_BASE_URL, type ModelChoice } from "./model.js"

// ------------------------------------------------ Stagehand's LLM contract

interface TextBlock { type: "text"; text: string }
interface ImageBlock { type: "image"; data: string; mimeType: string }
interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
interface ToolResultBlock {
  type: "tool_result"
  toolUseId: string
  content: Array<TextBlock | ImageBlock>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}
type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock

interface LLMMessage { role: "user" | "assistant"; content: ContentBlock | ContentBlock[] }

interface ClientTool {
  name: string
  description?: string
  inputSchema: unknown
}

export interface GenerateParams {
  messages: LLMMessage[]
  systemPrompt?: string
  temperature?: number
  stopSequences?: string[]
  tools?: ClientTool[]
  toolChoice?: { mode?: "auto" | "required" | "none" }
  responseFormat?:
    | { type: "text" }
    | { type: "json_schema"; name: string; description?: string; schema: unknown }
}

export interface GenerateResult {
  role: "assistant"
  content: ContentBlock | ContentBlock[]
  stopReason?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  outputFormat: "text" | "json_schema"
  structuredContent?: unknown
}

// -------------------------------------------------------- OpenAI wire types

interface OpenAiToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool"
  content?: string | Array<Record<string, unknown>> | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

const asArray = (c: ContentBlock | ContentBlock[]): ContentBlock[] =>
  Array.isArray(c) ? c : [c]

/** `data:` URL, which is how OpenAI-compatible APIs take inline images. */
const dataUrl = (b: ImageBlock): string => `data:${b.mimeType};base64,${b.data}`

/**
 * Convert one Stagehand message into one or more OpenAI messages.
 * Tool results have to be split out into their own `role: "tool"` entries.
 */
function toOpenAiMessages(msg: LLMMessage): OpenAiMessage[] {
  const blocks = asArray(msg.content)
  const out: OpenAiMessage[] = []

  // Tool results first: OpenAI requires them to answer the preceding call.
  for (const b of blocks) {
    if (b.type !== "tool_result") continue
    const text = b.content
      .map((c) => (c.type === "text" ? c.text : "[image]"))
      .join("\n")
    out.push({ role: "tool", tool_call_id: b.toolUseId, content: text })
  }

  const toolCalls = blocks
    .filter((b): b is ToolUseBlock => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function" as const,
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }))

  const parts: Array<Record<string, unknown>> = []
  for (const b of blocks) {
    if (b.type === "text") parts.push({ type: "text", text: b.text })
    else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: dataUrl(b) } })
  }

  if (parts.length > 0 || toolCalls.length > 0) {
    // An assistant turn that only made tool calls has no content at all, and
    // an all-text one is sent as a plain string — the array form is only
    // needed when an image is in the mix.
    const content: string | Array<Record<string, unknown>> | null =
      parts.length === 0
        ? null
        : parts.every((p) => p.type === "text")
          ? parts.map((p) => String(p.text)).join("\n")
          : parts
    out.push({
      role: msg.role,
      ...(content === null ? {} : { content }),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })
  }
  return out
}

function buildBody(params: GenerateParams, model: string): Record<string, unknown> {
  const messages: OpenAiMessage[] = []
  if (params.systemPrompt) messages.push({ role: "system", content: params.systemPrompt })
  for (const m of params.messages) messages.push(...toOpenAiMessages(m))

  const rf = params.responseFormat
  return {
    model,
    messages,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.stopSequences?.length ? { stop: params.stopSequences } : {}),
    ...(params.tools?.length
      ? {
          tools: params.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              ...(t.description ? { description: t.description } : {}),
              parameters: t.inputSchema,
            },
          })),
        }
      : {}),
    ...(params.toolChoice?.mode ? { tool_choice: params.toolChoice.mode } : {}),
    ...(rf?.type === "json_schema"
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: rf.name, schema: rf.schema, strict: false },
          },
        }
      : {}),
  }
}

interface ChatCompletion {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] }
    finish_reason?: string
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  error?: { message?: string }
}

function toResult(json: ChatCompletion, wantsJson: boolean): GenerateResult {
  const choice = json.choices?.[0]
  const text = choice?.message?.content ?? ""
  const calls = choice?.message?.tool_calls ?? []

  const content: ContentBlock[] = []
  if (text) content.push({ type: "text", text })
  for (const c of calls) {
    content.push({
      type: "tool_use",
      id: c.id,
      name: c.function.name,
      // A model can emit malformed arguments; an empty object keeps the run
      // alive so the failure shows up as a bad action, not a crashed harness.
      input: safeParse(c.function.arguments),
    })
  }
  // `content` may not be empty: Stagehand's schema expects at least a block.
  if (content.length === 0) content.push({ type: "text", text: "" })

  const usage = json.usage
    ? {
        inputTokens: json.usage.prompt_tokens ?? 0,
        outputTokens: json.usage.completion_tokens ?? 0,
        totalTokens: json.usage.total_tokens ?? 0,
      }
    : undefined

  const base = {
    role: "assistant" as const,
    content,
    ...(choice?.finish_reason ? { stopReason: choice.finish_reason } : {}),
    ...(usage ? { usage } : {}),
  }

  return wantsJson
    ? { ...base, outputFormat: "json_schema", structuredContent: safeParse(text) }
    : { ...base, outputFormat: "text" }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s)
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Build the `model` value for `Stagehand.create()`.
 *
 * Native providers go through Stagehand's own client; anything needing a base
 * URL (OpenRouter) gets this `generate` bridge instead.
 */
export function stagehandModel(choice: ModelChoice): unknown {
  if (choice.provider !== "openrouter") {
    return { modelName: choice.id, apiKey: choice.apiKey }
  }

  return {
    generate: async (params: GenerateParams): Promise<GenerateResult> => {
      const wantsJson = params.responseFormat?.type === "json_schema"
      const res = await fetch(`${choice.baseUrl ?? OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${choice.apiKey}`,
          "content-type": "application/json",
          // OpenRouter attributes traffic with these; harmless elsewhere.
          "x-title": "splitflap",
        },
        body: JSON.stringify(buildBody(params, choice.model)),
      })
      if (!res.ok) {
        throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`)
      }
      const json = (await res.json()) as ChatCompletion
      if (json.error) throw new Error(`OpenRouter: ${json.error.message ?? "unknown error"}`)
      return toResult(json, wantsJson)
    },
  }
}
