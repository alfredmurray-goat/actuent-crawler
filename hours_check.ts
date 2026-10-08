import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { fetchPublic } from "./safe-fetch"
import { extractBusiness, OpeningHours } from "./business"

// Weekly: are the opening hours Actuent gives for places still what the places themselves say?
// 200 places with hours (best-known first, a different 200 each week) get their homepage read again;
// when the site's own hours (schema.org) differ from what's stored, the site's version is saved, and
// special hours (holidays, "closed for renovation") come along. A report shows how often they differed,
// so "open now" accuracy can be followed over time. Claimed sites are never changed (the owner decides).
// DRY_RUN=1 only reports.

const DRY = !!process.env.DRY_RUN
const COUNT = parseInt(process.env.COUNT || "200")
const UA = "Mozilla/5.0 (compatible; Actuent/1.0; +https://docs.actuent.ai/bot)"
const week = Math.floor(Date.now() / (7 * 86400000))

const norm = (h: OpeningHours[] | undefined) => JSON.stringify((h || []).map(x => `${[...x.days].sort().join(",")} ${x.opens}-${x.closes}`).sort())

async function main() {
  // A different slice of the best-known places each week (cycling through the first 4,000).
  const offset = (week % 20) * COUNT
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,business,owner_key&status=is.null&business->opening_hours=not.is.null&popularity_rank=not.is.null&order=popularity_rank.asc&limit=${COUNT}&offset=${offset}`, { headers: SUPABASE_HEADERS })
  if (!r.ok) { console.error(`Couldn't load places: ${r.status} ${await r.text()}`); process.exit(1) }
  const sites: any[] = await r.json()
  let read = 0, same = 0, differ = 0, noHours = 0, failed = 0, updated = 0
  const examples: string[] = []
  let i = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < sites.length) {
      const s = sites[i++]
      const res = await fetchPublic(`https://${s.domain}/`, { headers: { "User-Agent": UA, "Accept": "text/html" }, signal: AbortSignal.timeout(12000) }).catch(() => null)
      if (!res?.ok) { failed++; continue }
      const fresh = extractBusiness((await res.text().catch(() => "")).slice(0, 1_500_000))
      read++
      if (!fresh?.opening_hours?.length) { noHours++; continue }
      if (norm(fresh.opening_hours) === norm(s.business.opening_hours)) { same++; continue }
      differ++
      if (examples.length < 15) examples.push(`${s.domain}: stored ${norm(s.business.opening_hours)} → site says ${norm(fresh.opening_hours)}`)
      if (DRY || s.owner_key) continue
      const business = { ...s.business, opening_hours: fresh.opening_hours, ...(fresh.special_hours?.length ? { special_hours: fresh.special_hours } : {}), hours_checked_at: new Date().toISOString() }
      const u = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(s.domain)}`, { method: "PATCH", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ business }) }).catch(() => null)
      if (u?.ok) updated++
    }
  }))
  for (const e of examples) console.log(e)
  const checked = same + differ
  console.log(`${sites.length} places: ${read} read (${failed} didn't answer), ${noHours} no longer publish hours on the homepage, ${same} same, ${differ} different${checked ? ` → ${Math.round((same / checked) * 100)}% matched` : ""}; ${updated} updated${DRY ? " (dry run)" : ""}`)
}

main().catch(e => { console.error(e); process.exit(1) })
