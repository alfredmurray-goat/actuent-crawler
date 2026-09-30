import crypto from "crypto"
import { SUPABASE_URL, SUPABASE_HEADERS, SUPABASE_SERVICE_KEY } from "./shared"
import { readiness } from "./score"
import { sendEmail, esc, emailEnabled, lawpyImg } from "./email"
import { compare } from "./competitors"
import { CATEGORIES } from "./category"

// Weekly digest to the owner of every claimed site (it replaced the separate monthly report):
// agent-readiness score and how it changed, the searches the site came up for, visits Actuent sent,
// AI bot visits, what agents looked for on the site but couldn't find, and the next step.
// Owners can unsubscribe with one click; needs next_list.sql.

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

// Same token as api.actuent.ai/api/unsubscribe checks.
export function unsubscribeToken(domain: string): string {
  return crypto.createHmac("sha256", SUPABASE_SERVICE_KEY).update(`score-emails:${domain}`).digest("hex").slice(0, 32)
}

async function get(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS })
  if (!r.ok) throw new Error(`${path.split("?")[0]}: ${r.status} ${await r.text()}`)
  return r.json()
}

async function botVisits(domain: string): Promise<{ total: number, top: [string, number][] } | null> {
  try {
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
    const rows = await get(`bot_hits?select=bot,hits&domain=eq.${encodeURIComponent(domain)}&day=gte.${since}`)
    if (!rows.length) return null
    const byBot: Record<string, number> = {}
    for (const r of rows) byBot[r.bot] = (byBot[r.bot] || 0) + r.hits
    return { total: Object.values(byBot).reduce((a, b) => a + b, 0), top: Object.entries(byBot).sort((a, b) => b[1] - a[1]).slice(0, 3) }
  } catch { return null }
}

const plain = (q: string) => q && q.length <= 60 && !/[@/:]|\d{4,}|^\[object /.test(q)

// What people asked agents to do or find on a site, and whether the site offers it.
const WANTS: { label: string, words: RegExp, has: (site: any) => boolean }[] = [
  { label: "booking", words: /\b(book|booking|reserve|reservation|appointment|table for)\b/i, has: s => (s.actions || []).some((a: any) => /book|reserv|appoint/i.test(`${a.id} ${a.name}`)) },
  { label: "prices", words: /\b(price|prices|pricing|cost|how much|cheap)\b/i, has: s => Object.keys(s.pages || {}).some(p => /pric|rates|menu|plans/i.test(p)) || !!s.business?.offers?.length },
  { label: "ordering or delivery", words: /\b(order|delivery|deliver|takeaway|take away)\b/i, has: s => (s.actions || []).some((a: any) => /order|cart|shop|buy|deliver/i.test(`${a.id} ${a.name}`)) },
  { label: "opening hours", words: /\b(open|opening|hours|closing)\b/i, has: s => !!s.business?.opening_hours?.length },
  { label: "contact details", words: /\b(contact|phone|call|email)\b/i, has: s => !!(s.business?.telephone || s.business?.email) || (s.actions || []).some((a: any) => /contact|call/i.test(a.id)) }
]

// The week in searches: which ones the site came up for, visits sent, and what agents looked for but didn't find.
async function week(site: any) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString()
  const [searches, clicks] = await Promise.all([
    get(`searches?select=query&domains=cs.${encodeURIComponent(`{"${site.domain}"}`)}&created_at=gte.${encodeURIComponent(since)}&limit=5000`).catch(() => [] as any[]),
    get(`link_clicks?select=clicks&domain=eq.${encodeURIComponent(site.domain)}&day=gte.${since.slice(0, 10)}`).catch(() => [] as any[])
  ])
  const counts = new Map<string, number>()
  for (const x of searches) { const q = String(x.query || "").toLowerCase().trim(); if (plain(q)) counts.set(q, (counts.get(q) || 0) + 1) }
  const missing = WANTS.map(w => ({ label: w.label, n: searches.filter((x: any) => w.words.test(String(x.query || ""))).length, has: w.has(site) })).filter(w => w.n >= 2 && !w.has)
  return {
    appearances: searches.length,
    topSearches: [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6),
    visits: clicks.reduce((n: number, c: any) => n + (c.clicks || 0), 0),
    missing
  }
}

async function main() {
  if (!emailEnabled) { console.log("RESEND_API_KEY isn't set — skipping score emails"); return }
  const sixDaysAgo = new Date(Date.now() - 6 * 86400000).toISOString()
  const sites = await get(`lawp_sites?select=*&owner_key=not.is.null&score_emails=is.true&or=(score_emailed_at.is.null,score_emailed_at.lt.${encodeURIComponent(sixDaysAgo)})&limit=1000`)
  console.log(`${sites.length} claimed sites due a score email`)
  let sent = 0
  for (const site of sites) {
    try {
      const [account] = await get(`api_keys?select=email&key_hash=eq.${site.owner_key}`)
      if (!account?.email) continue
      const { score, label, checks } = readiness(site)
      const before = site.last_score as number | null
      const change = before == null ? "" : score > before ? ` (up from ${before})` : score < before ? ` (down from ${before})` : " (no change)"
      const next = checks.filter(c => !c.ok).sort((a, b) => b.points - a.points)[0]
      const bots = await botVisits(site.domain)
      const vs = await compare(site, get).catch(() => null)
      const w = await week(site)
      const page = `https://api.actuent.ai/site/${site.domain}`
      const unsubscribe = `https://api.actuent.ai/api/unsubscribe?domain=${encodeURIComponent(site.domain)}&token=${unsubscribeToken(site.domain)}`
      const html = `${lawpyImg(score >= 90 ? "dance" : score >= 50 ? "wave" : "think")}<p>Hi,</p>
<p><strong>${esc(site.name || site.domain)}</strong> is <strong>${score}/100</strong> agent-ready this week${esc(change)}: ${esc(label.toLowerCase())}.</p>
${bots ? `<p>AI bots visited ${bots.total} times in the last 7 days (${bots.top.map(([b, n]) => `${esc(b)} ${n}`).join(", ")}).</p>` : ""}
${vs ? `<p>Among ${vs.total} similar sites (${esc(CATEGORIES[vs.category] || vs.category)}${vs.city ? ` in ${esc(vs.city)}` : ""}) you're <strong>#${vs.rank}</strong>.${vs.they_have[0] ? ` ${vs.they_have[0].count} of them have something you don't: ${esc(vs.they_have[0].label.toLowerCase())}.` : ""}</p>` : ""}
${w.appearances ? `<p>You came up in <strong>${w.appearances}</strong> searches this week${w.visits ? ` and Actuent sent you <strong>${w.visits}</strong> visits` : ""}.${w.topSearches.length ? `<br>Top searches: ${w.topSearches.map(([q, n]) => `${esc(q)} <span style="color:#666">(${n})</span>`).join(", ")}` : ""}</p>` : ""}
${w.missing.length ? `<p><strong>Agents looked for this on your site but couldn't find it:</strong><br>${w.missing.map(m => `${esc(m.label)} <span style="color:#666">(${m.n} searches)</span>`).join("<br>")}<br>Add it in <a href="https://analytics.actuent.ai/?edit=${encodeURIComponent(site.domain)}">the editor</a>.</p>` : ""}
${next ? `<p><strong>Your next step (+${next.points} points):</strong> ${esc(next.label)}.<br>${next.fix}</p>
<p><a href="https://docs.actuent.ai/checklist?domain=${encodeURIComponent(site.domain)}">Step-by-step for Shopify, Squarespace, Wix, Webflow and WordPress, checked live →</a></p>` : `<p>Every check passes. Nice work.</p>`}
<p><a href="${page}">See your full score and starter files →</a></p>
<p style="color:#666;font-size:13px">Actuent, made by localilabs. You get this weekly because you claimed ${esc(site.domain)} on Actuent. <a href="${unsubscribe}">Unsubscribe</a></p>`
      const ok = await sendEmail(account.email, `${site.domain}: ${score}/100 agent-ready${change}`, html, { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" })
      if (!ok) continue
      sent++
      await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(site.domain)}`, {
        method: "PATCH", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ last_score: score, score_emailed_at: new Date().toISOString() })
      })
    } catch (e) { console.log(`error ${site.domain}: ${e}`) }
  }
  console.log(`Sent ${sent} score emails`)
}

main().catch(e => { console.error(e); process.exit(1) })
