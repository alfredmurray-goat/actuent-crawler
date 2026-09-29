import fs from "fs"
import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"

// Weekly (and after each benchmark): sites Actuent should have but doesn't are queued for crawling
// (crawl_queue.ts adds them within the hour):
//   • every site the search benchmark expects (bench/queries.json) — a miss there is often just a
//     site missing from the index (museodelprado.es, allbirds.com, ikea.com…)
//   • the country shop lists in seeds/shops.json (Danish, German, Swedish shops).

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
const JSON_HEADERS = { ...SUPABASE_HEADERS, "Content-Type": "application/json" }

function wanted(): string[] {
  const out = new Set<string>()
  const bench = JSON.parse(fs.readFileSync("./bench/queries.json", "utf8"))
  for (const q of Array.isArray(bench) ? bench : bench.queries || []) for (const d of q.domains || []) out.add(String(d).toLowerCase())
  const shops = JSON.parse(fs.readFileSync("./seeds/shops.json", "utf8"))
  for (const [k, list] of Object.entries(shops)) if (!k.startsWith("_")) for (const d of list as string[]) out.add(d.toLowerCase())
  // Only whole sites: "aws.amazon.com" style hosts are fine, paths aren't.
  return [...out].filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
}

async function main() {
  const domains = wanted()
  const have = new Set<string>()
  for (let i = 0; i < domains.length; i += 100) {
    const list = encodeURIComponent(domains.slice(i, i + 100).map(d => `"${d}"`).join(","))
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain&domain=in.(${list})`, { headers: SUPABASE_HEADERS })
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
    for (const row of await r.json()) have.add(row.domain)
  }
  const missing = domains.filter(d => !have.has(d))
  for (const d of missing) {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/queue_crawl`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ d }) }).catch(() => {})
  }
  console.log(`${domains.length} wanted sites, ${have.size} already indexed, ${missing.length} queued: ${missing.join(", ")}`)
}

main().catch(e => { console.error(e); process.exit(1) })
