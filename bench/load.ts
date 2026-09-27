import fs from "fs"

// Load test for launch day. Sends CONCURRENCY parallel searches for DURATION_S seconds, mixing
// benchmark queries, and checks the promise that matters: every response has results or a
// plain-English message — never an empty answer or a bare error.
//   npx tsx bench/load.ts                          one machine, free tier (hits the per-IP limit fast)
//   ACTUENT_API_KEY=ak_… npx tsx bench/load.ts     as a Pro user
//   ACTUENT_INTERNAL_KEY=… npx tsx bench/load.ts   bypasses per-IP limits, to test real load
// Careful: every search can use AI quota. Keep runs short.

const API = process.env.ACTUENT_API || "https://api.actuent.ai"
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "10")
const DURATION_S = parseInt(process.env.DURATION_S || "60")
const queries: string[] = JSON.parse(fs.readFileSync(new URL("./queries.json", import.meta.url), "utf8")).map((x: any) => x.q)

type Row = { status: number, ms: number, results: number, message: boolean, codes: string[] }
const rows: Row[] = []
const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "Actuent-LoadTest/1.0" }
if (process.env.ACTUENT_API_KEY) headers["Authorization"] = `Bearer ${process.env.ACTUENT_API_KEY}`
if (process.env.ACTUENT_INTERNAL_KEY) headers["x-actuent-internal"] = process.env.ACTUENT_INTERNAL_KEY

async function one(q: string) {
  const t = Date.now()
  try {
    const r = await fetch(`${API}/api/search`, { method: "POST", headers, body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(60000) })
    const body: any = await r.json().catch(() => null)
    rows.push({ status: r.status, ms: Date.now() - t, results: body?.results?.length || 0, message: !!body?.message, codes: (body?.notices || []).map((n: any) => n.code) })
  } catch (e: any) {
    rows.push({ status: 0, ms: Date.now() - t, results: 0, message: false, codes: [String(e?.name || "error")] })
  }
}

async function main() {
  const end = Date.now() + DURATION_S * 1000
  let i = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < end) await one(queries[i++ % queries.length] + (i > queries.length ? ` ${i}` : ""))
  }))
  const by = (f: (r: Row) => boolean) => rows.filter(f).length
  const ms = rows.map(r => r.ms).sort((a, b) => a - b)
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] || 0
  const statuses: Record<string, number> = {}
  for (const r of rows) statuses[r.status] = (statuses[r.status] || 0) + 1
  const codes: Record<string, number> = {}
  for (const r of rows) for (const c of r.codes) codes[c] = (codes[c] || 0) + 1
  const silent = by(r => !r.results && !r.message)
  const summary = { requests: rows.length, per_second: Math.round(rows.length / DURATION_S * 10) / 10, statuses, notices: codes,
    with_results: by(r => r.results > 0), with_message_only: by(r => !r.results && r.message), silent_or_bare_errors: silent, p50_ms: pct(0.5), p95_ms: pct(0.95), max_ms: ms[ms.length - 1] || 0 }
  console.log(JSON.stringify(summary, null, 2))
  if (silent) { console.log(`✗ ${silent} responses had neither results nor a message`); process.exitCode = 1 } else console.log("✓ every response had results or a message")
}

main()
