/** Environment and shared client construction. */
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = join(HERE, "..")

/** Load harness/.env if present. Node 22 does this natively — no dependency. */
export function loadEnv(): void {
  const envFile = join(PKG_ROOT, ".env")
  if (existsSync(envFile)) process.loadEnvFile(envFile)
}

export function requireApiKey(): string {
  const key = process.env.SOLARI_API_KEY
  if (!key) {
    throw new Error(
      "SOLARI_API_KEY is not set.\n" +
        `  cp ${join(PKG_ROOT, ".env.example")} ${join(PKG_ROOT, ".env")}\n` +
        "  # then paste your key from https://console.getsolari.com",
    )
  }
  return key
}

/** Where runs, traces and downloaded replays are kept. */
export function stateDir(): string {
  return process.env.SPLITFLAP_STATE ?? join(PKG_ROOT, ".splitflap")
}

/** Port the fixture site and dashboard are served on inside the sandbox. */
export const FIXTURE_PORT = 3000

/** Absolute path of the served root inside the guest. */
export const FIXTURE_ROOT = "/srv/site"
