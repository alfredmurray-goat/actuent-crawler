import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { fetchPublic } from "./safe-fetch"
import { sendEmail, esc, emailEnabled, lawpyImg } from "./email"
import { USER_AGENT } from "./robots"

// Daily: saved-search alerts (Pro). Re-runs each saved search (saved_searches, list_eighteen.sql)
// and tells the owner about sites that are new to Actuent and now match it, by email and to their
// webhook. The first check only notes what already matches. A site counts as new when Actuent first
// saw it after the previous check (first_seen_at), so a site that merely moved up the results
// doesn't trigger an alert. Saved from Analytics → Alerts or the MCP tool actuent_alert_new.

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
const JSON_HEADERS = { ...SUPABASE_HEADERS, "Content-Type": "application/json" }
const API = "https://api.actuent.ai/api/search"
// The search API allows 20 free searches a minute: one every 4 seconds stays well under it.
const GAP_MS = 4000
const MAX_SEEN = 400

async function get(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS })
  if (!r.ok) throw new Error(`${path.split("?")[0]}: ${r.status} ${await r.text()}`)
  return r.json()
}

// "Actuent-Alerts" searches are logged as tests, so they don't count in search trends.
async function search(query: string): Promise<any[] | null> {
  const r = await fetch(`${API}?q=${encodeURIComponent(query)}&limit=30`, { headers: { "User-Agent": "Actuent-Alerts/1.0" }, signal: AbortSignal.timeout(45000) }).catch(() => null)
  if (!r?.ok) return null
  const data = await r.json().catch(() => null)
  return Array.isArray(data?.results) ? data.results : null
}

async function firstSeen(domains: string[]): Promise<Map<string, string | null>> {
  if (!domains.length) return new Map()
  const list = encodeURIComponent(domains.map(d => `"${d}"`).join(","))
  const rows = await get(`lawp_sites?select=domain,first_seen_at&domain=in.(${list})`).catch(() => [])
  return new Map(rows.map((r: any) => [r.domain, r.first_seen_at || null]))
}

async function tell(saved: any, sites: any[]) {
  const payload = { event: "search.new_sites", query: saved.query, sites: sites.map(s => ({ domain: s.domain, name: s.name, snippet: s.snippet || null, page: `https://api.actuent.ai/site/${s.domain}` })), timestamp: new Date().toISOString() }
  if (saved.webhook_url && String(saved.webhook_url).startsWith("https://")) {
    await fetchPublic(saved.webhook_url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) }, 0).catch(() => null)
  }
  if (!emailEnabled) return
  const [account] = await get(`api_keys?select=email&key_hash=eq.${saved.api_key}`).catch(() => [])
  if (!account?.email) return
  const html = `${lawpyImg("dance")}<p>Hi,</p>
<p>${sites.length === 1 ? "A new site matches" : `${sites.length} new sites match`} your saved search <strong>“${esc(saved.query)}”</strong>:</p>
<ul>${sites.map(s => `<li><a href="https://api.actuent.ai/site/${esc(s.domain)}">${esc(s.name || s.domain)}</a> (${esc(s.domain)})${s.snippet ? `<br><span style="color:#555">${esc(String(s.snippet).slice(0, 160))}</span>` : ""}</li>`).join("")}</ul>
<p><a href="https://humans.actuent.ai/?q=${encodeURIComponent(saved.query)}">See all results →</a></p>
<p style="color:#666;font-size:13px">Actuent, made by localilabs. You get this because you saved this search. Remove it in <a href="https://analytics.actuent.ai">Actuent Analytics → Alerts</a>, or ask your AI assistant to stop the alert.</p>`
  await sendEmail(account.email, `New on Actuent for “${saved.query}”: ${sites.map(s => s.name || s.domain).slice(0, 2).join(", ")}${sites.length > 2 ? ` and ${sites.length - 2} more` : ""}`, html)
}

async function main() {
  const all = await get("saved_searches?select=*&order=checked_at.asc.nullsfirst&limit=2000").catch(e => { console.log(`saved_searches not available yet: ${e}`); return [] })
  console.log(`${all.length} saved searches`)
  let alerted = 0
  for (const saved of all) {
    const results = await search(saved.query)
    await new Promise(r => setTimeout(r, GAP_MS))
    if (!results) { console.log(`no answer for "${saved.query}", next time`); continue }
    const seen = new Set<string>(Array.isArray(saved.seen) ? saved.seen : [])
    const unseen = results.filter(r => r.domain && !seen.has(r.domain))
    let fresh: any[] = []
    if (saved.checked_at && unseen.length) {
      const since = new Date(new Date(saved.checked_at).getTime() - 86400000).getTime()
      const firsts = await firstSeen(unseen.map(r => r.domain))
      fresh = unseen.filter(r => { const f = firsts.get(r.domain); return f && new Date(f).getTime() >= since }).slice(0, 10)
    }
    for (const r of unseen) seen.add(r.domain)
    const now = new Date().toISOString()
    await fetch(`${SUPABASE_URL}/rest/v1/saved_searches?id=eq.${saved.id}`, {
      method: "PATCH", headers: { ...JSON_HEADERS, "Prefer": "return=minimal" },
      body: JSON.stringify({ seen: [...seen].slice(-MAX_SEEN), checked_at: now, ...(fresh.length ? { alerted_at: now } : {}) })
    }).catch(() => {})
    if (fresh.length) { await tell(saved, fresh); alerted++; console.log(`"${saved.query}": ${fresh.length} new`) }
  }
  console.log(`Done: ${alerted} alerts sent`)
}

main().catch(e => { console.error(e); process.exit(1) })
