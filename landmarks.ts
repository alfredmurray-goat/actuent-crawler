import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { parseOpeningHoursText } from "./business"

// Famous museums, galleries and attractions often have no address or opening hours on their own site's
// front page, so "museums open today in London" couldn't place them in London or say they're open.
// OpenStreetMap usually has both: look each one up by name, and only take it when OpenStreetMap lists
// the same website (so the British Museum never gets another museum's hours). One lookup a second
// (Nominatim's policy). Weekly; DRY_RUN=1 only prints.

const CATEGORIES = ["museum_culture", "attractions", "entertainment", "travel"]
const LIMIT = parseInt(process.env.LANDMARK_LIMIT || "400")
const UA = "ActuentBot/1.0 (https://docs.actuent.ai/bot; support@localilabs.com)"
const bare = (u: string) => { try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "") } catch { return "" } }

async function main() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,name&business=is.null&status=is.null&category=in.(${CATEGORIES.join(",")})&popularity_rank=not.is.null&order=popularity_rank.asc&limit=${LIMIT}`, { headers: SUPABASE_HEADERS })
  const sites: any[] = r.ok ? await r.json() : []
  console.log(`${sites.length} well-known places without an address`)
  let filled = 0
  for (const s of sites) {
    const name = String(s.name || "").replace(/\s*[|–—-].*$/, "").trim()
    if (name.length < 3) continue
    const site = s.domain.replace(/^www\./, "")
    const same = (x: any) => { const w = bare(x.extratags?.website || x.extratags?.["contact:website"] || ""); return w && (w === site || w.endsWith(`.${site}`) || site.endsWith(`.${w}`)) }
    // The name as the site gives it, then without "The" ("The British Museum" → "British Museum").
    let p: any = null
    for (const q of [...new Set([name, name.replace(/^the\s+/i, "")])]) {
      await new Promise(res => setTimeout(res, 1100))
      const found: any[] = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=5&extratags=1&addressdetails=1`, { headers: { "User-Agent": UA, "Accept-Language": "en" }, signal: AbortSignal.timeout(10000) }).then(x => x.ok ? x.json() : []).catch(() => [])
      p = found.find(same)
      if (p) break
    }
    if (!p) continue
    const a = p.address || {}
    const hours = p.extratags?.opening_hours ? parseOpeningHoursText(p.extratags.opening_hours) : []
    const business = {
      type: String(p.type || p.category || "").replace(/_/g, " ") || "attraction", name: p.name || s.name,
      address: { street: [a.house_number, a.road].filter(Boolean).join(" ") || undefined, city: a.city || a.town || a.village || a.municipality, postcode: a.postcode, country: String(a.country_code || "").toUpperCase() || undefined },
      geo: { lat: Number(p.lat), lon: Number(p.lon) },
      ...(hours.length ? { opening_hours: hours } : {}),
      ...(p.extratags?.phone ? { telephone: p.extratags.phone } : {}),
      source: "OpenStreetMap"
    }
    if (process.env.DRY_RUN) { console.log(`${s.domain}: ${business.address.city} · ${hours.length ? p.extratags.opening_hours : "no hours"}`); filled++; continue }
    const u = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(s.domain)}`, { method: "PATCH", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ business }) }).catch(() => null)
    if (u?.ok) filled++
  }
  console.log(`${filled} places got an address${process.env.DRY_RUN ? " (dry run)" : ""} and, where OpenStreetMap has them, opening hours`)
}

main().catch(e => { console.error(e); process.exit(1) })
