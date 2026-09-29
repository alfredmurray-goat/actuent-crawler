import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"

// Heavy jobs (mass crawl, OpenStreetMap, recrawls, conversions, products…) share the database with
// live search. They stop when searches need it:
//   • during busy hours, 08:00–21:00 UTC (daytime in Europe, morning to afternoon in the US), and
//   • when speed_alert.ts found searches slow in the last hour (crawler_state search_slow_until).
// Runs started by hand (workflow_dispatch) or with IGNORE_PEAK=1 aren't stopped for busy hours.
const PEAK_START = 8, PEAK_END = 21
let checked: { at: number, reason: string | null } | null = null

export async function searchNeedsTheDatabase(): Promise<string | null> {
  if (checked && Date.now() - checked.at < 5 * 60_000) return checked.reason
  let reason: string | null = null
  const hour = new Date().getUTCHours()
  const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch" || process.env.IGNORE_PEAK === "1"
  if (!manual && hour >= PEAK_START && hour < PEAK_END) reason = `busy hours (${PEAK_START}:00–${PEAK_END}:00 UTC)`
  if (!reason) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/crawler_state?id=eq.search_slow_until&select=value`, { headers: SUPABASE_HEADERS }).catch(() => null)
    const rows = r?.ok ? await r.json() : []
    const until = (Number(rows?.[0]?.value) || 0) * 60_000 // stored in minutes (fits any number column)
    if (until > Date.now()) reason = `searches were slow in the last hour (pausing until ${new Date(until).toISOString().slice(11, 16)} UTC)`
  }
  if (reason && reason !== checked?.reason) console.log(`Stopping: ${reason}. Search comes first; the next run carries on.`)
  checked = { at: Date.now(), reason }
  return reason
}

export async function markSearchSlow(minutes: number): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/crawler_state?on_conflict=id`, {
    method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify({ id: "search_slow_until", value: Math.floor(Date.now() / 60_000) + minutes })
  }).catch(() => {})
}
