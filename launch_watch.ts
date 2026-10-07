import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { sendEmail, esc } from "./email"

// Launch days, hourly: what went wrong in the last hour, so it can be fixed while people are trying
// Actuent: searches that found nothing, "busy" answers and wrong answers users reported
// (actuent_feedback). Emailed to ALERT_TO (hello@localilabs.com) and shown in the job summary; quiet hours send nothing.

const TO = process.env.ALERT_TO || "hello@localilabs.com"

async function get(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS }).catch(() => null)
  return r?.ok ? r.json() : []
}

async function main() {
  const hour = encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())
  const [searches, empty, feedback, busy] = await Promise.all([
    get(`searches?select=id&created_at=gte.${hour}&tier=neq.test&limit=10000`),
    get(`searches?select=query&created_at=gte.${hour}&result_count=eq.0&tier=neq.test&limit=2000`),
    get(`answer_feedback?select=tool,question,problem,expected&created_at=gte.${hour}&order=created_at.desc&limit=50`),
    get(`usage_counters?select=key,count&key=like.busy*&window_start=gte.${hour}`)
  ])
  const counts = new Map<string, number>()
  for (const e of empty) { const q = String(e.query || "").toLowerCase().trim(); if (q && q.length <= 80) counts.set(q, (counts.get(q) || 0) + 1) }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  const busyCount = busy.reduce((n: number, b: any) => n + Number(b.count || 0), 0)
  const summary = `Last hour: ${searches.length} searches, ${empty.length} found nothing, ${busyCount} busy answers, ${feedback.length} reported wrong answers.`
  console.log(summary)
  top.forEach(([q, n]) => console.log(`  nothing found ×${n}: ${q}`))
  feedback.forEach((f: any) => console.log(`  wrong (${f.tool || "?"}): ${f.question} → ${f.problem}`))
  if (!top.length && !feedback.length && !busyCount) return
  await sendEmail(TO, `Launch watch: ${empty.length} empty, ${feedback.length} reported, ${busyCount} busy (last hour)`, `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:620px">
<p>${esc(summary)}</p>
${top.length ? `<h3>Searches that found nothing</h3><ul>${top.map(([q, n]) => `<li>${esc(q)}${n > 1 ? ` <strong>×${n}</strong>` : ""}</li>`).join("")}</ul>` : ""}
${feedback.length ? `<h3>Wrong answers people reported</h3><ul>${feedback.map((f: any) => `<li><strong>${esc(f.question)}</strong> (${esc(f.tool || "?")}): ${esc(f.problem)}${f.expected ? ` <em>Should be: ${esc(f.expected)}</em>` : ""}</li>`).join("")}</ul>` : ""}
<p style="color:#777;font-size:12px">Paste this into Claude Code and say "fix these".</p></div>`)
}

main().catch(e => { console.error(e); process.exit(1) })
