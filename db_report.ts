import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { sendEmail, esc } from "./email"

// Weekly (Monday): how big the database is, which tables grew since last week and by how much, and
// when it would be full at this week's pace, to hello@localilabs.com. Last week's sizes are kept in
// data/db_sizes.json (sizes only), so 94% never sneaks up again.

const LIMIT_MB = 500
const mb = (b: number) => Math.round((b / 1048576) * 10) / 10

async function main() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/db_size`, { method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(60000) })
  if (!r.ok) { console.error(`db_size failed: ${r.status} ${await r.text()}`); process.exit(1) }
  const rows: any[] = await r.json()
  const now: Record<string, number> = Object.fromEntries(rows.map(x => [String(x.name), Number(x.bytes)]))
  let before: { at: string, sizes: Record<string, number> } | null = null
  try { before = JSON.parse(readFileSync("data/db_sizes.json", "utf8")) } catch {}
  const total = now["(total)"] || 0, prevTotal = before?.sizes["(total)"] || 0
  const days = before ? Math.max(1, (Date.now() - Date.parse(before.at)) / 86400000) : 7
  const perDay = before ? (total - prevTotal) / days : 0
  const daysLeft = perDay > 0 ? Math.floor(((LIMIT_MB * 1048576) - total) / perDay) : null
  const tables = Object.entries(now).filter(([k]) => k !== "(total)").map(([name, bytes]) => ({ name, mb: mb(bytes), change: before ? mb(bytes - (before.sizes[name] || 0)) : 0 }))
    .sort((a, b) => b.mb - a.mb).slice(0, 12)
  const pct = Math.round((mb(total) / LIMIT_MB) * 100)
  const summary = `${mb(total)} MB of ${LIMIT_MB} MB (${pct}%)${before ? `, ${perDay >= 0 ? "+" : ""}${mb(perDay * 7)} MB this week` : ""}${daysLeft != null ? `; full in about ${daysLeft} days at this pace` : ""}`
  console.log(summary)
  for (const t of tables) console.log(`  ${t.name.padEnd(28)} ${String(t.mb).padStart(7)} MB  ${t.change >= 0 ? "+" : ""}${t.change}`)
  mkdirSync("data", { recursive: true })
  writeFileSync("data/db_sizes.json", JSON.stringify({ at: new Date().toISOString(), sizes: now }))
  const warn = pct >= 85 || (daysLeft != null && daysLeft < 30)
  await sendEmail(process.env.REPORT_TO || "hello@localilabs.com", `${warn ? "⚠️ " : ""}Actuent database: ${pct}% full${daysLeft != null ? `, ~${daysLeft} days to go` : ""}`, `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px">
<h2 style="margin:0 0 8px">Database, week of ${new Date().toISOString().slice(0, 10)}</h2><p><strong>${esc(summary)}</strong></p>
<table cellpadding="5" style="border-collapse:collapse;font-size:14px"><tr><th align="left">Table</th><th align="right">Size</th><th align="right">This week</th></tr>
${tables.map(t => `<tr><td>${esc(t.name)}</td><td align="right">${t.mb} MB</td><td align="right" style="color:${t.change > 5 ? "#c0392b" : "#555"}">${before ? `${t.change >= 0 ? "+" : ""}${t.change} MB` : "—"}</td></tr>`).join("")}</table>
${warn ? `<p><strong>Time to make room:</strong> run list_twentyeight.sql Part 2 until it returns 0, then <code>vacuum full lawp_sites;</code> at night. Paste this into Claude Code if a table is growing fast.</p>` : ""}
<p style="color:#777;font-size:12px">The free plan's limit is ${LIMIT_MB} MB; at 100% the database goes read-only (search keeps answering, nothing new is saved).</p></div>`)
}

main().catch(e => { console.error(e); process.exit(1) })
