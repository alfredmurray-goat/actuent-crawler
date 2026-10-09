import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { sendEmail, esc, emailEnabled } from "./email"

// Weekly (Monday, after misses.ts): how good Actuent's answers were, to hello@localilabs.com.
//   • Re-search rate: how often someone searched again within 90 seconds with overlapping words
//     (query_reformulations, logged per person by api/search.ts) — the clearest sign an answer missed.
//   • The worst searches: asked again the most, found nothing, or never clicked (search_misses), and
//     what people reported as wrong from inside the chat (answer_feedback).
// Paste it into Claude Code and say "fix these".

const TO = process.env.QUALITY_TO || "hello@localilabs.com"
const week = encodeURIComponent(new Date(Date.now() - 7 * 86400000).toISOString())
const rows = (path: string) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS, signal: AbortSignal.timeout(30000) }).then(r => r.ok ? r.json() : []).catch(() => []) as Promise<any[]>
async function count(path: string): Promise<number> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { ...SUPABASE_HEADERS, "Prefer": "count=estimated", "Range": "0-0" }, signal: AbortSignal.timeout(30000) }).catch(() => null)
  return Number(r?.headers.get("content-range")?.split("/")[1]) || 0
}

async function main() {
  const [searches, rewrites, misses, feedback] = await Promise.all([
    count(`searches?select=id&created_at=gte.${week}`),
    rows(`query_reformulations?select=from_query,to_query,times&updated_at=gte.${week}&order=times.desc&limit=200`),
    rows(`search_misses?select=query,kind,searches&checked_at=gte.${week}&order=searches.desc&limit=60`),
    rows(`answer_feedback?select=tool,question,problem,expected&created_at=gte.${week}&order=created_at.desc&limit=40`)
  ])
  const again = rewrites.reduce((n, r) => n + (Number(r.times) || 0), 0)
  const rate = searches ? Math.round((again / searches) * 1000) / 10 : 0
  const list = (items: string[]) => items.length ? `<ol>${items.join("")}</ol>` : "<p style=\"color:#666\">None this week.</p>"
  const kind = (k: string) => misses.filter(m => m.kind === k).slice(0, 12).map(m => `<li>${esc(m.query)} <span style="color:#666">(${m.searches})</span></li>`)
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:640px;color:#1a1a1a;line-height:1.55">
<h2 style="margin:0 0 8px">Answer quality, last 7 days</h2>
<p><strong>${searches.toLocaleString("en")}</strong> searches. <strong>${again.toLocaleString("en")}</strong> were followed by a search again within 90 seconds: a <strong>${rate}%</strong> re-search rate (lower is better).</p>
<h3>Searched again straight after (the answer probably missed)</h3>${list(rewrites.filter(r => Number(r.times) >= 2).slice(0, 15).map(r => `<li>${esc(r.from_query)} → ${esc(r.to_query)} <span style="color:#666">(${r.times}×)</span></li>`))}
<h3>Reported wrong from inside the chat</h3>${list(feedback.slice(0, 15).map(f => `<li><strong>${esc(f.question)}</strong>${f.tool ? ` (${esc(f.tool)})` : ""}: ${esc(f.problem)}${f.expected ? ` <em>Should be: ${esc(f.expected)}</em>` : ""}</li>`))}
<h3>Found nothing</h3>${list(kind("zero_results"))}
<h3>Asked often, never clicked</h3>${list(kind("no_clicks"))}
<p style="color:#777;font-size:12px">Paste this into Claude Code and say "fix these". Searches are only named when asked at least twice, so no one person's search is shown.</p></div>`
  console.log(`${searches} searches, ${again} searched again (${rate}%), ${rewrites.length} rewrite pairs, ${misses.length} misses, ${feedback.length} reports`)
  if (!emailEnabled) { console.log("RESEND_API_KEY isn't set: not emailing"); return }
  const ok = await sendEmail(TO, `Actuent answer quality: ${rate}% searched again (${again} of ${searches})`, html)
  console.log(ok ? `Sent to ${TO}` : "Email failed")
}

main().catch(e => { console.error(e); process.exit(1) })
