import crypto from "crypto"

// Tells search engines about new and changed pages on api.actuent.ai right away (IndexNow: Bing,
// Yandex, Seznam, Naver and others share submissions). Daily: site pages updated since the last
// run, plus the directory and city pages. Reads only; writes nothing to the database.

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const KEY = process.env.SUPABASE_SERVICE_KEY!
const HEADERS = { "apikey": KEY, "Authorization": `Bearer ${KEY}` }
const HOST = "api.actuent.ai"
const SINCE_HOURS = parseInt(process.env.SINCE_HOURS || "26")
if (!KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

// Same key as api.actuent.ai/indexnow.txt (locali_public/src/handlers/indexnow.ts).
const indexNowKey = crypto.createHash("sha256").update(`indexnow:${KEY}`).digest("hex").slice(0, 32)
const slug = (v: string) => v.toLowerCase().replace(/ø/g, "o").replace(/æ/g, "ae").replace(/å/g, "a").replace(/ß/g, "ss").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

async function main() {
  const since = new Date(Date.now() - SINCE_HOURS * 3600_000).toISOString()
  const urls = new Set<string>([`https://${HOST}/site`, `https://${HOST}/state/weekly`])
  // This week's State of the AI web post (weekly_report.ts, Mondays).
  const [post] = await fetch(`${SUPABASE_URL}/rest/v1/weekly_reports?select=week&created_at=gte.${encodeURIComponent(since)}&order=week.desc&limit=1`, { headers: HEADERS }).then(r => r.ok ? r.json() : []).catch(() => [])
  if (post?.week) urls.add(`https://${HOST}/state/weekly/${post.week}`)
  let last = ""
  while (urls.size < 50000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain&updated_at=gte.${encodeURIComponent(since)}&actions=neq.%5B%5D&status=is.null&domain=gt.${encodeURIComponent(last)}&order=domain.asc&limit=1000`, { headers: HEADERS })
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
    const rows: { domain: string }[] = await r.json()
    if (!rows.length) break
    for (const { domain } of rows) urls.add(`https://${HOST}/site/${domain}`)
    last = rows[rows.length - 1].domain
  }
  const cities = await fetch(`${SUPABASE_URL}/rest/v1/rpc/lawp_city_categories?min_sites=3`, { headers: HEADERS }).then(r => r.ok ? r.json() : []).catch(() => [])
  for (const c of cities) if (c.city && !["adult", "gambling"].includes(c.category)) { urls.add(`https://${HOST}/site/in/${slug(c.city)}`); urls.add(`https://${HOST}/site/in/${slug(c.city)}/${c.category}`) }
  const list = [...urls]
  console.log(`${list.length} URLs to submit`)
  for (let i = 0; i < list.length; i += 10000) {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: HOST, key: indexNowKey, keyLocation: `https://${HOST}/indexnow.txt`, urlList: list.slice(i, i + 10000) })
    })
    console.log(`IndexNow: HTTP ${res.status} for ${Math.min(10000, list.length - i)} URLs${res.ok ? "" : ` — ${await res.text()}`}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
