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

// The kind of search, so a change that helps one kind and hurts another shows up.
const SHOPPING = /\b(shoes?|sneakers?|headphones|desk|furniture|monitor|laptop|bike|jacket|kaufen|buy|zapatos|sko|löbesko|løbesko|laufschuhe)\b/i
function kind(c: Case): string {
  if (/^\S+\.[a-z]{2,}(\/\S*)?$/i.test(c.q)) return "domain"
  if (c.tld || c.category) return "local"
  if (c.language || /[^\x00-\x7f]/.test(c.q)) return "foreign"
  if (SHOPPING.test(c.q)) return "shopping"
  if ((c.domains?.length || 0) <= 2 && c.q.split(/\s+/).length <= 3) return "name"
  return "topic"
}

async function main() {
  const rows: any[] = []
  for (const c of cases) {
    const started = Date.now()
    let results: any[] = [], error = "", dbMs: number | null = null
    try {
      const res = await fetch(`${API}/api/search?q=${encodeURIComponent(c.q)}&bench=1`, { headers: { "User-Agent": "Actuent-Benchmark/1.0", "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(60000) })
      results = res.ok ? ((await res.json()).results || []) : []
      // The database part of the time (Server-Timing "plain"), so slowness and wrong answers are told apart.
      const plain = (res.headers.get("server-timing") || "").match(/plain;dur=(\d+)/)
      dbMs = plain ? Number(plain[1]) : null
      if (!res.ok) error = `HTTP ${res.status}`
    } catch (e: any) { error = String(e?.message || e) }
    const ms = Date.now() - started
    const rank = results.slice(0, 10).findIndex(r => right(c, r)) + 1
    rows.push({ q: c.q, kind: kind(c), rank: rank || null, ms, db_ms: dbMs, top: results.slice(0, 3).map(r => r.domain), ...(error ? { error } : {}) })
    console.log(`${rank === 1 ? "✓ " : rank ? `${rank} ` : "✗ "} ${String(ms).padStart(6)}ms ${dbMs != null ? `(db ${String(dbMs).padStart(5)})` : "          "}  ${c.q}  →  ${results.slice(0, 3).map(r => r.domain).join(", ") || error || "(nothing)"}`)
    await new Promise(r => setTimeout(r, 3500)) // stay under the free rate limit
  }
  // The first 41 queries are the original set: their numbers stay comparable across runs as
  // queries are added. Network failures on the benchmark's side (not Actuent's) don't count.
  const stats = (list: any[]) => {
    const n = list.length || 1
    const times = list.map(r => r.ms).sort((a, b) => a - b)
    return {
      queries: list.length, hit_at_1: Math.round(list.filter(r => r.rank === 1).length / n * 1000) / 10,
      hit_at_5: Math.round(list.filter(r => r.rank && r.rank <= 5).length / n * 1000) / 10,
      mrr: Math.round(list.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n * 1000) / 1000,
      p50_ms: times[Math.floor(list.length * 0.5)] || 0, p95_ms: times[Math.min(list.length - 1, Math.floor(list.length * 0.95))] || 0,
      db_p50_ms: (() => { const db = list.map(r => r.db_ms).filter((x: any) => x != null).sort((a, b) => a - b); return db[Math.floor(db.length * 0.5)] ?? null })()
    }
  }
  const networkErrors = rows.filter(r => /fetch failed|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(r.error || ""))
  const counted = rows.filter(r => !networkErrors.includes(r))
  const summary = stats(counted)
  const original = stats(counted.filter(r => cases.findIndex(c => c.q === r.q) < 41))
  const p50 = summary.p50_ms, p95 = summary.p95_ms
  const byKind = Object.fromEntries([...new Set(counted.map(r => r.kind))].sort().map(k => [k, stats(counted.filter(r => r.kind === k))]))
  console.log(JSON.stringify({ ...summary, original_41: original, network_errors: networkErrors.length }))
  for (const [k, v] of Object.entries(byKind)) console.log(`  ${k.padEnd(9)} ${String(v.queries).padStart(3)} searches · hit@1 ${v.hit_at_1}% · hit@5 ${v.hit_at_5}% · median ${v.p50_ms} ms`)
  if (networkErrors.length > rows.length * 0.1) { console.log(`✗ ${networkErrors.length} requests failed on the benchmark's side (no connection): this run isn't valid.`); process.exitCode = 1; return }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Search benchmark\n\n| hit@1 | hit@5 | MRR | p50 | p95 |\n|---|---|---|---|---|\n| ${summary.hit_at_1}% | ${summary.hit_at_5}% | ${summary.mrr} | ${p50} ms | ${p95} ms |\n\nOriginal 41 queries: hit@1 ${original.hit_at_1}%, hit@5 ${original.hit_at_5}%, MRR ${original.mrr}\n\n| Kind | Searches | hit@1 | hit@5 | median |\n|---|---|---|---|---|\n${Object.entries(byKind).map(([k, v]) => `| ${k} | ${v.queries} | ${v.hit_at_1}% | ${v.hit_at_5}% | ${v.p50_ms} ms |`).join("\n")}\n\n| Query | Rank | Time | Top 3 |\n|---|---|---|---|\n${rows.map(r => `| ${r.q} | ${r.rank ?? "✗"} | ${r.ms} ms | ${r.top.join(", ")} |`).join("\n")}\n`)
  }
  if (KEY) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/search_benchmarks`, {
      method: "POST", headers: { "apikey": KEY, "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify({ ...(({ db_p50_ms, ...cols }) => cols)(summary), details: { original_41: original, by_kind: byKind, db_p50_ms: summary.db_p50_ms, rows } })
    })
    console.log(r.ok ? "Saved to search_benchmarks" : `Not saved: ${r.status} ${await r.text()}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
