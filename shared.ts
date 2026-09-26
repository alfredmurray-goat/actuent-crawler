import { complete } from "./llm"
import crypto from "crypto"
import { USER_AGENT, robotsAllows } from "./robots"

export { robotsAllows }

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
    const r = await fetch(`https://${domain}`, { headers: { "User-Agent": USER_AGENT, "Accept": "text/html" }, signal: AbortSignal.timeout(8000) })
    if (r.ok && (r.headers.get("content-type") || "").includes("html")) {
      const raw = (await r.text()).slice(0, 400_000)
      const text = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      if (text.length >= 300) return { text: text.slice(0, 3000), raw, isHtml: true }
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
    return { text: cleanScraped(raw).slice(0, 3000), raw, isHtml: false }
  } catch { return null }
}

// A site's own LAWP from https://<domain>/.well-known/lawp.json always wins over crawling.
export async function fetchNative(domain: string): Promise<any | null> {
  try {
    const r = await fetch(`https://${domain}/.well-known/lawp.json`, {
      headers: { "Accept": "application/json", "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(5000)
    })
    if (!r.ok) return null
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
    const r = await fetch(`https://${domain}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(8000)
    })
    if (!r.ok) return null
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

export async function toLAWP(domain: string, content: string): Promise<any> {
  const raw = await complete(`Convert to LAWP JSON.\n\nDomain: ${domain}\nContent: ${content.slice(0, 2000)}\n\nWrite every title, summary, description and intent in English, translating if the site is in another language. Set "language" to the ISO 639-1 code of the site's original language.\n\nReturn ONLY valid JSON:\n{"domain":"${domain}","name":"Name","language":"en","pages":{"/":{"title":"T","content":"Summary under 100 words"}},"actions":[{"id":"id","name":"N","description":"D","intent":["k1","k2","k3"],"input":{"type":"text","required":false}}]}\n\nInclude 2-4 real actions only.`)
  if (!raw) return minimal(domain, content)
  let parsed: any = null
  try { parsed = JSON.parse(raw) } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) { try { parsed = JSON.parse(m[0]) } catch {} }
  }
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

export async function saveSite(site: any, hash?: string, conversion?: "native" | "llm" | "heuristic" | "minimal"): Promise<void> {
  const base = { domain: site.domain, name: site.name, pages: site.pages, actions: site.actions, updated_at: new Date().toISOString() }
  const lang = site.language ? { language: site.language } : {}
  // Newest schema first; older databases lack native (lawp_actions.sql) or content_hash (groq_quota.sql).
  const extras = { ...(site.business ? { business: site.business } : {}) }
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
export async function saveEvents(domain: string, events: { url: string, start_date: string }[]): Promise<void> {
  if (!events.length) return
  const now = new Date().toISOString()
  const unique = events.filter((e, i) => events.findIndex(x => x.url === e.url && x.start_date === e.start_date) === i)
  await fetch(`${SUPABASE_URL}/rest/v1/lawp_events?on_conflict=url,start_date`, {
    method: "POST",
    headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify(unique.map(e => ({ lat: null, lon: null, end_date: null, description: null, venue: null, city: null, country: null, price: null, currency: null, ...e, domain, updated_at: now })))
  }).catch(() => {})
}
