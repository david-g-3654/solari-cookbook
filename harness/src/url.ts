/**
 * Building URLs against a Solari preview base.
 *
 * `previewUrl()` hands back a URL that already carries a query string — an
 * access token, without which the gateway answers 401. So a target URL cannot
 * be built by string concatenation: `base + "/catalog.html"` puts the path
 * INSIDE the query, leaving `pathname` as "/".
 *
 * Solari's gateway happens to be lenient enough to route that anyway, which is
 * how an earlier version of this passed its whole suite while every `goto` was
 * nominally pointed at the site root. Relying on that leniency is not a plan.
 * Set the pathname properly and keep the query, which is what the token needs.
 */
export function withPath(baseUrl: string, path: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${path.replace(/^\/+/, "")}`
  return url.toString()
}
