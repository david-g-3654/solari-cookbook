/**
 * Resolving which model an LLM adapter should use, and how to reach it.
 *
 * Model ids are `provider/model`, with OpenRouter taking a third segment for
 * the model it is proxying: `openrouter/anthropic/claude-sonnet-4.5`.
 *
 * OpenRouter matters here because it is one key for every model, which is the
 * normal way someone actually has access to several. It speaks the OpenAI wire
 * format, so anything that accepts a base URL can use it directly.
 */
export interface ModelChoice {
  /** Full id as written, e.g. "openrouter/anthropic/claude-sonnet-4.5". */
  id: string
  /** Who serves it: "openrouter", "openai", "anthropic". */
  provider: string
  /** Model name as the provider expects it, with any routing prefix stripped. */
  model: string
  apiKey: string
  /** Set for OpenAI-compatible providers that are not OpenAI itself. */
  baseUrl?: string
  /**
   * Whether traffic to this model speaks the OpenAI chat-completions wire
   * format. Only these can be recorded: the cassette proxy sits in front of a
   * base URL, and a provider with its own protocol (Anthropic's, say) has no
   * base URL to point at it.
   */
  openAiCompatible: boolean
  /** Where the proxy forwards to. Undefined when not OpenAI-compatible. */
  upstreamBaseUrl?: string
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
export const OPENAI_BASE_URL = "https://api.openai.com/v1"

const DEFAULT_MODEL = "openrouter/anthropic/claude-sonnet-4.5"

const ENV_VAR: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
}

/**
 * Pick the model from SPLITFLAP_MODEL, falling back to whichever key is set.
 * Erroring here — before a browser is launched — keeps a missing key from
 * costing a session.
 */
export function resolveModel(explicit?: string): ModelChoice {
  const id = explicit ?? process.env.SPLITFLAP_MODEL ?? inferDefault()
  const [provider, ...rest] = id.split("/")
  if (!provider || rest.length === 0) {
    throw new Error(
      `SPLITFLAP_MODEL must look like "provider/model" — got "${id}".\n` +
        `  e.g. ${DEFAULT_MODEL}, openai/gpt-4.1-mini, anthropic/claude-sonnet-4-5`,
    )
  }

  const envVar = ENV_VAR[provider]
  if (!envVar) {
    throw new Error(
      `unsupported model provider "${provider}" — expected one of: ${Object.keys(ENV_VAR).join(", ")}`,
    )
  }
  const apiKey = process.env[envVar]
  if (!apiKey) throw new Error(`${id} needs ${envVar} — add it to harness/.env`)

  const upstream =
    provider === "openrouter" ? OPENROUTER_BASE_URL : provider === "openai" ? OPENAI_BASE_URL : undefined

  return {
    id,
    provider,
    model: rest.join("/"),
    apiKey,
    openAiCompatible: upstream !== undefined,
    ...(upstream ? { upstreamBaseUrl: upstream } : {}),
    ...(provider === "openrouter" ? { baseUrl: OPENROUTER_BASE_URL } : {}),
  }
}

/** With no SPLITFLAP_MODEL, use whichever provider has a key present. */
function inferDefault(): string {
  if (process.env.OPENROUTER_API_KEY) return DEFAULT_MODEL
  if (process.env.ANTHROPIC_API_KEY) return "anthropic/claude-sonnet-4-5"
  if (process.env.OPENAI_API_KEY) return "openai/gpt-4.1-mini"
  throw new Error(
    "no model key found — set one of OPENROUTER_API_KEY, ANTHROPIC_API_KEY or " +
      "OPENAI_API_KEY in harness/.env (the default `scripted` adapter needs none)",
  )
}
