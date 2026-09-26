// Daily reliability check for executable LAWP actions: sends a signed test request (test: true,
// no input) to every endpoint in every native lawp.json, through the LAWP Checker, which records
// each result for the 30-day reliability shown on site pages and in the checker.

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const KEY = process.env.SUPABASE_SERVICE_KEY!
const CHECK_API = "https://agents.actuent.ai/api/lawp-check"
// The checker allows 10 checks a minute per IP.
const PAUSE_MS = 7000

if (!KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain&native=is.true&limit=1000`, { headers: { "apikey": KEY, "Authorization": `Bearer ${KEY}` } })
  const sites: string[] = r.ok ? (await r.json()).map((x: any) => x.domain) : []
  console.log(`${sites.length} native sites`)
  let ok = 0, failed = 0
  for (const domain of sites) {
    const check = await fetch(`${CHECK_API}?domain=${encodeURIComponent(domain)}`).then(r => r.json()).catch(() => null)
    await sleep(PAUSE_MS)
    for (const action of (check?.actions || []).filter((a: any) => a.executable)) {
      const res = await fetch(CHECK_API, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, action_id: action.id, source: "daily" })
      }).then(r => r.json()).catch(() => null)
      if (res?.executed) ok++; else failed++
      console.log(`${res?.executed ? "ok  " : "FAIL"} ${domain} ${action.id}${res?.executed ? "" : `: ${res?.error || "no response"}`}`)
      await sleep(PAUSE_MS)
    }
  }
  console.log(`Done: ${ok} ok, ${failed} failed`)
}

main().catch(e => { console.error(e); process.exit(1) })
