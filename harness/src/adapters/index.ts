import type { Adapter } from "./types.js"
import { scriptedAdapter } from "./scripted.js"
import { stagehandAdapter } from "./stagehand.js"
import { browserUseAdapter } from "./browser-use.js"

export type { Adapter, AdapterRunContext } from "./types.js"

export const ADAPTERS: Record<string, Adapter> = {
  scripted: scriptedAdapter,
  stagehand: stagehandAdapter,
  "browser-use": browserUseAdapter,
}

export function adapterByName(name: string): Adapter {
  const a = ADAPTERS[name]
  if (!a) {
    throw new Error(
      `unknown adapter "${name}" — known: ${Object.keys(ADAPTERS).join(", ")}`,
    )
  }
  return a
}
