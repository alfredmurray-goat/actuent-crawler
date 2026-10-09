import fs from "fs"
import crypto from "crypto"

// Load test. Sends searches for DURATION_S seconds, either at a steady RATE per minute (RATE=500) or
// as fast as CONCURRENCY parallel searchers can, mixing benchmark queries, and reports:
//   • the promise that matters: every response has results or a plain-English message, never silence;
//   • speed (p50/p95/p99) and which part of a search the time goes to (the Server-Timing header:
//     sites, products and the steps inside), and the slowest searches.
//   npx tsx bench/load.ts                          one machine, free tier (hits the per-IP limit fast)
//   ACTUENT_API_KEY=… npx tsx bench/load.ts        as a Pro user (60 a minute)
//   SUPABASE_SERVICE_KEY=… RATE=500 npx tsx …      signed as a load test: no rate limit, logged as a test
//                                                  (Actions → Load Test does this; the key never leaves GitHub)
// Careful: every search can use AI quota and database time. Keep runs short, never in launch week.

const API = process.env.ACTUENT_API || "https://api.actuent.ai"
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "10")
const RATE = parseInt(process.env.RATE || "0")
const DURATION_S = Math.min(parseInt(process.env.DURATION_S || "60"), 300)
const queries: string[] = JSON.parse(fs.readFileSync(new URL("./queries.json", import.meta.url), "utf8")).map((x: any) => x.q)

type Row = { q: string, status: number, ms: number, results: number, message: boolean, codes: string[], timing: Record<string, number> }
const rows: Row[] = []
const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "Actuent-LoadTest/1.0" }
if (process.env.ACTUENT_API_KEY) headers["Authorization"] = `Bearer ${process.env.ACTUENT_API_KEY}`
if (process.env.ACTUENT_INTERNAL_KEY) headers["x-actuent-internal"] = process.env.ACTUENT_INTERNAL_KEY
// A signed load-test pass (api/search.ts checks it): this minute, signed with a secret both sides have.
function loadTestToken(): string | null {
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!key) return null
  const minute = Math.floor(Date.now() / 60000)
  return `${minute}.${crypto.createHmac("sha256", key).update(`loadtest:${minute}`).digest("hex").slice(0, 32)}`
}

async function one(q: string) {
  const t = Date.now()
  const token = loadTestToken()
  try {
    const r = await fetch(`${API}/api/search`, { method: "POST", headers: { ...headers, ...(token ? { "x-actuent-loadtest": token } : {}) }, body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(60000) })
    const body: any = await r.json().catch(() => null)
    const timing: Record<string, number> = {}
    for (const part of String(r.headers.get("server-timing") || "").split(",")) { const m = part.trim().match(/^([\w-]+);dur=([\d.]+)/); if (m) timing[m[1]] = Number(m[2]) }
    rows.push({ q, status: r.status, ms: Date.now() - t, results: body?.results?.length || 0, message: !!body?.message, codes: (body?.notices || []).map((n: any) => n.code), timing })
  } catch (e: any) {
    rows.push({ q, status: 0, ms: Date.now() - t, results: 0, message: false, codes: [String(e?.name || "error")], timing: {} })
  }
}

async function main() {
  const end = Date.now() + DURATION_S * 1000
  let i = 0
  const next = () => queries[i % queries.length] + (i++ >= queries.length ? ` ${Math.floor(i / queries.length)}` : "")
  if (RATE > 0) {
    // Steady rate: one search every 60/RATE seconds, however long each takes.
    const pending: Promise<void>[] = []
    while (Date.now() < end) { pending.push(one(next())); await new Promise(r => setTimeout(r, 60000 / RATE)) }
    await Promise.all(pending)
  } else {
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (Date.now() < end) await one(next()) }))
  }
  const by = (f: (r: Row) => boolean) => rows.filter(f).length
  const ms = rows.map(r => r.ms).sort((a, b) => a - b)
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] || 0
  const statuses: Record<string, number> = {}
  for (const r of rows) statuses[r.status] = (statuses[r.status] || 0) + 1
  const codes: Record<string, number> = {}
  for (const r of rows) for (const c of r.codes) codes[c] = (codes[c] || 0) + 1
  // Where the time goes: the average and p95 of each Server-Timing part, slowest first.
  const parts: Record<string, number[]> = {}
  for (const r of rows) for (const [k, v] of Object.entries(r.timing)) (parts[k] ||= []).push(v)
  const where = Object.entries(parts).map(([k, v]) => { const s = [...v].sort((a, b) => a - b); return { part: k, avg_ms: Math.round(v.reduce((a, b) => a + b, 0) / v.length), p95_ms: Math.round(s[Math.floor(s.length * 0.95)] || 0), samples: v.length } })
    .sort((a, b) => b.p95_ms - a.p95_ms)
  const silent = by(r => !r.results && !r.message)
  const summary = { requests: rows.length, per_minute: Math.round(rows.length / DURATION_S * 60), statuses, notices: codes,
    with_results: by(r => r.results > 0), with_message_only: by(r => !r.results && r.message), silent_or_bare_errors: silent, p50_ms: pct(0.5), p95_ms: pct(0.95), p99_ms: pct(0.99), max_ms: ms[ms.length - 1] || 0 }
  console.log(JSON.stringify(summary, null, 2))
  console.log("\nWhere the time goes (Server-Timing, slowest p95 first):")
  for (const w of where.slice(0, 12)) console.log(`  ${w.part.padEnd(22)} avg ${String(w.avg_ms).padStart(5)} ms   p95 ${String(w.p95_ms).padStart(5)} ms   (${w.samples})`)
  console.log("\nSlowest searches:")
  for (const r of [...rows].sort((a, b) => b.ms - a.ms).slice(0, 10)) console.log(`  ${String(r.ms).padStart(6)} ms  ${r.status}  ${r.q}`)
  if (silent) { console.log(`\n✗ ${silent} responses had neither results nor a message`); process.exitCode = 1 } else console.log("\n✓ every response had results or a message")
}

main()
