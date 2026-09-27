import { cleanPageText, cleanPages, changedText } from "./boilerplate"

// Weekly: strips cookie banners, menus and copyright lines from page text already in the index
// (crawled before the crawlers cleaned it themselves). Only non-native, unclaimed sites — a site's
// own LAWP and owner-edited text are left as written. Writes only the text, never updated_at, and
// only if the row hasn't changed since it was read, so it can run alongside the crawlers.
// DRY_RUN=1 prints before/after for the first changes and writes nothing.

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const KEY = process.env.SUPABASE_SERVICE_KEY!
const HEADERS = { "apikey": KEY, "Authorization": `Bearer ${KEY}` }
const DRY = !!process.env.DRY_RUN
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "100") * 60000
if (!KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

const started = Date.now()
let shown = 0

function show(label: string, before: string, after: string) {
  if (shown++ < 15) console.log(`\n[${label}]\n  before: ${before.slice(0, 240)}\n  after:  ${after.slice(0, 240)}`)
}

async function patch(url: string, body: any): Promise<boolean> {
  if (DRY) return true
  const r = await fetch(url, { method: "PATCH", headers: { ...HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify(body) })
  return r.ok
}

async function sites(): Promise<number> {
  let last = "", changed = 0, seen = 0
  while (Date.now() - started < TIME_BUDGET_MS / 2) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,pages,updated_at&native=is.false&owner_key=is.null&domain=gt.${encodeURIComponent(last)}&order=domain.asc&limit=1000`, { headers: HEADERS })
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
    const rows: any[] = await r.json()
    if (!rows.length) break
    for (const row of rows) {
      seen++
      const pages = cleanPages(row.pages)
      if (!pages) continue
      const path = Object.keys(pages).find(p => pages[p] !== row.pages[p])!
      show(row.domain, row.pages[path]?.content || "", pages[path].content)
      // updated_at=eq. makes the write a no-op if a crawler saved the site in the meantime.
      if (await patch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(row.domain)}&updated_at=eq.${encodeURIComponent(row.updated_at)}`, { pages })) changed++
    }
    last = rows[rows.length - 1].domain
  }
  console.log(`\nSites: ${seen} read, ${changed} ${DRY ? "would be " : ""}cleaned`)
  return changed
}

async function subpages(): Promise<number> {
  let last = "", changed = 0, seen = 0
  while (Date.now() - started < TIME_BUDGET_MS) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_pages?select=full_url,content,updated_at&full_url=gt.${encodeURIComponent(last)}&order=full_url.asc&limit=1000`, { headers: HEADERS })
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
    const rows: any[] = await r.json()
    if (!rows.length) break
    for (const row of rows) {
      seen++
      if (typeof row.content !== "string") continue
      const content = cleanPageText(row.content)
      if (!changedText(row.content, content)) continue
      show(row.full_url, row.content, content)
      if (await patch(`${SUPABASE_URL}/rest/v1/lawp_pages?full_url=eq.${encodeURIComponent(row.full_url)}&updated_at=eq.${encodeURIComponent(row.updated_at)}`, { content })) changed++
    }
    last = rows[rows.length - 1].full_url
  }
  console.log(`Pages: ${seen} read, ${changed} ${DRY ? "would be " : ""}cleaned`)
  return changed
}

async function main() {
  await sites()
  await subpages()
}

main().catch(e => { console.error(e); process.exit(1) })
