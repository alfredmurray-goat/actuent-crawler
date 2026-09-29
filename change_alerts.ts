import crypto from "crypto"
import { SUPABASE_URL, SUPABASE_HEADERS, SUPABASE_SERVICE_KEY, fetchSite } from "./shared"
import { fetchPublic } from "./safe-fetch"
import { extractBusiness } from "./business"
import { sendEmail, esc, emailEnabled } from "./email"
import { USER_AGENT } from "./robots"
import { launchWeekPause } from "./quiet"

// Daily: watches every claimed site's live website (the crawlers never overwrite claimed sites) and
// tells the owner when something important changed since yesterday:
//   • opening hours or holiday hours changed,
//   • an action link (booking, contact, shop) stopped working (error page or not found),
//   • product prices changed (from the products job).
// By email (Resend) and to the webhooks registered for the site. Owners can turn it off
// (lawp_sites.change_alerts, list_seventeen.sql); the one-click unsubscribe stops these too.

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
const JSON_HEADERS = { ...SUPABASE_HEADERS, "Content-Type": "application/json" }

function unsubscribeToken(domain: string): string {
  return crypto.createHmac("sha256", SUPABASE_SERVICE_KEY).update(`score-emails:${domain}`).digest("hex").slice(0, 32)
}
async function get(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS })
  if (!r.ok) throw new Error(`${path.split("?")[0]}: ${r.status} ${await r.text()}`)
  return r.json()
}

// Does this link still work? HEAD first, then GET (some servers refuse HEAD). Redirects are fine.
async function linkWorks(url: string): Promise<boolean> {
  for (const method of ["HEAD", "GET"]) {
    const r = await fetchPublic(url, { method, headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) }).catch(() => null)
    if (r && r.status < 400) return true
    if (r && (r.status === 404 || r.status === 410 || r.status >= 500) && method === "GET") return false
  }
  return true // blocked or unreachable for a moment: not reported as broken
}

const hoursText = (h: any[] | undefined) => (h || []).map(x => `${x.days.join(", ")} ${x.opens}–${x.closes}`).join("; ")
const specialText = (h: any[] | undefined) => (h || []).map(x => `${x.from}${x.to !== x.from ? ` to ${x.to}` : ""}: ${x.closed ? "closed" : `${x.opens}–${x.closes}`}`).join("; ")

async function check(site: any): Promise<string[]> {
  const changes: string[] = []
  const [before] = await get(`site_watch?select=*&domain=eq.${encodeURIComponent(site.domain)}`)
  const page = await fetchSite(site.domain)
  const business = page?.raw ? extractBusiness(page.raw) : null
  const hours = business?.opening_hours || null, special = business?.special_hours || null
  if (before && page) {
    if (hours && hoursText(hours) !== hoursText(before.hours)) changes.push(`Opening hours changed to: ${hoursText(hours)}`)
    if (special && specialText(special) !== specialText(before.special_hours)) changes.push(`Holiday hours: ${specialText(special)}`)
  }
  // Action links (booking pages, contact forms, shop pages) that stopped working.
  const links = [...new Set((site.actions || []).map((a: any) => a.url).filter((u: any) => typeof u === "string" && /^https:\/\//.test(u)))].slice(0, 10) as string[]
  const broken: string[] = []
  for (const url of links) if (!await linkWorks(url)) broken.push(url)
  const newlyBroken = broken.filter(u => !(before?.broken_links || []).includes(u))
  for (const u of newlyBroken) changes.push(`This link now shows an error or "not found", so agents can't send people there: ${u}`)
  // Prices that changed since the last check.
  const since = before?.checked_at || new Date(Date.now() - 86400000).toISOString()
  const priced = await get(`lawp_items?select=name,price,currency,previous_price_eur,price_eur&domain=eq.${encodeURIComponent(site.domain)}&price_changed_at=gte.${encodeURIComponent(since)}&limit=20`).catch(() => [])
  if (priced.length) changes.push(`${priced.length} product price${priced.length === 1 ? "" : "s"} changed: ${priced.slice(0, 5).map((p: any) => `${p.name} (now ${p.price} ${p.currency})`).join(", ")}${priced.length > 5 ? ", …" : ""}`)

  await fetch(`${SUPABASE_URL}/rest/v1/site_watch?on_conflict=domain`, {
    method: "POST", headers: { ...JSON_HEADERS, "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify({ domain: site.domain, hours: hours ?? before?.hours ?? null, special_hours: special ?? before?.special_hours ?? null, broken_links: broken, checked_at: new Date().toISOString() })
  })
  return changes
}

async function notify(site: any, changes: string[]) {
  // Webhooks registered for the site (public https addresses only, no redirects).
  for (const wh of await get(`webhooks?select=url&domain=eq.${encodeURIComponent(site.domain)}`).catch(() => [])) {
    if (!String(wh.url).startsWith("https://")) continue
    await fetchPublic(wh.url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT }, body: JSON.stringify({ event: "site.changed", domain: site.domain, changes, timestamp: new Date().toISOString() }), signal: AbortSignal.timeout(5000) }, 0).catch(() => null)
  }
  if (!emailEnabled || site.score_emails === false) return
  const [account] = await get(`api_keys?select=email&key_hash=eq.${site.owner_key}`)
  if (!account?.email) return
  const unsubscribe = `https://api.actuent.ai/api/unsubscribe?domain=${encodeURIComponent(site.domain)}&token=${unsubscribeToken(site.domain)}`
  const html = `<p>Hi,</p><p>Actuent noticed ${changes.length === 1 ? "a change" : "some changes"} on <strong>${esc(site.domain)}</strong> since yesterday:</p>
<ul>${changes.map(c => `<li>${esc(c)}</li>`).join("")}</ul>
<p>If that's intended, there's nothing to do. If not, it's worth fixing before customers (and their AI assistants) run into it.</p>
<p><a href="https://analytics.actuent.ai/?edit=${encodeURIComponent(site.domain)}">Edit what agents see →</a></p>
<p style="color:#666;font-size:13px">Actuent, made by localilabs. You get this because you claimed ${esc(site.domain)} on Actuent. <a href="${unsubscribe}">Unsubscribe</a></p>`
  await sendEmail(account.email, `${site.domain}: ${changes.length === 1 ? "something changed" : `${changes.length} things changed`} on your site`, html, { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" })
}

async function main() {
  if (launchWeekPause()) return
  const sites = await get(`lawp_sites?select=domain,actions,owner_key,score_emails&owner_key=not.is.null&change_alerts=is.true&limit=1000`)
    .catch(async () => get(`lawp_sites?select=domain,actions,owner_key,score_emails&owner_key=not.is.null&limit=1000`)) // before list_seventeen.sql
  console.log(`${sites.length} claimed sites to watch`)
  let alerted = 0
  for (const site of sites) {
    try {
      const changes = await check(site)
      if (!changes.length) continue
      console.log(`${site.domain}: ${changes.length} change(s)`)
      await notify(site, changes)
      alerted++
    } catch (e) { console.log(`error ${site.domain}: ${e}`) }
  }
  console.log(`Done: ${alerted} site owners told about changes`)
}

main().catch(e => { console.error(e); process.exit(1) })
