import crypto from "crypto"
import { SUPABASE_URL, SUPABASE_HEADERS, SUPABASE_SERVICE_KEY } from "./shared"
import { readiness } from "./score"
import { sendEmail, esc, emailEnabled, lawpyImg } from "./email"

// Monthly (the 1st): an AI-visibility report for the owner of every claimed site, over the last
// 30 days: how often AI agents got the site in search results and for which searches, visits
// Actuent sent to it, AI bot visits, and what's still missing from its LAWP. Same opt-out as the
// weekly score emails (score_emails). Searches are only named when made at least twice, so no one
// person's search is ever shown.

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

// Same token as api.actuent.ai/api/unsubscribe checks (and score_emails.ts).
function unsubscribeToken(domain: string): string {
  return crypto.createHmac("sha256", SUPABASE_SERVICE_KEY).update(`score-emails:${domain}`).digest("hex").slice(0, 32)
}

async function get(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS })
  if (!r.ok) throw new Error(`${path.split("?")[0]}: ${r.status} ${await r.text()}`)
  return r.json()
}
const safe = (p: Promise<any[]>) => p.catch(() => [] as any[])
const plain = (q: string) => q && q.length <= 60 && !/[@/:]|\d{4,}|^\[object /.test(q)

async function report(site: any) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString()
  const d = encodeURIComponent(site.domain)
  const [searches, clicks, bots] = await Promise.all([
    safe(get(`searches?select=query&domains=cs.${encodeURIComponent(`{"${site.domain}"}`)}&created_at=gte.${encodeURIComponent(since)}&limit=5000`)),
    safe(get(`link_clicks?select=clicks&domain=eq.${d}&day=gte.${since.slice(0, 10)}`)),
    safe(get(`bot_hits?select=bot,hits&domain=eq.${d}&day=gte.${since.slice(0, 10)}`))
  ])
  const counts = new Map<string, number>()
  for (const s of searches) { const q = String(s.query || "").toLowerCase().trim(); if (plain(q)) counts.set(q, (counts.get(q) || 0) + 1) }
  const topSearches = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8)
  const byBot: Record<string, number> = {}
  for (const b of bots) byBot[b.bot] = (byBot[b.bot] || 0) + b.hits
  return {
    appearances: searches.length, topSearches,
    visits: clicks.reduce((n: number, c: any) => n + (c.clicks || 0), 0),
    botTotal: Object.values(byBot).reduce((a, b) => a + b, 0), topBots: Object.entries(byBot).sort((a, b) => b[1] - a[1]).slice(0, 3)
  }
}

async function main() {
  // Merged into the weekly digest (score_emails.ts) on 30 September 2026: one email a week instead of two kinds.
  if (process.env.SEND_MONTHLY !== "1") { console.log("Monthly reports are part of the weekly digest now (score_emails.ts). Set SEND_MONTHLY=1 to send one anyway."); return }
  if (!emailEnabled) { console.log("RESEND_API_KEY isn't set — skipping monthly reports"); return }
  const sites = await get(`lawp_sites?select=*&owner_key=not.is.null&score_emails=is.true&limit=1000`)
  console.log(`${sites.length} claimed sites get a monthly report`)
  const month = new Date(Date.now() - 86400000).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
  let sent = 0
  for (const site of sites) {
    try {
      const [account] = await get(`api_keys?select=email&key_hash=eq.${site.owner_key}`)
      if (!account?.email) continue
      const r = await report(site)
      const { score, checks } = readiness(site)
      const missing = checks.filter(c => !c.ok).sort((a, b) => b.points - a.points).slice(0, 3)
      const page = `https://api.actuent.ai/site/${site.domain}`
      const unsubscribe = `https://api.actuent.ai/api/unsubscribe?domain=${encodeURIComponent(site.domain)}&token=${unsubscribeToken(site.domain)}`
      const html = `${lawpyImg("talk")}<p>Hi,</p>
<p>Here's how AI agents saw <strong>${esc(site.name || site.domain)}</strong> on Actuent over the last 30 days.</p>
<table cellpadding="6" style="border-collapse:collapse;font-size:15px">
<tr><td>In AI agents' search results</td><td><strong>${r.appearances.toLocaleString("en")}</strong> times</td></tr>
<tr><td>Visits Actuent sent you</td><td><strong>${r.visits.toLocaleString("en")}</strong></td></tr>
${r.botTotal ? `<tr><td>AI bot visits (reported)</td><td><strong>${r.botTotal.toLocaleString("en")}</strong> (${r.topBots.map(([b, n]) => `${esc(b)} ${n}`).join(", ")})</td></tr>` : ""}
<tr><td>Agent-readiness score</td><td><strong>${score}/100</strong></td></tr>
</table>
${r.topSearches.length ? `<p><strong>Searches you came up for:</strong><br>${r.topSearches.map(([q, n]) => `${esc(q)} <span style="color:#666">(${n})</span>`).join("<br>")}</p>` : `<p>You didn't come up for any search more than once this month. A fuller LAWP (pages, actions, business details) helps agents find you for more searches.</p>`}
${missing.length ? `<p><strong>What's missing from your LAWP:</strong></p><ul>${missing.map(c => `<li><strong>${esc(c.label)}</strong> (+${c.points} points). ${c.fix}</li>`).join("")}</ul>` : `<p>Your LAWP has everything agents look for. Nice work.</p>`}
<p><a href="${page}">Your full AI profile and starter files →</a> · <a href="https://api.actuent.ai/site/${encodeURIComponent(site.domain)}?format=lawp">Download your lawp.json</a></p>
<p style="color:#666;font-size:13px">Actuent, made by localilabs. You get this because you claimed ${esc(site.domain)} on Actuent. <a href="${unsubscribe}">Unsubscribe</a></p>`
      const ok = await sendEmail(account.email, `${site.domain} and AI agents: your ${month} report`, html, { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" })
      if (ok) sent++
    } catch (e) { console.log(`error ${site.domain}: ${e}`) }
  }
  console.log(`Sent ${sent} monthly reports`)
}

main().catch(e => { console.error(e); process.exit(1) })
