import { complete } from "./llm"
import crypto from "crypto"
import { USER_AGENT, robotsAllows } from "./robots"
import { fetchPublic } from "./safe-fetch"
import { cleanPageText } from "./boilerplate"

export { robotsAllows }

// A malformed response from one site can trip an internal assertion in Node's built-in fetch
// (undici) outside any try/catch. Log it and keep the job going instead of losing the whole run.
process.on("uncaughtException", (e: any) => {
  if (e?.code === "ERR_ASSERTION" && /undici/.test(String(e?.stack))) { console.log(`ignored fetch parser error: ${e.message}`); return }
  console.error(e)
  process.exit(1)
})

// Helpers shared by crawl.ts (mass crawl) and reconvert.ts (improving minimal entries).

export const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
export const SUPABASE_HEADERS = {
  "apikey": SUPABASE_SERVICE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`
}

// Hash of scraped content: when a site hasn't changed, its existing LAWP is reused and no LLM
// tokens are spent.
export function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 32)
}

// Turns scraped text (Jina Reader markdown or stripped HTML) into a plain readable snippet:
// drops Jina's "Title:/URL Source:/Markdown Content:" header lines, images, link targets and markdown.
export function cleanScraped(text: string): string {
  return String(text || "")
    .replace(/^(Title|URL Source|Published Time|Warning|Markdown Content):.*$/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*_>`|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export type Fetched = { text: string, raw: string, isHtml: boolean }

// The homepage as raw HTML (forms, links, meta tags: best for the rule-based converter), falling
// back to Jina Reader markdown for blocked or JavaScript-only sites. `text` is clean text for the LLM.
export async function fetchSite(domain: string): Promise<Fetched | null> {
  try {
    // Security: public addresses only, each redirect checked (safe-fetch.ts).
    const r = await fetchPublic(`https://${domain}`, { headers: { "User-Agent": USER_AGENT, "Accept": "text/html" }, signal: AbortSignal.timeout(8000) })
    if (r?.ok && (r.headers.get("content-type") || "").includes("html")) {
      const raw = (await r.text()).slice(0, 400_000)
      const text = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<svg[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()
      // Cookie banners, menus and copyright lines out: the LLM reads less and gets the real content.
      if (text.length >= 300) return { text: cleanPageText(text).slice(0, 3000), raw, isHtml: true }
    }
  } catch {}
  try {
    const r = await fetch(`https://r.jina.ai/https://${domain}`, {
      headers: { "Accept": "text/plain", ...(process.env.JINA_API_KEY ? { "Authorization": `Bearer ${process.env.JINA_API_KEY}` } : {}) },
      signal: AbortSignal.timeout(15000)
    })
    if (!r.ok) return null
    const raw = (await r.text()).slice(0, 100_000)
    if (raw.length < 50) return null
    return { text: cleanPageText(cleanScraped(raw)).slice(0, 3000), raw, isHtml: false }
  } catch { return null }
}

// A site's own LAWP from https://<domain>/.well-known/lawp.json always wins over crawling.
// Where a site's LAWP is: /.well-known/lawp.json, or (for sites that can't publish files there:
// Squarespace, Wix, Webflow…) the file its homepage points to with <link rel="lawp" href="…">,
// e.g. Actuent's hosted copy at api.actuent.ai/lawp/<domain>.json.
async function lawpLink(domain: string): Promise<string | null> {
  const r = await fetchPublic(`https://${domain}/`, { headers: { "Accept": "text/html", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(6000) }).catch(() => null)
  if (!r?.ok) return null
  const head = (await r.text()).slice(0, 200_000).match(/<head[\s\S]*?<\/head>/i)?.[0] || ""
  const tag = head.match(/<link[^>]+rel=["']lawp["'][^>]*>/i)?.[0]
  const href = tag?.match(/href=["']([^"']+)["']/i)?.[1]
  if (!href) return null
  try {
    const u = new URL(href, `https://${domain}/`)
    const site = domain.replace(/^www\./, "")
    // Only the site's own host, or Actuent's hosted copy of this same site.
    if (u.protocol !== "https:") return null
    if (u.hostname.replace(/^www\./, "") === site || u.hostname.endsWith(`.${site}`)) return u.href
    if (u.hostname === "api.actuent.ai" && u.pathname === `/lawp/${site}.json`) return u.href
  } catch {}
  return null
}

export async function fetchNative(domain: string): Promise<any | null> {
  try {
    // No redirects: a LAWP file must be served from the site itself.
    let r = await fetchPublic(`https://${domain}/.well-known/lawp.json`, {
      headers: { "Accept": "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(5000)
    }, 0)
    if (!r?.ok) {
      const linked = await lawpLink(domain).catch(() => null)
      if (!linked) return null
      r = await fetchPublic(linked, { headers: { "Accept": "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(5000) }, 0)
    }
    if (!r?.ok) return null
    const text = await r.text()
    if (text.length > 200_000) return null
    const doc = JSON.parse(text)
    if (!doc?.pages || typeof doc.pages !== "object" || Array.isArray(doc.pages) || !Object.keys(doc.pages).length || !Array.isArray(doc.actions)) return null
    return { domain, name: typeof doc.name === "string" && doc.name ? doc.name : domain, pages: doc.pages, actions: doc.actions, native: true }
  } catch { return null }
}

export async function scrapeJina(domain: string): Promise<string | null> {
  try {
    const r = await fetch(`https://r.jina.ai/https://${domain}`, {
      headers: { "Accept": "text/plain", ...(process.env.JINA_API_KEY ? { "Authorization": `Bearer ${process.env.JINA_API_KEY}` } : {}) },
      signal: AbortSignal.timeout(12000)
    })
    if (!r.ok) return null
    const t = await r.text()
    return t && t.length > 50 ? t.slice(0, 3000) : null
  } catch { return null }
}

export async function scrapeBasic(domain: string): Promise<string | null> {
  try {
    const r = await fetchPublic(`https://${domain}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(8000)
    })
    if (!r?.ok) return null
    const html = await r.text()
    return html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,3000)
  } catch { return null }
}

export function minimal(domain: string, content: string = ""): any {
  const name = domain.split(".")[0]
  return {
    domain,
    name: name.charAt(0).toUpperCase() + name.slice(1),
    pages: { "/": { title: domain, content: cleanScraped(content).slice(0, 200) || `Website at ${domain}` } },
    actions: []
  }
}

function parseJson(raw: string): any {
  try { return JSON.parse(raw) } catch {}
  const m = raw.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  return null
}

// Full LLM conversion: only for sites where the rule-based converter found no actions. The prompt
// and output are kept short, because free-tier quota is counted in tokens (in and out).
export async function toLAWP(domain: string, content: string): Promise<any> {
  const raw = await complete(`Convert this website to LAWP JSON.\nDomain: ${domain}\nContent: ${content.slice(0, 1600)}\n\nAll text in English (translate if needed). "language" = ISO 639-1 code of the site's own language. Summary: what the site offers and for whom, naming its category (e.g. "accounting software", "Italian restaurant"), under 60 words. 2-4 real actions a visitor can take, each with 3-5 English intent keywords.\n\nJSON only:\n{"domain":"${domain}","name":"Name","language":"en","pages":{"/":{"title":"T","content":"Summary"}},"actions":[{"id":"id","name":"N","description":"D","intent":["k1","k2","k3"],"input":{"type":"text","required":false}}]}`, 20000, 650)
  if (!raw) return minimal(domain, content)
  const parsed = parseJson(raw)
  const pages = parsed?.pages
  if (!pages || typeof pages !== "object" || Array.isArray(pages) || Object.keys(pages).length === 0) {
    console.log(`llm: unusable LAWP for ${domain}: ${raw.replace(/\s+/g, " ").slice(0, 160)}`)
    return minimal(domain, content)
  }
  if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) console.log(`llm: no actions for ${domain}`)
  return {
    domain,
    name: typeof parsed.name === "string" && parsed.name ? parsed.name : minimal(domain).name,
    pages,
    actions: Array.isArray(parsed.actions) ? parsed.actions : [],
    language: typeof parsed.language === "string" && /^[a-z]{2}$/i.test(parsed.language) ? parsed.language.toLowerCase() : undefined
  }
}

const CATEGORY_IDS = "restaurant, cafe, bar, bakery, food_delivery, hair_beauty, spa_wellness, fitness, health, dental, hotel, travel, events, museum_culture, shop_fashion, shop_beauty, shop_electronics, shop_home, shop_grocery, shop_sports, shop_kids, shop, software, developer, ai, news_media, education, finance, real_estate, legal, automotive, home_services, pets, jobs, nonprofit, government, social, games, streaming, adult, gambling"

// Hybrid conversion: the rule-based converter already found the site's real actions (with real
// URLs); the LLM only writes what rules can't: the name, an English summary naming the category,
// and search keywords per action. About a third of the tokens of a full conversion, so the free
// quota covers ~3x more sites. Returns null when no LLM answered (the caller keeps the rules).
export async function enrichLAWP(domain: string, rules: any, content: string): Promise<any | null> {
  const actions: any[] = Array.isArray(rules?.actions) ? rules.actions : []
  if (!actions.length) return null
  const raw = await complete(`Website: ${domain}\nActions found on it: ${actions.map(a => `${a.id} (${a.name})`).join(", ")}\nContent: ${content.slice(0, 1400)}\n\nReply with JSON only, all text in English (translate if needed):\n{"name":"the brand or business name","language":"ISO 639-1 code of the site's own language","summary":"what the site offers and for whom, naming its category (e.g. 'accounting software', 'Italian restaurant in Lyon'), under 50 words","keywords":{"<action id>":["3-5 search words people would use for this action on this site"]},"category":"one of: ${CATEGORY_IDS}"}`, 20000, 300)
  const parsed = raw ? parseJson(raw) : null
  if (!parsed || typeof parsed.summary !== "string" || parsed.summary.length < 20) return null
  const language = typeof parsed.language === "string" && /^[a-z]{2}$/i.test(parsed.language) ? parsed.language.toLowerCase() : rules.language
  const name = typeof parsed.name === "string" && parsed.name.trim() && parsed.name.length <= 80 ? parsed.name.trim() : rules.name
  const home = rules.pages?.["/"] || {}
  const keywords = parsed.keywords && typeof parsed.keywords === "object" ? parsed.keywords : {}
  // The LLM's category, when it's one of ours: far more reliable than counting words.
  const category = typeof parsed.category === "string" && CATEGORY_IDS.split(", ").includes(parsed.category.trim()) ? parsed.category.trim() : undefined
  return {
    ...rules,
    ...(category ? { category } : {}),
    name,
    language,
    pages: { ...rules.pages, "/": { ...home, title: language && language !== "en" ? name : (home.title || name), content: parsed.summary.trim().slice(0, 500) } },
    actions: actions.map(a => {
      const extra = Array.isArray(keywords[a.id]) ? keywords[a.id].filter((k: unknown) => typeof k === "string" && k.length <= 40).map((k: string) => k.toLowerCase()) : []
      return { ...a, intent: [...new Set([...(a.intent || []), ...extra])].slice(0, 10) }
    })
  }
}

export async function saveSite(site: any, hash?: string, conversion?: "native" | "llm" | "heuristic" | "minimal"): Promise<void> {
  const base = { domain: site.domain, name: site.name, pages: site.pages, actions: site.actions, updated_at: new Date().toISOString() }
  const lang = site.language ? { language: site.language } : {}
  // Newest schema first; older databases lack native (lawp_actions.sql) or content_hash (groq_quota.sql).
  const extras = { ...(site.business ? { business: site.business } : {}), ...(site.category ? { category: site.category } : {}) }
  const attempts = [
    { ...base, ...lang, native: !!site.native, ...(hash ? { content_hash: hash } : {}), ...(conversion ? { conversion } : {}), ...extras },
    { ...base, ...lang, native: !!site.native, ...(hash ? { content_hash: hash } : {}), ...(conversion ? { conversion } : {}) },
    { ...base, ...lang, native: !!site.native, ...(hash ? { content_hash: hash } : {}) },
    { ...base, native: !!site.native },
    base
  ]
  let lastError = ""
  for (const body of attempts) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?on_conflict=domain`, {
      method: "POST",
      headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify(body)
    })
    if (r.ok) return
    lastError = await r.text()
  }
  throw new Error(lastError)
}


// Upcoming events found on a site (schema.org Event). Needs lawp_events (next_list.sql).
// To keep the table small: descriptions are cut to about 240 characters (at a sentence or word), library
// events are kept only for the next 6 weeks (there are thousands, and the readers run again daily) and
// everything else for the next 6 months.
export function shortDescription(d: unknown, max = 240): string | null {
  const t = String(d ?? "").replace(/\s+/g, " ").trim()
  if (t.length <= max) return t || null
  const cut = t.slice(0, max)
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "))
  return end > max * 0.5 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max)}…`
}
export async function saveEvents(domain: string, events: { url: string, start_date: string, description?: string | null }[]): Promise<void> {
  const soon = Date.now() + 42 * 86400000, later = Date.now() + 183 * 86400000
  events = events.filter(e => { const t = Date.parse(e.start_date); return !t || t < (/library/i.test(String(e.description || "")) ? soon : later) })
  if (!events.length) return
  const now = new Date().toISOString()
  const unique = events.filter((e, i) => events.findIndex(x => x.url === e.url && x.start_date === e.start_date) === i)
    .map(e => ({ ...e, description: shortDescription(e.description) }))
  await fetch(`${SUPABASE_URL}/rest/v1/lawp_events?on_conflict=url,start_date`, {
    method: "POST",
    headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify(unique.map(e => ({ lat: null, lon: null, end_date: null, description: null, venue: null, city: null, country: null, price: null, currency: null, ...e, domain, updated_at: now })))
  }).catch(() => {})
}
