/**
 * The five golden tasks.
 *
 * Each one is a complete spec of a browser-agent job: a natural-language goal
 * (what the LLM adapters are told), a deterministic step script (what the
 * `scripted` adapter executes, and what replay re-runs), and assertions that
 * define success independently of which adapter produced the answer.
 *
 * Assertions never look at timings or at how many steps were taken — only at
 * where the browser ended up and what came back. That is what lets one
 * dashboard compare a scripted baseline against Browser-Use against Stagehand.
 */
import type { Recovery, Task } from "../types.js"
import { FIXTURE_ITEM_COUNT } from "../fixture/site.js"

/**
 * Shared login-wall recovery. Wired into every task that navigates more than
 * once, because the `loginWall` fault can interrupt any of them. Strip it with
 * `--no-recovery` to watch the suite go red on purpose.
 */
const WALL_RECOVERY: Recovery = {
  detect: "#sf-login-wall",
  steps: [
    { do: "fill", selector: "#sf-user", value: "demo" },
    { do: "fill", selector: "#sf-pass", value: "hunter2" },
    { do: "click", selector: "#sf-login-submit" },
  ],
}

export const TASKS: Task[] = [
  {
    id: "smoke-read",
    title: "Read the homepage tagline",
    goal: "Open the site's home page and report the tagline text shown under the heading.",
    extract: { instruction: "the tagline sentence shown under the main heading", as: "tagline", shape: "text" },
    path: "/index.html",
    steps: [
      { do: "goto", path: "/index.html" },
      { do: "waitFor", selector: "#tagline" },
      { do: "extractText", selector: "#tagline", as: "tagline" },
    ],
    assertions: [
      { kind: "answerContains", key: "tagline", value: "departure boards" },
      { kind: "urlContains", value: "index.html" },
    ],
  },

  {
    id: "catalog-browse",
    title: "Navigate to the catalog and list the first page",
    goal:
      "From the home page, follow the link to the catalog, then report the name of " +
      "every product listed on the first page.",
    extract: { instruction: "the product name of every item listed on the catalog page", as: "items", shape: "list" },
    path: "/index.html",
    steps: [
      { do: "goto", path: "/index.html" },
      { do: "click", selector: "#to-catalog" },
      { do: "waitFor", selector: ".item" },
      { do: "extractAll", selector: ".item .name", as: "items" },
    ],
    assertions: [
      { kind: "urlContains", value: "catalog" },
      { kind: "answerCountAtLeast", key: "items", n: 8 },
      { kind: "answerContains", key: "items", value: "Split-flap module" },
    ],
    recovery: WALL_RECOVERY,
  },

  {
    id: "paginate-collect",
    title: "Collect every SKU across all catalog pages",
    goal:
      "Go to the catalog and page through it to the end, collecting the SKU code of " +
      "every product in the whole catalog.",
    extract: { instruction: "the SKU code of every product across every page of the catalog", as: "skus", shape: "list" },
    path: "/catalog.html",
    steps: [
      { do: "goto", path: "/catalog.html" },
      { do: "waitFor", selector: "[data-sku]" },
      {
        do: "paginate",
        nextSelector: "#next-page",
        itemSelector: "[data-sku] .muted",
        as: "skus",
        maxPages: 5,
      },
    ],
    assertions: [
      { kind: "answerCountAtLeast", key: "skus", n: FIXTURE_ITEM_COUNT },
      { kind: "answerContains", key: "skus", value: "SF-1023" },
      { kind: "selectorVisible", selector: "#last-page" },
    ],
    recovery: WALL_RECOVERY,
  },

  {
    id: "login-flow",
    title: "Sign in and read the order history",
    goal:
      "Open the account page, sign in with username 'demo' and password 'hunter2', " +
      "then report the banner text confirming which account is signed in.",
    extract: { instruction: "the banner text confirming which account is now signed in", as: "banner", shape: "text" },
    path: "/account.html",
    steps: [
      { do: "goto", path: "/account.html" },
      { do: "fill", selector: "#acct-user", value: "demo" },
      { do: "fill", selector: "#acct-pass", value: "hunter2" },
      { do: "click", selector: "#acct-submit" },
      { do: "waitFor", selector: "#signed-in" },
      { do: "extractText", selector: "#signed-in", as: "banner" },
    ],
    assertions: [
      { kind: "urlContains", value: "account-ok" },
      { kind: "answerContains", key: "banner", value: "demo@splitflap.test" },
      { kind: "textContains", value: "Order #4417" },
    ],
    recovery: WALL_RECOVERY,
  },

  {
    id: "checkout-form",
    title: "Place an order through the checkout form",
    goal:
      "Open the checkout page and place an order for 3 units of SKU SF-1004 under the " +
      "name 'Ada Lovelace' with express shipping, then report the order reference.",
    extract: { instruction: "the order reference shown on the confirmation page", as: "ref", shape: "text" },
    path: "/checkout.html",
    steps: [
      { do: "goto", path: "/checkout.html" },
      { do: "fill", selector: "#co-name", value: "Ada Lovelace" },
      { do: "fill", selector: "#co-sku", value: "SF-1004" },
      { do: "fill", selector: "#co-qty", value: "3" },
      { do: "selectOption", selector: "#co-ship", value: "express" },
      { do: "click", selector: "#co-submit" },
      { do: "waitFor", selector: "#order-confirmed" },
      { do: "extractText", selector: "#order-ref", as: "ref" },
    ],
    assertions: [
      { kind: "selectorVisible", selector: "#order-confirmed" },
      { kind: "answerContains", key: "ref", value: "SF-ORDER-88231" },
      { kind: "urlContains", value: "checkout-done" },
    ],
    recovery: WALL_RECOVERY,
  },
]

export function taskById(id: string): Task {
  const t = TASKS.find((t) => t.id === id)
  if (!t) {
    throw new Error(`unknown task "${id}" — known: ${TASKS.map((t) => t.id).join(", ")}`)
  }
  return t
}

/** Drop recovery from every task — the `--no-recovery` regression demo. */
export function withoutRecovery(tasks: Task[]): Task[] {
  return tasks.map(({ recovery, ...rest }) => rest)
}
