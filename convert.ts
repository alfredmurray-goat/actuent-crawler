import { toLAWP, enrichLAWP, Fetched } from "./shared"
import { heuristicLAWP, withBookingLinks } from "./heuristic"
import { withLlmsTxt, withLlmsTxtInput } from "./llmstxt"
import { extractBusiness } from "./business"
import { rescue } from "./rescue"
import { cleanPages } from "./boilerplate"
import { promises as dns } from "dns"

// One conversion pipeline for the mass crawler (crawl.ts) and the backlog job (reconvert.ts):
//   1. Rules first: the rule-based converter reads the page's real links and forms (actions with
//      real URLs). If it finds nothing, rescue() tries the rendered page, www./http://, llms.txt
//      and the sitemap.
//   2. LLM, when there's quota: rules found actions → the LLM only writes the English name, summary
//      and keywords (enrichLAWP, ~1/3 of the tokens); rules found nothing → full LLM conversion.
//   3. Booking links, llms.txt pages, cleaned page text and schema.org business details added.

export type Converted = { lawp: any, conversion: "llm" | "heuristic", from: string }

const usable = (lawp: any) => Array.isArray(lawp?.actions) && lawp.actions.length > 0

// `llm` runs an LLM call through the caller's queue (one at a time, paced); it returns null when
// the caller has given up on the LLM for this run.
export async function convertSite(
  domain: string, page: Fetched | null, llms: string | null,
  llm: (<T>(fn: () => Promise<T>) => Promise<T | null>) | null
): Promise<Converted | null> {
  // Parked domains and error or bot-check pages aren't sites: no conversion (and no LLM tokens).
  if (page && isParkedOrError(page.text)) return null
  let rules: any = page ? heuristicLAWP(domain, page.raw, page.isHtml) : null
  let from = "homepage"
  if (!usable(rules)) {
    const saved = await rescue(domain, page, false).catch(() => null)
    if (saved) { rules = saved.lawp; from = saved.from }
  }

  let out: Converted | null = null
  if (llm && page) {
    const input = withLlmsTxtInput(page.text, llms)
    if (usable(rules)) {
      const enriched = await llm(() => enrichLAWP(domain, rules, input))
      if (enriched) out = { lawp: enriched, conversion: "llm", from }
    } else {
      const full = await llm(() => toLAWP(domain, input))
      if (usable(full)) out = { lawp: full, conversion: "llm", from: "homepage" }
    }
  }
  if (!out && usable(rules)) out = { lawp: rules, conversion: "heuristic", from }
  if (!out) return null

  let lawp = page ? withBookingLinks(out.lawp, page.raw) : out.lawp
  lawp = withLlmsTxt(lawp, domain, llms)
  lawp = { ...lawp, name: cleanName(lawp.name, domain), pages: cleanTitles(cleanPages(lawp.pages) || lawp.pages) }
  const business = page?.isHtml ? extractBusiness(page.raw) : null
  if (business && !lawp.business) lawp.business = business
  return { ...out, lawp }
}

// True when the domain doesn't exist any more (no DNS record), as opposed to a slow or blocking site.
export async function domainGone(domain: string): Promise<boolean> {
  try { await dns.lookup(domain); return false }
  catch (e: any) { return e?.code === "ENOTFOUND" || e?.code === "ENODATA" }
}

// "Home - Nike" / "Welcome to Nike" / "Nike | Official Site" → "Nike" (same rules as live search).
export function cleanName(name: string, domain: string): string {
  let n = String(name || "").replace(/\s+/g, " ").trim()
  n = n.replace(/^(welcome to|home\s*[-|–—:]\s*|homepage\s*[-|–—:]\s*)/i, "").replace(/\s*[-|–—:]\s*(home|homepage|official (web)?site|welcome)$/i, "").trim()
  if (/^(home|homepage|index|untitled|welcome|website)$/i.test(n) || !n) {
    const label = domain.replace(/^www\./, "").split(".")[0]
    n = label.charAt(0).toUpperCase() + label.slice(1)
  }
  return n.slice(0, 100)
}

export function cleanTitles(pages: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [path, page] of Object.entries(pages || {})) {
    const title = typeof page?.title === "string" ? page.title.replace(/\s+/g, " ").replace(/^(home\s*[-|–—:]\s*)/i, "").replace(/\s*[-|–—:]\s*(home|homepage)$/i, "").trim().slice(0, 120) : page?.title
    out[path] = { ...page, title: title || page?.title }
  }
  return out
}

const PARKED = /\b(this domain (is|may be) for sale|buy this domain|domain for sale|parked (free|domain)|is parked|domain has expired|renew (this|your) domain)\b/i
const ERROR_PAGE = /\b(404|page not found|access denied|forbidden|just a moment|checking your browser|attention required|enable javascript and cookies|account suspended|bandwidth limit exceeded)\b/i
export function isParkedOrError(text: string): boolean {
  const t = String(text || "")
  return PARKED.test(t.slice(0, 1500)) || (t.length < 400 && ERROR_PAGE.test(t))
}
