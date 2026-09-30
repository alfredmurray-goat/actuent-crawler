import fs from "fs"
import readline from "readline"

// Loads each indexed site's Tranco rank (top 1M list) into lawp_sites.popularity_rank, used by
// search ranking. Weekly. Writes only popularity_rank — never updated_at. Needs list_seven.sql.

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const KEY = process.env.SUPABASE_SERVICE_KEY!
const HEADERS = { "apikey": KEY, "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" }
if (!KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

async function main() {
  const ranks = new Map<string, number>()
  const rl = readline.createInterface({ input: fs.createReadStream("./tranco_PY69J.csv"), crlfDelay: Infinity })
  for await (const line of rl) {
    const [rank, domain] = line.split(",")
    if (domain) ranks.set(domain.trim().toLowerCase(), Number(rank))
  }
  console.log(`${ranks.size} ranked domains`)
  let lastDomain = "", seen = 0, updated = 0
  // Only ranks that are missing or changed are written, a few hundred at a time (writing all ~100K rows
  // each run timed out, and rewrote rows for nothing). A busy moment: smaller batches after a pause.
  async function send(domains: string[], values: number[], size = 250): Promise<void> {
    for (let i = 0; i < domains.length; i += size) {
      const u = await fetch(`${SUPABASE_URL}/rest/v1/rpc/set_popularity`, { method: "POST", headers: HEADERS, body: JSON.stringify({ domains: domains.slice(i, i + size), ranks: values.slice(i, i + size) }) })
      if (u.ok) { updated += Math.min(size, domains.length - i); continue }
      const text = await u.text()
      if (size > 25 && /57014|timeout/i.test(text)) { await new Promise(r => setTimeout(r, 5000)); await send(domains.slice(i, i + size), values.slice(i, i + size), Math.floor(size / 4)); continue }
      throw new Error(`set_popularity: ${u.status} ${text}`)
    }
  }
  while (true) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,popularity_rank&domain=gt.${encodeURIComponent(lastDomain)}&order=domain.asc&limit=1000`, { headers: HEADERS })
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
    const rows: { domain: string, popularity_rank: number | null }[] = await r.json()
    if (!rows.length) break
    lastDomain = rows[rows.length - 1].domain
    seen += rows.length
    const domains: string[] = [], values: number[] = []
    for (const { domain, popularity_rank } of rows) {
      const rank = ranks.get(domain) ?? ranks.get(domain.replace(/^www\./, ""))
      if (rank && rank !== popularity_rank) { domains.push(domain); values.push(rank) }
    }
    if (domains.length) await send(domains, values)
  }
  console.log(`Done: ${seen} sites, ${updated} ranks added or changed`)
}

main().catch(e => { console.error(e); process.exit(1) })
