import { SUPABASE_URL, SUPABASE_HEADERS, fetchNative, scrapeJina, scrapeBasic, toLAWP, saveSite } from "./shared"

// Improves minimal "Website at …" entries (saved when the crawler was blocked or out of Groq
// quota): re-scrape them and convert properly. Oldest first; sites that still can't be improved
// get their updated_at bumped so the next run moves on to others.

const LIMIT = parseInt(process.env.RECONVERT_LIMIT || "150")
// One at a time: the crawler models' free-tier per-minute limits allow roughly one conversion a minute.
const CONCURRENCY = parseInt(process.env.RECONVERT_CONCURRENCY || "1")
const MAX_CONSECUTIVE_LLM_FAILURES = 10

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
if (!process.env.GROQ_API_KEY) { console.error("Missing GROQ_API_KEY"); process.exit(1) }

async function minimalDomains(): Promise<string[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain&actions=eq.%5B%5D&order=updated_at.asc&limit=${LIMIT}`, { headers: SUPABASE_HEADERS })
  if (!r.ok) throw new Error(`Could not load minimal sites: ${r.status} ${await r.text()}`)
  return (await r.json()).map((row: any) => row.domain)
}

async function touch(domain: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(domain)}`, {
    method: "PATCH",
    headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ updated_at: new Date().toISOString() })
  })
}

async function main() {
  const domains = await minimalDomains()
  console.log(`Re-converting up to ${domains.length} minimal sites`)
  let improved = 0, skipped = 0, llmFailures = 0, index = 0, stop = false

  async function worker() {
    while (!stop && index < domains.length) {
      const domain = domains[index++]
      try {
        const native = await fetchNative(domain)
        if (native) { await saveSite(native); improved++; console.log(`native   ${domain}`); continue }

        const content = await scrapeJina(domain) ?? await scrapeBasic(domain)
        if (!content) { await touch(domain); skipped++; console.log(`blocked  ${domain}`); continue }

        const lawp = await toLAWP(domain, content)
        if (Array.isArray(lawp.actions) && lawp.actions.length > 0) {
          await saveSite(lawp); improved++; llmFailures = 0
          console.log(`improved ${domain}`)
        } else {
          await touch(domain); skipped++
          if (++llmFailures >= MAX_CONSECUTIVE_LLM_FAILURES) {
            console.log("Groq models look exhausted for today — stopping")
            stop = true
          }
        }
      } catch (e) {
        skipped++
        console.log(`error    ${domain}: ${e}`)
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  console.log(`Done. Improved ${improved}, skipped ${skipped}.`)
}

main()
