import fs from "fs"
import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { complete } from "./llm"

// Nightly: pre-computes search expansions (English translation + related terms) for the searches
// most likely to come in — real top searches, the benchmark, common topics and "category in city"
// — and stores them in query_expansions, which live search reads first. Launch-day searches then
// rarely need a live LLM call. Uses the crawler's models, capped per night (WARM_LIMIT) so the
// backlog job keeps most of the quota. Same prompt and key format as locali_public/src/utils/search.ts.

const LIMIT = parseInt(process.env.WARM_LIMIT || "300")
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "40") * 60000
if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

const TOPICS = ["running shoes", "sneakers", "winter jacket", "headphones", "laptop", "smartphone", "coffee beans", "skincare", "furniture", "mattress", "baby monitor",
  "project management software", "accounting software", "crm software", "email marketing", "website builder", "online store platform", "password manager",
  "video conferencing", "note taking app", "design tool", "online payments", "invoicing", "payroll", "cloud hosting", "domain names", "vpn", "ai assistant",
  "cheap flights", "hotel booking", "car rental", "train tickets", "concert tickets", "football tickets", "theatre tickets", "food delivery", "recipes",
  "language course", "online course", "jobs", "apartments for rent", "insurance", "bank account", "credit card", "news", "weather", "music streaming", "podcasts"]
const LOCAL = ["restaurant", "italian restaurant", "sushi", "pizza", "vegan restaurant", "cafe", "coffee", "brunch", "bar", "cocktail bar", "bakery", "hotel",
  "barber", "hairdresser", "nail salon", "dentist", "doctor", "pharmacy", "gym", "yoga", "spa", "massage", "supermarket", "bookshop", "florist", "museum", "things to do"]
const CITIES = ["london", "copenhagen", "amsterdam", "berlin", "paris", "new york", "stockholm", "oslo", "dublin", "manchester", "barcelona", "madrid",
  "lisbon", "rome", "munich", "vienna", "san francisco", "los angeles", "chicago", "toronto", "sydney"]

const key = (q: string) => q.toLowerCase().trim()

async function topSearches(): Promise<string[]> {
  const since = encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())
  const r = await fetch(`${SUPABASE_URL}/rest/v1/searches?select=query&created_at=gte.${since}&order=created_at.desc&limit=20000`, { headers: SUPABASE_HEADERS })
  const rows: any[] = r.ok ? await r.json() : []
  const counts = new Map<string, number>()
  for (const { query } of rows) {
    const q = key(String(query || ""))
    // Keyword searches only (domains are never expanded), plain words, no personal details.
    if (!q || q.length > 60 || /[@/:]|\d{4,}|^\[object |^\S+\.[a-z]{2,}$/.test(q) || q.split(/\s+/).length > 8) continue
    counts.set(q, (counts.get(q) || 0) + 1)
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 500).map(([q]) => q)
}

async function missing(queries: string[]): Promise<string[]> {
  const since = encodeURIComponent(new Date(Date.now() - 25 * 86400000).toISOString())
  const have = new Set<string>()
  for (let i = 0; i < queries.length; i += 80) {
    const list = encodeURIComponent(queries.slice(i, i + 80).map(q => `"${q.replace(/"/g, "")}"`).join(","))
    const r = await fetch(`${SUPABASE_URL}/rest/v1/query_expansions?select=query&updated_at=gte.${since}&query=in.(${list})`, { headers: SUPABASE_HEADERS })
    for (const row of r.ok ? await r.json() : []) have.add(row.query)
  }
  return queries.filter(q => !have.has(q))
}

async function main() {
  const started = Date.now()
  const bench: string[] = JSON.parse(fs.readFileSync("bench/queries.json", "utf8")).map((x: any) => x.q).filter((q: string) => !/^\S+\.[a-z]{2,}$/.test(q))
  const candidates = [...new Set([...(await topSearches()), ...bench, ...TOPICS, ...CITIES.flatMap(c => LOCAL.map(l => `${l} ${c}`))].map(key))]
  const todo = (await missing(candidates)).slice(0, LIMIT)
  console.log(`${candidates.length} likely searches, ${todo.length} without a fresh expansion`)
  let saved = 0, failed = 0
  for (const q of todo) {
    if (Date.now() - started > TIME_BUDGET_MS || failed >= 6) break
    const answer = await complete(`A user searched for: "${q}". The search may be in any language. Translate it into English (unchanged if it's already English), then list up to 6 short related English search terms: synonyms, product or service categories, and common alternative words. Reply with JSON only: {"english":"...","terms":["..."]}`, 15000, 200)
    let parsed: any = null
    try { parsed = JSON.parse(String(answer).match(/\{[\s\S]*\}/)?.[0] || "") } catch {}
    if (!parsed || typeof parsed.english !== "string") { failed++; continue }
    failed = 0
    const english = parsed.english.trim() || q
    const words = new Set(english.toLowerCase().split(/\s+/))
    const terms = (Array.isArray(parsed.terms) ? parsed.terms : []).filter((t: unknown) => typeof t === "string").map((t: string) => t.toLowerCase().trim())
      .filter((t: string) => t && t.split(/\s+/).length <= 3 && !words.has(t)).slice(0, 6)
    const r = await fetch(`${SUPABASE_URL}/rest/v1/query_expansions?on_conflict=query`, {
      method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ query: q, english, terms, updated_at: new Date().toISOString() })
    })
    if (r.ok) saved++
  }
  console.log(`Saved ${saved} expansions${failed >= 6 ? " (stopped: no LLM quota left)" : ""}`)
}

main().catch(e => { console.error(e); process.exit(1) })
