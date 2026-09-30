import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"

// Weekly (and on demand): is Actuent heading for a free-plan limit? When anything passes 70%, this job
// fails and GitHub emails the repository owner (like speed_alert.ts), so the warning comes from us
// before a provider's "we'll pause your project" email.
//   • Supabase database: size against 500 MB, and growth since last week (at that pace, how long left).
//   • Vercel: time spent in search this month, as memory-hours (search runs on Vercel with 2 GB),
//     against the 360 GB-hours Fluid Provisioned Memory included. Other Vercel functions come on top.
//   • Resend: emails likely this month (weekly score emails, monthly reports, alerts) against 3,000.
// Supabase Edge Function calls (500,000 a month) aren't visible from here: see the ops page note.

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
const JSON_HEADERS = { ...SUPABASE_HEADERS, "Content-Type": "application/json" }
const WARN = 0.7
const DB_LIMIT = 500 * 1024 * 1024
const VERCEL_GB_HOURS = 360, VERCEL_MEMORY_GB = 2
const EMAILS_PER_MONTH = 3000

async function rows(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS }).catch(() => null)
  return r?.ok ? r.json() : []
}
async function count(path: string): Promise<number> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "HEAD", headers: { ...SUPABASE_HEADERS, "Prefer": "count=exact", "Range": "0-0" } }).catch(() => null)
  return Number(r?.headers.get("content-range")?.split("/")[1] || 0)
}
async function state(id: string): Promise<any> { return (await rows(`crawler_state?id=eq.${id}&select=value`))[0]?.value ?? null }
async function setState(id: string, value: unknown) {
  await fetch(`${SUPABASE_URL}/rest/v1/crawler_state?on_conflict=id`, { method: "POST", headers: { ...JSON_HEADERS, "Prefer": "resolution=merge-duplicates" }, body: JSON.stringify({ id, value }) }).catch(() => {})
}
const pct = (x: number) => `${Math.round(x * 100)}%`

async function main() {
  const warnings: string[] = []
  const now = new Date(), monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthFraction = (now.getTime() - monthStart.getTime()) / (new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).getTime() - monthStart.getTime())

  // 1. Database size.
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/db_size`, { method: "POST", headers: JSON_HEADERS, body: "{}" }).catch(() => null)
  const sizes: any[] = r?.ok ? await r.json() : []
  const total = Number(sizes.find(s => s.name === "(total)")?.bytes || 0)
  if (total) {
    const before = await state("watchdog_db_bytes")
    const weekly = before?.bytes && before?.at ? (total - before.bytes) / Math.max(1, (now.getTime() - Date.parse(before.at)) / (7 * 86400000)) : null
    const weeksLeft = weekly && weekly > 0 ? (DB_LIMIT - total) / weekly : null
    console.log(`Database: ${(total / 1048576).toFixed(0)} MB of 500 MB (${pct(total / DB_LIMIT)})${weekly != null ? `, ${weekly >= 0 ? "+" : ""}${(weekly / 1048576).toFixed(1)} MB a week` : ""}${weeksLeft != null ? `, full in about ${weeksLeft.toFixed(0)} weeks at this pace` : ""}`)
    console.log(`  Biggest: ${sizes.filter(s => s.name !== "(total)").slice(0, 5).map(s => `${s.name} ${(Number(s.bytes) / 1048576).toFixed(0)} MB`).join(", ")}`)
    // Everything in every schema (db_size_all, list_twenty.sql): space that isn't in any table is
    // a vacuum's temporary copy or something outside Actuent's tables, and it counts too.
    const all = await fetch(`${SUPABASE_URL}/rest/v1/rpc/db_size_all`, { method: "POST", headers: JSON_HEADERS, body: "{}" }).then(x => x.ok ? x.json() : null).catch(() => null)
    if (Array.isArray(all)) {
      const inTables = all.reduce((n: number, t: any) => n + Number(t.bytes), 0)
      const other = total - inTables
      const outside = all.filter((t: any) => t.schema_name !== "public").reduce((n: number, t: any) => n + Number(t.bytes), 0)
      console.log(`  In tables: ${(inTables / 1048576).toFixed(0)} MB (outside Actuent's own tables: ${(outside / 1048576).toFixed(0)} MB); not in any table: ${(other / 1048576).toFixed(0)} MB`)
      if (other > 100 * 1048576) warnings.push(`${(other / 1048576).toFixed(0)} MB of the database isn't in any table: usually a vacuum still running or stopped half-way. Check Supabase → Database → Query performance, or run list_twenty.sql Part 1`)
    }
    const cols = await fetch(`${SUPABASE_URL}/rest/v1/rpc/lawp_sites_column_sizes`, { method: "POST", headers: JSON_HEADERS, body: "{}" }).then(x => x.ok ? x.json() : null).catch(() => null)
    if (Array.isArray(cols)) console.log(`  lawp_sites by column: ${cols.filter((c: any) => c.estimated_mb >= 2).sort((a: any, b: any) => b.estimated_mb - a.estimated_mb).map((c: any) => `${c.column_name} ~${c.estimated_mb} MB`).join(", ")}`)
    if (total / DB_LIMIT >= WARN) warnings.push(`Database is ${pct(total / DB_LIMIT)} full (${(total / 1048576).toFixed(0)} MB of 500 MB)`)
    if (weeksLeft != null && weeksLeft < 6) warnings.push(`Database fills up in about ${weeksLeft.toFixed(0)} weeks at this week's pace`)
    await setState("watchdog_db_bytes", { bytes: total, at: now.toISOString() })
  } else console.log("Database size: not available (db_size, list_ten.sql)")

  // 2. Vercel: search time this month (real searches, not our own tests).
  let searchMs = 0, searches = 0
  // Supabase returns at most 1,000 rows per request.
  for (let offset = 0; offset < 300000; offset += 1000) {
    const page = await rows(`searches?select=duration_ms&created_at=gte.${encodeURIComponent(monthStart.toISOString())}&duration_ms=not.is.null&tier=neq.test&order=created_at.asc&limit=1000&offset=${offset}`)
    for (const s of page) { searchMs += Number(s.duration_ms) || 0; searches++ }
    if (page.length < 1000) break
  }
  const gbHours = searchMs / 3600000 * VERCEL_MEMORY_GB
  const projected = monthFraction > 0.05 ? gbHours / monthFraction : null
  console.log(`Vercel (search only): ${searches} searches this month, ${gbHours.toFixed(1)} GB-hours of ${VERCEL_GB_HOURS}${projected != null ? `, heading for about ${projected.toFixed(0)} by month end` : ""}`)
  if (gbHours / VERCEL_GB_HOURS >= WARN) warnings.push(`Vercel memory: search alone has used ${pct(gbHours / VERCEL_GB_HOURS)} of the month's 360 GB-hours`)
  else if (projected != null && projected / VERCEL_GB_HOURS >= 0.9) warnings.push(`Vercel memory: search is heading for ${pct(projected / VERCEL_GB_HOURS)} of the month's 360 GB-hours`)

  // 3. Resend: emails this month, estimated from who gets them.
  const [claimed, alerts, watches] = await Promise.all([
    count("lawp_sites?select=domain&owner_key=not.is.null&score_emails=not.is.false"),
    count("saved_searches?select=id"),
    count("price_watches?select=id")
  ])
  const emails = claimed * 4.3 + claimed + claimed * 2 + alerts * 4 + watches * 2
  console.log(`Emails (estimate): about ${Math.round(emails)} this month for ${claimed} claimed sites, ${alerts} search alerts and ${watches} price watches (limit ${EMAILS_PER_MONTH})`)
  if (emails / EMAILS_PER_MONTH >= WARN) warnings.push(`Emails: about ${Math.round(emails)} a month expected, ${pct(emails / EMAILS_PER_MONTH)} of Resend's free 3,000`)

  console.log("Supabase Edge Functions (site pages, badges, sitemaps): check Supabase → Edge Functions → api for the month's calls (free: 500,000).")
  if (warnings.length) {
    for (const w of warnings) console.log(`::error::${w}`)
    process.exitCode = 1
  } else console.log("Everything is comfortably inside the free limits.")
}

main().catch(e => { console.error(e); process.exit(1) })
