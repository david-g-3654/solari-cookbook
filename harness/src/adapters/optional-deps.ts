/**
 * Loaders for the optional agent frameworks.
 *
 * Stagehand and zod are not dependencies of this package — the harness must
 * install and run without them, because the scripted adapter is what CI uses.
 * They are imported through a non-literal specifier so TypeScript does not try
 * to resolve them at build time, and the minimal structural interfaces below
 * are what the adapter is actually checked against.
 */

/** Hides the specifier from TS's module resolver. */
async function loadOptional(name: string): Promise<unknown> {
  return import(/* @vite-ignore */ name)
}

// -------------------------------------------------------------- stagehand

export interface StagehandInstance {
  act(instruction: string): Promise<unknown>
  extract(instruction: string, schema: unknown): Promise<{ data: unknown }>
  close(): Promise<void>
}

export interface StagehandModule {
  localBrowser: {
    connect(opts: { cdpUrl: string; extensionId?: string }): Promise<unknown>
  }
  Stagehand: {
    /** `model` is either `{ modelName, apiKey }` or a `{ generate }` ClientLLM. */
    create(opts: { browser: unknown; model: unknown }): Promise<StagehandInstance>
  }
}

export async function loadStagehand(): Promise<StagehandModule> {
  try {
    return (await loadOptional("@browserbasehq/stagehand")) as StagehandModule
  } catch {
    throw new Error(
      "the stagehand adapter needs @browserbasehq/stagehand — run:\n" +
        "  npm i @browserbasehq/stagehand",
    )
  }
}

// -------------------------------------------------------------------- zod

/** Only the three builders the extraction schemas use. */
export interface ZodLike {
  object(shape: Record<string, unknown>): unknown
  array(inner: unknown): unknown
  string(): unknown
}

export async function loadZod(): Promise<ZodLike> {
  // zod ships with Stagehand, so it is present whenever that adapter is.
  const mod = (await loadOptional("zod")) as { z?: ZodLike } & Partial<ZodLike>
  const z = mod.z ?? (mod as ZodLike)
  if (typeof z?.object !== "function") {
    throw new Error("could not load zod — reinstall @browserbasehq/stagehand")
  }
  return z
}
