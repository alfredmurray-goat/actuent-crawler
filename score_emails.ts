import crypto from "crypto"
import { SUPABASE_URL, SUPABASE_HEADERS, SUPABASE_SERVICE_KEY } from "./shared"
import { readiness } from "./score"
import { sendEmail, esc, emailEnabled } from "./email"

// Weekly email to the owner of every claimed site: its agent-readiness score, how it changed,
// AI bot visits this week (when reported) and the single most valuable next step.
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

async function main() {
  if (!emailEnabled) { console.log("RESEND_API_KEY isn't set — skipping score emails"); return }
  const sixDaysAgo = new Date(Date.now() - 6 * 86400000).toISOString()
  const sites = await get(`lawp_sites?select=domain,name,pages,actions,native,business,owner_key,last_score&owner_key=not.is.null&score_emails=is.true&or=(score_emailed_at.is.null,score_emailed_at.lt.${encodeURIComponent(sixDaysAgo)})&limit=1000`)
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
      const page = `https://api.actuent.ai/site/${site.domain}`
      const unsubscribe = `https://api.actuent.ai/api/unsubscribe?domain=${encodeURIComponent(site.domain)}&token=${unsubscribeToken(site.domain)}`
      const html = `<p>Hi,</p>
<p><strong>${esc(site.name || site.domain)}</strong> is <strong>${score}/100</strong> agent-ready this week${esc(change)}: ${esc(label.toLowerCase())}.</p>
${bots ? `<p>AI bots visited ${bots.total} times in the last 7 days (${bots.top.map(([b, n]) => `${esc(b)} ${n}`).join(", ")}).</p>` : ""}
${next ? `<p><strong>Your next step (+${next.points} points):</strong> ${esc(next.label)}.<br>${next.fix}</p>` : `<p>Every check passes. Nice work.</p>`}
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
