import fs from "fs"
import { SUPABASE_URL, SUPABASE_HEADERS, robotsAllows } from "./shared"
import { USER_AGENT } from "./robots"
import { fetchPublic } from "./safe-fetch"
import { searchNeedsTheDatabase } from "./quiet"

// Weekly: the returns and shipping policies of the best-known shops ("does Patagonia do free returns?",
// "how long is Zara's return window?"). Policy pages are where shops say it, but they're deep in the
// site, so the normal crawl rarely has them. Shopify shops publish them at /policies/…; others at a
// handful of usual paths. Only the paragraphs about returns, refunds, exchanges and shipping are kept
// (up to 2,500 characters a page), saved as the site's own pages for actuent_ask_site and search answers.
// Try: DRY_RUN=1 DOMAINS=allbirds.com,zara.com npx tsx policies.ts

const PATHS: [string, string][] = [
  ["/policies/refund-policy", "returns"], ["/policies/shipping-policy", "shipping"],
  ["/returns", "returns"], ["/return-policy", "returns"], ["/returns-policy", "returns"], ["/pages/returns", "returns"], ["/help/returns", "returns"],
  ["/customer-service/returns", "returns"], ["/pages/returns-exchanges", "returns"], ["/pages/return-policy", "returns"], ["/returns-exchanges", "returns"], ["/help/returns-exchanges", "returns"],
  ["/pages/shipping-returns", "returns"], ["/shipping-returns", "returns"], ["/customer-service/shipping", "shipping"], ["/pages/shipping-policy", "shipping"], ["/shipping", "shipping"], ["/shipping-policy", "shipping"], ["/pages/shipping", "shipping"], ["/help/shipping", "shipping"]
]
const RELEVANT = /\b(return|returns|refund|refunds|exchange|exchanges|ship|shipping|delivery|deliver|days|free|label|prepaid|store credit|original condition|tags|receipt|international|customs|duties|business days|express|standard)\b/i
const MAX_SHOPS = parseInt(process.env.MAX_SHOPS || "300")
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "50") * 60000

const NAMED: Record<string, string> = { amp: "&", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", quot: '"', apos: "'", hellip: "…", eacute: "é", euro: "€", pound: "£" }
const decode = (t: string) => t.replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16))).replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
  .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? " ")

function textOf(html: string): { title: string, text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim()
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html
  const text = main.replace(/<(script|style|noscript|svg|nav|header|footer|form)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h\d|td|section|br)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
      return { title: decode(title), text: decode(text) }
}

// Page code that slipped through (inline settings, JSON): not policy text.
const CODE = /^(window\.|var |let |const |function|\{|\[)|[{}]\s*["']?\w+["']?\s*:|=>|;\s*$/
// The paragraphs about returns and shipping, in page order.
function relevant(text: string): string {
  const parts = text.split(/\n+/).map(p => p.replace(/\s+/g, " ").trim()).filter(p => p.length >= 30 && p.length <= 1200 && RELEVANT.test(p) && !CODE.test(p))
  let out = ""
  for (const p of [...new Set(parts)]) { if (out.length + p.length > 2500) break; out += (out ? " " : "") + p }
  return out
}

async function shops(): Promise<string[]> {
  if (process.env.DOMAINS) return process.env.DOMAINS.split(",")
  const seeds = JSON.parse(fs.readFileSync("seeds/shops.json", "utf8"))
  const fromSeeds = Object.entries(seeds).filter(([k]) => k !== "_about").flatMap(([, v]) => v as string[])
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain&category=like.shop*&status=is.null&popularity_rank=not.is.null&order=popularity_rank.asc&limit=${MAX_SHOPS}`, { headers: SUPABASE_HEADERS })
  const top: string[] = r.ok ? (await r.json()).map((x: any) => x.domain) : []
  return [...new Set([...top, ...fromSeeds].map(d => d.replace(/^www\./, "")))]
}

async function policyPages(domain: string): Promise<{ path: string, title: string, content: string }[]> {
  const found: { path: string, title: string, content: string }[] = []
  const kinds = new Set<string>()
  for (const [path, kind] of PATHS) {
    if (kinds.has(kind)) continue // one page of each kind is enough
    if (!await robotsAllows(domain, path)) continue
    const r = await fetchPublic(`https://www.${domain}${path}`, { headers: { "User-Agent": USER_AGENT, "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(10000) }).catch(() => null)
    if (!r?.ok || !(r.headers.get("content-type") || "").includes("html")) continue
    // Redirected to the homepage or a search page: not a policy page.
    const landed = new URL(r.url)
    if (landed.pathname === "/" || /search|404|not-found/i.test(landed.pathname)) continue
    // Another host (a help-centre subdomain, another country's shop): its links wouldn't be this site's.
    if (landed.hostname.replace(/^www\./, "") !== domain) continue
    const { title, text } = textOf((await r.text()).slice(0, 1_000_000))
    const content = relevant(text)
    if (content.length < 150) continue
    found.push({ path: landed.pathname, title: title.slice(0, 120) || (kind === "returns" ? "Returns" : "Shipping"), content })
    kinds.add(kind)
    await new Promise(res => setTimeout(res, 1000))
  }
  return found
}

async function main() {
  const started = Date.now()
  const list = await shops()
  console.log(`${list.length} shops`)
  let saved = 0, withPolicy = 0
  for (const domain of list) {
    if (Date.now() - started > TIME_BUDGET_MS || (!process.env.DRY_RUN && await searchNeedsTheDatabase())) break
    const pages = await policyPages(domain).catch(() => [])
    if (!pages.length) continue
    withPolicy++
    for (const p of pages) {
      if (process.env.DRY_RUN) { console.log(`${domain}${p.path} | ${p.title} | ${p.content.slice(0, 160)}…`); continue }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_pages?on_conflict=full_url`, {
        method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ domain, path: p.path, full_url: `${domain}${p.path}`, title: p.title, content: p.content, actions: [], updated_at: new Date().toISOString() })
      }).catch(() => null)
      if (r?.ok) saved++
    }
  }
  console.log(`${withPolicy} shops with policy pages, ${saved} pages saved`)
}

main().catch(e => { console.error(e); process.exit(1) })
