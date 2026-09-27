import crypto from "crypto"
import { fetchPublic } from "./safe-fetch"
import { USER_AGENT } from "./robots"

// Cheap "has this site changed?" check before an expensive refresh (Jina Reader + LLM): one
// conditional GET of the homepage. A 304 (ETag / Last-Modified) or the same visible-text hash as
// last time means unchanged. Needs lawp_sites.http_etag, http_last_modified, page_fingerprint and
// checked_at (list_eight.sql).

export type Fingerprint = { etag: string | null, lastModified: string | null, text: string | null, notModified: boolean }

export function visibleTextHash(html: string): string {
  const text = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32)
}

export async function fingerprint(domain: string, previous: { etag?: string | null, lastModified?: string | null }): Promise<Fingerprint | null> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, "Accept": "text/html" }
  if (previous.etag) headers["If-None-Match"] = previous.etag
  if (previous.lastModified) headers["If-Modified-Since"] = previous.lastModified
  const r = await fetchPublic(`https://${domain}/`, { headers, signal: AbortSignal.timeout(10000) }).catch(() => null)
  if (!r) return null
  if (r.status === 304) return { etag: previous.etag || null, lastModified: previous.lastModified || null, text: null, notModified: true }
  if (!r.ok || !(r.headers.get("content-type") || "").includes("html")) return null
  const html = (await r.text()).slice(0, 1_000_000)
  return { etag: r.headers.get("etag"), lastModified: r.headers.get("last-modified"), text: visibleTextHash(html), notModified: false }
}
