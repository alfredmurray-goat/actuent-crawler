import fs from "fs"
import path from "path"

// Search quality benchmark: fixed queries with known good answers, run against the live API.
// A result counts as right when its domain is in the expected list (or matches the expected TLD
// or category, for local searches). Reports hit@1, hit@5, MRR and latency, saves them to
// search_benchmarks (list_seven.sql) for the ops page, and writes the GitHub job summary.

type Case = { q: string, domains?: string[], tld?: string, category?: string, language?: string }
const API = process.env.ACTUENT_API || "https://api.actuent.ai"
const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const KEY = process.env.SUPABASE_SERVICE_KEY
const cases: Case[] = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "queries.json"), "utf8"))
const bare = (d: string) => d.toLowerCase().replace(/^www\./, "")

function right(c: Case, r: any): boolean {
  const d = bare(String(r?.domain || "").split("/")[0])
  if (c.domains?.some(x => d === bare(x) || d.endsWith(`.${bare(x)}`))) return true
  if (c.tld && d.endsWith(c.tld)) return !c.category || !r.category || r.category === c.category
  return false
}

async function main() {
  const rows: any[] = []
  for (const c of cases) {
    const started = Date.now()
    let results: any[] = [], error = ""
    try {
      const res = await fetch(`${API}/api/search?q=${encodeURIComponent(c.q)}&bench=1`, { headers: { "User-Agent": "Actuent-Benchmark/1.0", "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(60000) })
      results = res.ok ? ((await res.json()).results || []) : []
      if (!res.ok) error = `HTTP ${res.status}`
    } catch (e: any) { error = String(e?.message || e) }
    const ms = Date.now() - started
    const rank = results.slice(0, 10).findIndex(r => right(c, r)) + 1
    rows.push({ q: c.q, rank: rank || null, ms, top: results.slice(0, 3).map(r => r.domain), ...(error ? { error } : {}) })
    console.log(`${rank === 1 ? "✓ " : rank ? `${rank} ` : "✗ "} ${String(ms).padStart(6)}ms  ${c.q}  →  ${results.slice(0, 3).map(r => r.domain).join(", ") || error || "(nothing)"}`)
    await new Promise(r => setTimeout(r, 3500)) // stay under the free rate limit
  }
  const n = rows.length
  const hit1 = rows.filter(r => r.rank === 1).length / n
  const hit5 = rows.filter(r => r.rank && r.rank <= 5).length / n
  const mrr = rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n
  const times = rows.map(r => r.ms).sort((a, b) => a - b)
  const p50 = times[Math.floor(n * 0.5)], p95 = times[Math.min(n - 1, Math.floor(n * 0.95))]
  const summary = { queries: n, hit_at_1: Math.round(hit1 * 1000) / 10, hit_at_5: Math.round(hit5 * 1000) / 10, mrr: Math.round(mrr * 1000) / 1000, p50_ms: p50, p95_ms: p95 }
  console.log(JSON.stringify(summary))
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Search benchmark\n\n| hit@1 | hit@5 | MRR | p50 | p95 |\n|---|---|---|---|---|\n| ${summary.hit_at_1}% | ${summary.hit_at_5}% | ${summary.mrr} | ${p50} ms | ${p95} ms |\n\n| Query | Rank | Time | Top 3 |\n|---|---|---|---|\n${rows.map(r => `| ${r.q} | ${r.rank ?? "✗"} | ${r.ms} ms | ${r.top.join(", ")} |`).join("\n")}\n`)
  }
  if (KEY) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/search_benchmarks`, {
      method: "POST", headers: { "apikey": KEY, "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify({ ...summary, details: rows })
    })
    console.log(r.ok ? "Saved to search_benchmarks" : `Not saved: ${r.status} ${await r.text()}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
