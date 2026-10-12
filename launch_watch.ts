import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { sendEmail, esc } from "./email"

// Launch days, hourly: what went wrong in the last hour, so it can be fixed while people are trying
// Actuent: searches that found nothing, searches asked again straight after (the answer missed),
// "busy" answers, and wrong answers people reported (actuent_feedback in chats, 👎 on humans.actuent.ai).
// Emailed to ALERT_TO (hello@localilabs.com); the job's log only has counts, since this repo is public.
// HOURS=72 looks further back (a one-off catch-up); quiet hours send nothing.

const TO = process.env.ALERT_TO || "hello@localilabs.com"

async function get(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS }).catch(() => null)
  return r?.ok ? r.json() : []
}

async function main() {
  const hours = Math.min(Math.max(Number(process.env.HOURS) || 1, 1), 168)
  const hour = encodeURIComponent(new Date(Date.now() - hours * 3600_000).toISOString())
  const [searches, empty, feedback, busy, again, thumbs] = await Promise.all([
    get(`searches?select=id&created_at=gte.${hour}&tier=neq.test&limit=10000`),
    get(`searches?select=query&created_at=gte.${hour}&result_count=eq.0&tier=neq.test&limit=2000`),
    get(`answer_feedback?select=tool,question,problem,expected&created_at=gte.${hour}&order=created_at.desc&limit=50`),
    get(`usage_counters?select=key,count&key=like.busy*&window_start=gte.${hour}`),
    get(`query_reformulations?select=from_query,to_query,times&updated_at=gte.${hour}&order=times.desc&limit=20`),
    get(`search_ratings?select=query,domain,rated_at&position=eq.-1&rated_at=gte.${hour}&order=rated_at.desc&limit=30`)
  ])
  const counts = new Map<string, number>()
  for (const e of empty) { const q = String(e.query || "").toLowerCase().trim(); if (q && q.length <= 80) counts.set(q, (counts.get(q) || 0) + 1) }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  const busyCount = busy.reduce((n: number, b: any) => n + Number(b.count || 0), 0)
  const when = hours === 1 ? "Last hour" : `Last ${hours} hours`
  const reported = feedback.length + thumbs.length
  const summary = `${when}: ${searches.length} searches, ${empty.length} found nothing, ${again.length} asked again straight after, ${busyCount} busy answers, ${reported} reported wrong answers.`
  console.log(summary)
  if (!top.length && !reported && !busyCount && !again.length) return
  await sendEmail(TO, `Launch watch: ${empty.length} empty, ${reported} reported, ${again.length} asked again, ${busyCount} busy (${when.toLowerCase()})`, `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:620px">
<p>${esc(summary)}</p>
${top.length ? `<h3>Searches that found nothing</h3><ul>${top.map(([q, n]) => `<li>${esc(q)}${n > 1 ? ` <strong>×${n}</strong>` : ""}</li>`).join("")}</ul>` : ""}
${thumbs.length ? `<h3>👎 Wrong answer on humans.actuent.ai</h3><ul>${thumbs.map((t: any) => { const [site, note] = String(t.domain || "").split(" | "); return `<li><strong>${esc(t.query)}</strong>: top result ${esc(site || "?")}${note ? `. They said: <em>${esc(note)}</em>` : ""} <span style="color:#777">(${esc(String(t.rated_at).slice(0, 16).replace("T", " "))} UTC)</span></li>` }).join("")}</ul>` : ""}
${again.length ? `<h3>Searched again straight after (the first answer missed)</h3><ul>${again.slice(0, 15).map((r: any) => `<li>${esc(r.from_query)} → ${esc(r.to_query)}${r.times > 1 ? ` <strong>×${r.times}</strong>` : ""}</li>`).join("")}</ul>` : ""}
${feedback.length ? `<h3>Wrong answers people reported</h3><ul>${feedback.map((f: any) => `<li><strong>${esc(f.question)}</strong> (${esc(f.tool || "?")}): ${esc(f.problem)}${f.expected ? ` <em>Should be: ${esc(f.expected)}</em>` : ""}</li>`).join("")}</ul>` : ""}
<p style="color:#777;font-size:12px">Paste this into Claude Code and say "fix these".</p></div>`)
}

main().catch(e => { console.error(e); process.exit(1) })
