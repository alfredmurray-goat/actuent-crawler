import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { complete } from "./llm"
import { CATEGORIES } from "./category"
import { searchNeedsTheDatabase } from "./quiet"

// Nightly: the AI re-checks the category of the best-known sites, a few thousand a night, until all
// 20,000 are done (then it starts over, a month later). The rule-based categoriser gets big sites
// wrong (Airbnb as "software", localilabs as "jobs"), and a wrong category hurts ranking, similar
// sites and the category filter. Sites claimed by their owners are left alone.
// Progress is kept in crawler_state (id "recategorize_rank").

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
const PER_NIGHT = parseInt(process.env.RECATEGORIZE_LIMIT || "2000")
const TOP = 20000
const BATCH = 25
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "90") * 60000
const IDS = Object.keys(CATEGORIES)
const JSON_HEADERS = { ...SUPABASE_HEADERS, "Content-Type": "application/json" }

async function state(): Promise<number> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/crawler_state?id=eq.recategorize_rank&select=value`, { headers: SUPABASE_HEADERS }).catch(() => null)
  const rows = r?.ok ? await r.json() : []
  return Number(rows?.[0]?.value) || 0
}
async function setState(value: number) {
  await fetch(`${SUPABASE_URL}/rest/v1/crawler_state?on_conflict=id`, { method: "POST", headers: { ...JSON_HEADERS, "Prefer": "resolution=merge-duplicates" }, body: JSON.stringify({ id: "recategorize_rank", value }) }).catch(() => {})
}

const summary = (s: any) => {
  const home: any = Object.values(s.pages || {})[0] || {}
  return `${home.title || ""}. ${home.content || ""}`.replace(/\s+/g, " ").slice(0, 220)
}

async function classify(sites: any[]): Promise<Record<string, string>> {
  const prompt = `Pick the one category that best describes what each website IS (what a visitor goes there for), from this list: ${IDS.join(", ")}.
Use "shop" only for general stores, "software" for apps and online tools, "news_media" for publishers, "travel" for booking trips and stays. Infrastructure, ad and CDN domains: "developer".
Reply with JSON only: {"categories": {"domain": "category", ...}}

${sites.map(s => `${s.domain} | ${s.name || ""} | ${summary(s)}`).join("\n")}`
  const answer = await complete(prompt, 30000, 900)
  try {
    const parsed = JSON.parse(String(answer || "").replace(/^[^{]*/, "").replace(/[^}]*$/, ""))
    const out: Record<string, string> = {}
    for (const [d, c] of Object.entries(parsed.categories || {})) if (typeof c === "string" && IDS.includes(c)) out[d.toLowerCase()] = c
    return out
  } catch { return {} }
}

// DOMAINS="a.com b.com": re-check just these (for sites outside the top 20,000).
async function named(domains: string[]) {
  const list = encodeURIComponent(domains.map(d => `"${d}"`).join(","))
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,name,pages,category&domain=in.(${list})`, { headers: SUPABASE_HEADERS })
  const sites: any[] = r.ok ? await r.json() : []
  const picked = await classify(sites)
  for (const s of sites) {
    const c = picked[s.domain]
    if (!c || c === s.category) { console.log(`  ${s.domain}: ${s.category || "(none)"} (kept)`); continue }
    await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(s.domain)}`, { method: "PATCH", headers: { ...JSON_HEADERS, "Prefer": "return=minimal" }, body: JSON.stringify({ category: c }) }).catch(() => {})
    console.log(`  ${s.domain}: ${s.category || "(none)"} → ${c}`)
  }
}

async function main() {
  const start = Date.now()
  if (process.env.DOMAINS) return named(process.env.DOMAINS.split(/[\s,]+/).filter(Boolean).slice(0, 25))
  let from = await state()
  if (from >= TOP) from = 0
  console.log(`Re-checking categories from popularity rank ${from + 1}`)
  let checked = 0, changed = 0
  while (checked < PER_NIGHT && Date.now() - start < TIME_BUDGET_MS && !await searchNeedsTheDatabase()) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,name,pages,category,popularity_rank&status=is.null&owner_key=is.null&popularity_rank=gt.${from}&popularity_rank=lte.${TOP}&order=popularity_rank.asc&limit=${BATCH}`, { headers: SUPABASE_HEADERS })
    const sites: any[] = r.ok ? await r.json() : []
    if (!sites.length) { from = TOP; break }
    const picked = await classify(sites)
    if (!Object.keys(picked).length) { console.log("The AI didn't answer (quota?); stopping for tonight"); break }
    for (const s of sites) {
      const c = picked[s.domain]
      if (!c || c === s.category) continue
      await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(s.domain)}`, { method: "PATCH", headers: { ...JSON_HEADERS, "Prefer": "return=minimal" }, body: JSON.stringify({ category: c }) }).catch(() => {})
      console.log(`  ${s.domain}: ${s.category || "(none)"} → ${c}`)
      changed++
    }
    checked += sites.length
    from = sites[sites.length - 1].popularity_rank
    await setState(from)
  }
  await setState(from)
  console.log(`Done: ${checked} sites checked, ${changed} categories changed, next time from rank ${from + 1}`)
}

main().catch(e => { console.error(e); process.exit(1) })
