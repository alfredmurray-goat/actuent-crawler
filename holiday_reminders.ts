import { SUPABASE_URL, SUPABASE_HEADERS, SUPABASE_SERVICE_KEY } from "./shared"
import { sendEmail, esc, emailEnabled, lawpyImg } from "./email"
import crypto from "crypto"

// Weekly (Mondays): a week or so before a public holiday, owners of claimed sites whose opening
// hours don't cover it yet get a reminder, so AI assistants don't tell people they're open when
// they're closed (or the other way round). Holidays from Nager.Date, by the site's country.

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
const COUNTRY: Record<string, string> = { denmark: "DK", danmark: "DK", sweden: "SE", sverige: "SE", norway: "NO", norge: "NO", germany: "DE", deutschland: "DE", "united kingdom": "GB", uk: "GB", netherlands: "NL", france: "FR", spain: "ES", italy: "IT", finland: "FI", ireland: "IE", "united states": "US", usa: "US" }

// Same token as api.actuent.ai/api/unsubscribe checks (as in score_emails.ts).
const unsubscribeToken = (domain: string) => crypto.createHmac("sha256", SUPABASE_SERVICE_KEY).update(`score-emails:${domain}`).digest("hex").slice(0, 32)

async function get(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS })
  return r.ok ? r.json() : []
}
const holidays = new Map<string, any[]>()
async function upcoming(cc: string): Promise<any[]> {
  if (!holidays.has(cc)) holidays.set(cc, await fetch(`https://date.nager.at/api/v3/NextPublicHolidays/${cc}`, { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : []).catch(() => []))
  return holidays.get(cc)!
}

async function main() {
  if (!emailEnabled) { console.log("RESEND_API_KEY isn't set — skipping"); return }
  const sites = await get("lawp_sites?select=domain,name,owner_key,business,score_emails&owner_key=not.is.null&business=not.is.null&limit=1000")
  let sent = 0
  for (const site of sites) {
    if (site.score_emails === false || !site.business?.opening_hours?.length) continue
    const raw = String(site.business?.address?.country || "").trim()
    const cc = raw.length === 2 ? raw.toUpperCase() : COUNTRY[raw.toLowerCase()]
    if (!cc) continue
    const soon = (await upcoming(cc)).filter((h: any) => { const days = (Date.parse(h.date) - Date.now()) / 86400000; return days >= 4 && days <= 11 })
    const covered = (h: any) => (site.business.special_hours || []).some((x: any) => x.from <= h.date && x.to >= h.date)
    const missing = soon.filter((h: any) => !covered(h))
    if (!missing.length) continue
    const [account] = await get(`api_keys?select=email&key_hash=eq.${site.owner_key}`)
    if (!account?.email) continue
    const unsubscribe = `https://api.actuent.ai/api/unsubscribe?domain=${encodeURIComponent(site.domain)}&token=${unsubscribeToken(site.domain)}`
    const list = missing.map((h: any) => `${esc(h.localName || h.name)} (${new Date(h.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })})`)
    const html = `${lawpyImg("think")}<p>Hi,</p>
<p>${list.length === 1 ? "A public holiday is" : "Public holidays are"} coming up: <strong>${list.join(", ")}</strong>.</p>
<p>AI assistants read <strong>${esc(site.name || site.domain)}</strong>'s opening hours from your site, and they don't cover ${list.length === 1 ? "this day" : "these days"} yet. If your hours are different, add them as holiday hours (schema.org <code>specialOpeningHoursSpecification</code>, or in <a href="https://analytics.actuent.ai/?edit=${encodeURIComponent(site.domain)}">the Actuent editor</a>), so nobody is sent to a closed door.</p>
<p style="color:#666;font-size:13px">Actuent, made by localilabs. You get this because you claimed ${esc(site.domain)} on Actuent. <a href="${unsubscribe}">Unsubscribe</a></p>`
    if (await sendEmail(account.email, `${site.domain}: holiday hours for ${missing[0].localName || missing[0].name}?`, html, { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" })) sent++
  }
  console.log(`Holiday reminders: ${sent} sent (${sites.length} claimed sites with business details)`)
}

main().catch(e => { console.error(e); process.exit(1) })
