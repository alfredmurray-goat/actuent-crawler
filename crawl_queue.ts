import { SUPABASE_URL, SUPABASE_HEADERS, fetchNative, fetchSite, saveSite, saveEvents, contentHash, robotsAllows, minimal } from "./shared"
import { extractEvents } from "./business"
import { fetchLlmsTxt } from "./llmstxt"
import { convertSite, domainGone } from "./convert"
import { isPublicHost } from "./safe-fetch"
import { tooFullToGrow } from "./quiet"

// Every 30 minutes: sites people searched for while Actuent was too busy to visit them live
// (crawl_queue, list_ten.sql, filled by live search). Each is added or refreshed with the same
// pipeline as the mass crawler, so "it's queued and will be added within the hour" holds.

const MAX = parseInt(process.env.QUEUE_MAX || "150")
const CONCURRENCY = 4
if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

// LLM calls one at a time (llm.ts paces them); rules only after a run of misses.
let misses = 0
let queue: Promise<unknown> = Promise.resolve()
function llm<T>(fn: () => Promise<T>): Promise<T | null> {
  if (misses >= 4) return Promise.resolve(null)
  const run = queue.then(async () => { const r = await fn(); if (r) misses = 0; else misses++; return r })
  queue = run.catch(() => {})
  return run
}

async function finish(domain: string, outcome: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/crawl_queue?domain=eq.${encodeURIComponent(domain)}`, {
    method: "PATCH", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify({ done_at: new Date().toISOString(), outcome })
  }).catch(() => {})
}

async function handle(domain: string): Promise<string> {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || !await isPublicHost(domain)) return await domainGone(domain) ? "no such domain" : "not public"
  const owner = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=owner_key&domain=eq.${encodeURIComponent(domain)}`, { headers: SUPABASE_HEADERS }).then(r => r.ok ? r.json() : []).catch(() => [])
  if (owner?.[0]?.owner_key) return "claimed (owner edits it)"
  const native = await fetchNative(domain)
  if (native) { await saveSite(native, undefined, "native"); return "native" }
  if (!await robotsAllows(domain, "/")) return "robots.txt disallows"
  const page = await fetchSite(domain)
  if (page?.isHtml) await saveEvents(domain, extractEvents(page.raw, `https://${domain}/`))
  const result = await convertSite(domain, page, page ? await fetchLlmsTxt(domain) : null, llm)
  if (result) { await saveSite(result.lawp, page ? contentHash(page.text) : undefined, result.conversion); return result.conversion }
  if (!page) return "unreachable"
  await saveSite(minimal(domain, page.text), contentHash(page.text), "minimal")
  return "minimal"
}

async function main() {
  // Sites people asked for keep coming in until the database is 92% full (it goes read-only at 100%).
  if (await tooFullToGrow(0.92)) return
  const r = await fetch(`${SUPABASE_URL}/rest/v1/crawl_queue?select=domain&done_at=is.null&order=requested_at.asc&limit=${MAX}`, { headers: SUPABASE_HEADERS })
  if (!r.ok) { console.log(`crawl_queue not available (run list_ten.sql): ${r.status}`); return }
  const todo: string[] = (await r.json()).map((x: any) => x.domain)
  console.log(`${todo.length} queued sites`)
  let i = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < todo.length) {
      const domain = todo[i++]
      let outcome = "error"
      try { outcome = await handle(domain) } catch (e: any) { outcome = `error: ${String(e?.message || e).slice(0, 80)}` }
      await finish(domain, outcome)
      console.log(`${outcome.padEnd(12)} ${domain}`)
    }
  }))
}

main().catch(e => { console.error(e); process.exit(1) })
