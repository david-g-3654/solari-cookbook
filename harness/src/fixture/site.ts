/**
 * The hermetic fixture site.
 *
 * Every golden task runs against these pages, served from inside a Solari
 * sandbox. Keeping the target in our own VM is what makes a red cell on the
 * dashboard mean "the agent regressed" rather than "someone else's site was
 * down" — and it is what lets `splitflap replay` pin the world: a fork of the
 * fixture snapshot re-serves byte-identical bytes.
 *
 * Two rules these pages must keep:
 *   1. Links are RELATIVE. A forked VM gets a different preview host, and
 *      absolute URLs would send the browser back to the original.
 *   2. No network, no clocks, no randomness. Same request, same HTML, always.
 */

const CSS = `
:root { color-scheme: light dark; --fg:#111; --bg:#fff; --mut:#666; --line:#e3e3e3; --acc:#1a56db; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8e8; --bg:#131313; --mut:#9a9a9a; --line:#2c2c2c; --acc:#7aa2f7; }
}
* { box-sizing: border-box; }
body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; color: var(--fg); background: var(--bg);
       margin: 0; padding: 2rem; max-width: 52rem; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
nav { margin: 0 0 1.5rem; padding-bottom: .75rem; border-bottom: 1px solid var(--line); }
nav a { margin-right: 1rem; color: var(--acc); }
.item { padding: .6rem 0; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; }
.price { font-variant-numeric: tabular-nums; color: var(--mut); }
label { display: block; margin: .75rem 0 .25rem; font-size: .85rem; color: var(--mut); }
input, select { padding: .45rem .6rem; border: 1px solid var(--line); border-radius: 6px;
                background: var(--bg); color: var(--fg); min-width: 16rem; font: inherit; }
button { margin-top: 1rem; padding: .5rem 1rem; border: 0; border-radius: 6px;
         background: var(--acc); color: #fff; font: inherit; cursor: pointer; }
.banner { padding: .75rem 1rem; border-radius: 8px; background: #0f766e; color: #fff; margin: 1rem 0; }
.muted { color: var(--mut); font-size: .85rem; }
`

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${CSS}</style></head>
<body>
<nav>
  <a href="./index.html">Home</a>
  <a href="./catalog.html">Catalog</a>
  <a href="./account.html">Account</a>
  <a href="./checkout.html">Checkout</a>
</nav>
${body}
</body></html>
`

/** Deterministic catalog: 24 items across 3 pages of 8. */
const ITEMS = Array.from({ length: 24 }, (_, i) => ({
  sku: `SF-${String(1000 + i)}`,
  name: [
    "Split-flap module", "Departure board", "Flip digit", "Solenoid coil",
    "Drum spindle", "Vane set", "Control board", "Character wheel",
  ][i % 8]!,
  // Fixed arithmetic, not random — the same build every time.
  price: (12 + ((i * 7) % 40)) + 0.5,
}))

const PER_PAGE = 8
const PAGES = Math.ceil(ITEMS.length / PER_PAGE)

function catalogPage(n: number): string {
  const slice = ITEMS.slice((n - 1) * PER_PAGE, n * PER_PAGE)
  const rows = slice
    .map(
      (it) =>
        `  <div class="item" data-sku="${it.sku}">` +
        `<span class="name">${it.name} <span class="muted">${it.sku}</span></span>` +
        `<span class="price">$${it.price.toFixed(2)}</span></div>`,
    )
    .join("\n")
  const next =
    n < PAGES
      ? `<p><a id="next-page" href="./catalog-p${n + 1}.html">Next page &rarr;</a></p>`
      : `<p class="muted" id="last-page">End of catalog.</p>`
  return page(
    `Catalog page ${n}`,
    `<h1>Catalog</h1>
<p class="muted">Page ${n} of ${PAGES} &middot; ${ITEMS.length} items total</p>
${rows}
${next}`,
  )
}

/**
 * The site as a path -> contents map. Written into the sandbox verbatim.
 */
export function fixtureFiles(): Record<string, string> {
  const files: Record<string, string> = {}

  files["index.html"] = page(
    "Splitflap Supply Co.",
    `<h1>Splitflap Supply Co.</h1>
<p id="tagline">Parts for mechanical departure boards.</p>
<p class="muted">A hermetic fixture site. Every byte here is generated at build
time from fixed inputs, so two runs see exactly the same web.</p>
<p><a id="to-catalog" href="./catalog.html">Browse the catalog</a></p>`,
  )

  files["catalog.html"] = catalogPage(1)
  for (let n = 2; n <= PAGES; n++) files[`catalog-p${n}.html`] = catalogPage(n)

  files["account.html"] = page(
    "Account",
    `<h1>Account</h1>
<p class="muted">Sign in to see the order history.</p>
<form id="account-form" method="GET" action="./account-ok.html">
  <label for="acct-user">Username</label>
  <input id="acct-user" name="username" autocomplete="username">
  <label for="acct-pass">Password</label>
  <input id="acct-pass" name="password" type="password" autocomplete="current-password">
  <button id="acct-submit" type="submit">Sign in</button>
</form>`,
  )

  files["account-ok.html"] = page(
    "Account — signed in",
    `<h1>Account</h1>
<div class="banner" id="signed-in">Signed in as demo@splitflap.test</div>
<div class="item"><span>Order #4417</span><span class="price">$96.50</span></div>
<div class="item"><span>Order #4418</span><span class="price">$41.00</span></div>`,
  )

  files["checkout.html"] = page(
    "Checkout",
    `<h1>Checkout</h1>
<form id="checkout-form" method="GET" action="./checkout-done.html">
  <label for="co-name">Full name</label>
  <input id="co-name" name="name">
  <label for="co-sku">SKU</label>
  <input id="co-sku" name="sku">
  <label for="co-qty">Quantity</label>
  <input id="co-qty" name="qty" type="number" value="1">
  <label for="co-ship">Shipping</label>
  <select id="co-ship" name="ship">
    <option value="standard">Standard</option>
    <option value="express">Express</option>
  </select>
  <button id="co-submit" type="submit">Place order</button>
</form>`,
  )

  files["checkout-done.html"] = page(
    "Order placed",
    `<h1>Order placed</h1>
<div class="banner" id="order-confirmed">Order confirmed</div>
<p id="order-ref">Reference: SF-ORDER-88231</p>`,
  )

  return files
}

/** Item count, exported so tasks can assert against it without duplicating it. */
export const FIXTURE_ITEM_COUNT = ITEMS.length
export const FIXTURE_PAGE_COUNT = PAGES
