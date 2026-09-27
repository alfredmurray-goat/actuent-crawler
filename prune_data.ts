import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"

// Weekly: deletes old rows that aren't needed any more, so the database stays well under the
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
  { table: "lawp_events", filter: `start_date=lt.${days(60)}`, why: "past events: 60 days after they start" }
]

async function countRows(table: string, filter: string): Promise<number | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&${filter}`, { method: "HEAD", headers: { ...SUPABASE_HEADERS, "Prefer": "count=exact", "Range": "0-0" } }).catch(() => null)
  const total = r?.headers.get("content-range")?.split("/")[1]
  return r?.ok && total && total !== "*" ? Number(total) : null
}

async function main() {
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
