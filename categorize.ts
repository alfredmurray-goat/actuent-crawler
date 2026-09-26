import { categorize } from "./category"

// Sets lawp_sites.category for sites without one (rule-based, no LLM). Only the category column is
// written — never updated_at — so it doesn't disturb the reconvert job's order. Sites that can't be
// categorised yet (minimal entries) get "" and are retried in a second pass every run, since the
// reconvert job keeps turning minimal entries into full ones.

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const KEY = process.env.SUPABASE_SERVICE_KEY!
const HEADERS = { "apikey": KEY, "Authorization": `Bearer ${KEY}` }
const LIMIT = parseInt(process.env.CATEGORIZE_LIMIT || "100000")
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "60") * 60000

if (!KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

const start = Date.now()
const tally: Record<string, number> = {}

async function pass(recheck: boolean): Promise<number> {
  let done = 0, lastDomain = ""
  while (done < LIMIT && Date.now() - start < TIME_BUDGET_MS) {
    // Keyset pagination by domain; uncategorised rows, or "" rows when rechecking.
    const filter = recheck ? "category=eq." : "category=is.null"
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,name,pages,actions,business&${filter}&domain=gt.${encodeURIComponent(lastDomain)}&order=domain.asc&limit=500`, { headers: HEADERS })
    if (!r.ok) { console.log(`Could not load sites: ${r.status} ${await r.text()}`); break }
    const rows: any[] = await r.json()
    if (!rows.length) break
    lastDomain = rows[rows.length - 1].domain
    // Group by category so each group is one PATCH.
    const groups = new Map<string, string[]>()
    for (const row of rows) {
      const cat = categorize(row) ?? ""
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat)!.push(row.domain)
      tally[cat || "(none yet)"] = (tally[cat || "(none yet)"] || 0) + 1
    }
    for (const [cat, domains] of groups) {
      if (recheck && !cat) continue
      for (let i = 0; i < domains.length; i += 100) {
        const list = encodeURIComponent(domains.slice(i, i + 100).map(d => `"${d}"`).join(","))
        await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=in.(${list})`, {
          method: "PATCH", headers: { ...HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ category: cat })
        })
      }
    }
    done += rows.length
    if (done % 5000 < 500) console.log(`${recheck ? "recheck" : "new"}: ${done} sites`)
  }
  return done
}

async function main() {
  const fresh = await pass(false)
  const rechecked = await pass(true)
  console.log(`Done: ${fresh} new and ${rechecked} rechecked sites in ${Math.round((Date.now() - start) / 60000)} min`)
  console.log(Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", "))
}

main().catch(e => { console.error(e); process.exit(1) })
