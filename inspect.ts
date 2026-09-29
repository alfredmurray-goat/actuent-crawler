import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"

// Debugging: how the index sees a few domains, and whether the name lookups search uses
// (brand.ts in locali_public) find them. Logs are public: only safe fields are printed, never keys.
//   npx tsx inspect.ts localilabs.com actuent.ai

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
const domains = (process.argv.slice(2).join(" ") || process.env.DOMAINS || "").split(/[\s,]+/).filter(Boolean).slice(0, 10)

async function get(path: string) {
  const t = Date.now()
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS, signal: AbortSignal.timeout(15000) }).catch(e => ({ ok: false, status: String(e?.name), text: async () => "" }) as any)
  const body = r.ok ? await r.json() : (await r.text()).slice(0, 300)
  return { status: r.status, ms: Date.now() - t, body }
}

async function main() {
// How long the search functions take for a few searches (QUERIES, separated by "|").
for (const q of (process.env.QUERIES || "").split("|").map(x => x.trim()).filter(Boolean).slice(0, 10)) {
  for (const fn of ["search_lawp_sites", "search_lawp_pages"]) {
    const t = Date.now()
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ q, max_results: 50 }), signal: AbortSignal.timeout(30000) }).catch(e => ({ ok: false, status: String(e?.name), json: async () => [], text: async () => "" }) as any)
    const body = r.ok ? await r.json() : (await r.text()).slice(0, 160)
    console.log(`${fn}("${q}"): ${r.status} in ${Date.now() - t}ms → ${Array.isArray(body) ? `${body.length} rows: ${body.slice(0, 5).map((x: any) => x.domain).join(", ")}` : body}`)
  }
  const t = Date.now()
  const top = await get(`lawp_sites?select=domain&status=is.null&popularity_rank=lte.20000&search_text=plfts(english).${encodeURIComponent(q)}&order=popularity_rank.asc&limit=40`)
  console.log(`top sites ("${q}"): ${top.status} in ${Date.now() - t}ms → ${Array.isArray(top.body) ? `${top.body.length} rows: ${top.body.slice(0, 8).map((x: any) => x.domain).join(", ")}` : top.body}`)
}
// Which of the newer tables exist (each list_*.sql adds some).
for (const table of ["search_cache", "name_websites", "query_reformulations", "search_misses", "search_vocab", "crawl_queue"]) {
  const t = await get(`${table}?select=*&limit=0`)
  console.log(`table ${table}: ${t.status === 200 ? "exists" : `missing (${t.status})`}`)
}
for (const domain of domains) {
  console.log(`\n== ${domain}`)
  const site = await get(`lawp_sites?select=domain,name,status,native,category,language,popularity_rank,updated_at,owner_key&domain=eq.${encodeURIComponent(domain)}`)
  const row = Array.isArray(site.body) ? site.body[0] : null
  console.log(row ? { ...row, owner_key: row.owner_key ? "(set)" : null } : site)
  const pages = await get(`lawp_pages?select=path&domain=eq.${encodeURIComponent(domain)}&limit=20`)
  console.log("pages:", Array.isArray(pages.body) ? pages.body.map((p: any) => p.path).join(" ") : pages)
  const label = domain.split(".")[0]
  const byDomain = await get(`lawp_sites?select=domain&status=is.null&domain=in.(${encodeURIComponent(`"${label}.com","${label}.io"`)})`)
  const byName = await get(`lawp_sites?select=domain&status=is.null&name=ilike.${encodeURIComponent(label)}&limit=5`)
  console.log("brand lookups:", { byDomain: [byDomain.status, byDomain.ms + "ms", byDomain.body], byName: [byName.status, byName.ms + "ms", byName.body] })
  if (row?.owner_key) {
    const same = await get(`lawp_sites?select=domain&owner_key=eq.${encodeURIComponent(row.owner_key)}&limit=20`)
    console.log("same owner:", Array.isArray(same.body) ? same.body.map((s: any) => s.domain) : same)
  }
}
}
main()
