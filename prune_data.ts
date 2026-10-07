import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"

// Nightly: deletes old rows that aren't needed any more, so the database stays well under the
// Supabase free plan's 500 MB, and the retention periods in the privacy policy
// (docs.actuent.ai/privacy#retention) hold. Only old history is removed; sites and pages never are.
// DRY_RUN=1 only counts.

const DRY = !!process.env.DRY_RUN
if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

const days = (n: number) => encodeURIComponent(new Date(Date.now() - n * 86400000).toISOString())
const RULES: { table: string, filter: string, why: string }[] = [
  { table: "lawp_checks", filter: `created_at=lt.${days(30)}`, why: "endpoint checks: 30 days" },
  { table: "lawp_diffs", filter: `detected_at=lt.${days(180)}`, why: "LAWP change history: 180 days" },
  { table: "lawp_item_prices", filter: `observed_at=lt.${days(365)}`, why: "price history: 12 months" },
  { table: "searches", filter: `created_at=lt.${days(365)}`, why: "search log: 12 months" },
  { table: "action_log", filter: `created_at=lt.${days(365)}`, why: "action log: 12 months" },
  { table: "crawl_queue", filter: `done_at=lt.${days(30)}`, why: "finished crawl requests: 30 days" },
  { table: "used_tokens", filter: `used_at=lt.${days(30)}`, why: "used sign-in links: 30 days" },
  { table: "search_cache", filter: `expires_at=lt.${days(0)}`, why: "expired cached searches" },
  { table: "query_reformulations", filter: `updated_at=lt.${days(180)}`, why: "rewritten searches: 180 days" },
  { table: "name_websites", filter: `checked_at=lt.${days(90)}`, why: "name lookups: 90 days (looked up again when needed)" },
  { table: "search_misses", filter: `checked_at=lt.${days(60)}`, why: "search misses: 60 days" },
  { table: "site_scores", filter: `week=lt.${days(56).slice(0, 10)}`, why: "weekly scores: 8 weeks" },
  { table: "lawp_events", filter: `start_date=lt.${days(14)}`, why: "past events: 2 weeks after they start" },
  { table: "lawp_events", filter: `start_date=gt.${days(-42)}&description=like.*ibrary*`, why: "library events more than 6 weeks ahead (read again when they're closer)" },
  { table: "lawp_events", filter: `start_date=gt.${days(-183)}`, why: "events more than 6 months ahead" },
  { table: "usage_counters", filter: `window_start=lt.${days(2)}&key=not.like.tool_day*`, why: "usage counters: 2 days" },
  { table: "usage_counters", filter: `window_start=lt.${days(35)}&key=like.tool_day*`, why: "Pro tool use per day: 35 days" },
  { table: "rate_limits", filter: `window_start=lt.${days(1)}`, why: "rate-limit records: a day" },
  { table: "blocked", filter: `until=lt.${days(1)}`, why: "expired blocks" },
  { table: "action_messages", filter: `created_at=lt.${days(365)}`, why: "messages to businesses: 12 months" },
  { table: "uptime_checks", filter: `checked_at=lt.${days(90)}`, why: "uptime checks: 90 days" }
]

// Hidden sites (parked, unreachable, duplicates) never show up in search: their page text and
// actions are cleared (the row stays, so they aren't crawled again as new), which frees space.
// Product price history: everything from the last 30 days, then one price a week (thin_price_history,
// list_twentyone.sql). Keeps the 90-day price charts and "lowest in 90 days" right.
// Minimal sites over 30 days old that nobody searched for (sweep_minimal, list_twentythree.sql): onto
// the skip list, first week of each month.
async function sweepMinimal(): Promise<void> {
  if (DRY || new Date().getUTCDate() > 7) return
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sweep_minimal`, { method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ max_rows: 5000 }), signal: AbortSignal.timeout(120000) }).catch(() => null)
  console.log(r?.ok ? `minimal sites: ${await r.json()} swept onto the skip list` : `minimal sites: not swept (${r?.status ?? "no answer"}; list_twentythree.sql)`)
}

async function thinPrices(): Promise<void> {
  if (DRY) { console.log("price history thinning: skipped (dry run)"); return }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/thin_price_history`, { method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(120000) }).catch(() => null)
  console.log(r?.ok ? `price history: ${await r.json()} older prices thinned to one a week` : `price history: not thinned (${r?.status ?? "no answer"}; list_twentyone.sql)`)
}

async function emptyHidden(): Promise<void> {
  if (DRY) { console.log("hidden sites: skipped (dry run)"); return }
  let total = 0
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain&status=not.is.null&pages=neq.%7B%7D&limit=500`, { headers: SUPABASE_HEADERS }).catch(() => null)
    const rows: any[] = r?.ok ? await r.json() : []
    if (!rows.length) break
    const list = encodeURIComponent(rows.map(x => `"${x.domain}"`).join(","))
    const u = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=in.(${list})`, {
      method: "PATCH", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify({ pages: {}, actions: [] })
    }).catch(() => null)
    if (!u?.ok) { console.log(`hidden sites: update failed ${u?.status}`); break }
    total += rows.length
  }
  console.log(`hidden sites: page text cleared on ${total}`)
}

async function countRows(table: string, filter: string): Promise<number | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&${filter}`, { method: "HEAD", headers: { ...SUPABASE_HEADERS, "Prefer": "count=exact", "Range": "0-0" } }).catch(() => null)
  const total = r?.headers.get("content-range")?.split("/")[1]
  return r?.ok && total && total !== "*" ? Number(total) : null
}

async function main() {
  // The heavier clean-ups once a week (Wednesday), old rows every night.
  if (new Date().getUTCDay() === 3 || process.env.FULL === "1") {
    await emptyHidden()
    await thinPrices()
    await sweepMinimal()
  }
  for (const { table, filter, why } of RULES) {
    const n = await countRows(table, filter)
    if (n === null) { console.log(`${table}: not available, skipped`); continue }
    if (!n || DRY) { console.log(`${table}: ${n} old rows${DRY ? " (dry run)" : ""} — ${why}`); continue }
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, { method: "DELETE", headers: { ...SUPABASE_HEADERS, "Prefer": "return=minimal" } })
    console.log(`${table}: ${r.ok ? `deleted ${n}` : `failed ${r.status} ${(await r.text()).slice(0, 120)}`} — ${why}`)
  }
  // Size after pruning, with a warning from 80% of the free plan's 500 MB.
  const size = await fetch(`${SUPABASE_URL}/rest/v1/rpc/db_size`, { method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" }, body: "{}" }).then(r => r.ok ? r.json() : null).catch(() => null)
  const total = Number(size?.find?.((x: any) => x.name === "(total)")?.bytes || 0) / 1048576
  if (total) {
    console.log(`Database: ${Math.round(total)} MB of 500 MB (${Math.round(total / 5)}%)`)
    if (total > 400) { console.log(`::warning::Database is at ${Math.round(total)} MB of the 500 MB free plan — prune more or upgrade.`); process.exitCode = 1 }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
