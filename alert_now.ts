import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { sendEmail, esc } from "./email"

// Launch week, every 5 minutes: is Actuent working right now? Three checks the way a user meets it:
// a search on the website API, the AI connector (MCP tools/list and a real search through it), and the
// health light. Anything broken → an email to hello@localilabs.com straight away, once an hour per
// problem (a counter in usage_counters; if the database itself is down, at most every 30 minutes).

const TO = process.env.ALERT_TO || "hello@localilabs.com"
const UA = { "User-Agent": "Actuent-Alerts/1.0" }

async function timed<T>(f: () => Promise<T>): Promise<{ ms: number, value: T | null, error?: string }> {
  const t = Date.now()
  try { const value = await f(); return { ms: Date.now() - t, value } } catch (e: any) { return { ms: Date.now() - t, value: null, error: String(e?.message || e).slice(0, 200) } }
}

async function main() {
  const problems: string[] = []
  const search = await timed(async () => { const r = await fetch(`https://api.actuent.ai/api/search?q=coffee+copenhagen&alert=${Date.now()}`, { headers: UA, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
  if (search.error || !((search.value as any)?.results?.length)) problems.push(`Search on the website/API failed: ${search.error || "no results for 'coffee copenhagen'"}`)
  else if (search.ms > 10000) problems.push(`Search is very slow: ${Math.round(search.ms / 1000)} s for 'coffee copenhagen'`)
  const mcp = await timed(async () => {
    const r = await fetch("https://agents.actuent.ai/api/mcp", { method: "POST", headers: { ...UA, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "actuent_events", arguments: { location: "Copenhagen", when: "this week" } } }), signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d: any = await r.json()
    if (d?.result?.isError || !d?.result?.content?.[0]?.text) throw new Error(String(d?.result?.content?.[0]?.text || d?.error?.message || "empty answer").slice(0, 160))
    return d
  })
  if (mcp.error) problems.push(`The AI connector (MCP) failed: ${mcp.error}`)
  const health = await timed(async () => (await fetch("https://agents.actuent.ai/health?deep=1", { signal: AbortSignal.timeout(25000) })).json())
  const h: any = health.value
  if (h?.light === "red") problems.push(`Health light is RED: ${(h.checks || []).filter((c: any) => c.light === "red").map((c: any) => `${c.name} (${c.detail})`).join(", ")}`)

  console.log(problems.length ? `${problems.length} problem(s)` : "All fine")
  if (!problems.length) return
  // Once an hour per kind of problem.
  const fresh: string[] = []
  for (const p of problems) {
    const key = `alert:${p.split(":")[0].toLowerCase().replace(/[^a-z]+/g, "_").slice(0, 40)}`
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/hit_counter_add`, { method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ k: key, window_seconds: 3600, n: 1 }), signal: AbortSignal.timeout(5000) }).catch(() => null)
    const n = r?.ok ? Number(await r.json()) : null
    if (n === 1 || (n === null && new Date().getUTCMinutes() < 5) || (n === null && new Date().getUTCMinutes() >= 30 && new Date().getUTCMinutes() < 35)) fresh.push(p)
  }
  if (!fresh.length) { console.log("Already emailed about these this hour"); return }
  await sendEmail(TO, `🚨 Actuent: ${fresh[0].split(":")[0]}`, `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px">
<h2 style="margin:0 0 10px">Something's wrong right now</h2><ul>${fresh.map(p => `<li>${esc(p)}</li>`).join("")}</ul>
<p>Checked ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC. Search took ${Math.round(search.ms / 100) / 10} s, the AI connector ${Math.round(mcp.ms / 100) / 10} s.</p>
<p>Live view: <a href="https://analytics.actuent.ai/ops">analytics.actuent.ai/ops</a> · Status: <a href="https://api.actuent.ai/status">api.actuent.ai/status</a></p>
<p style="color:#777;font-size:12px">Paste this into Claude Code and say "fix this". You get at most one email an hour per problem.</p></div>`)
  console.log("Emailed")
}

main().catch(e => { console.error(e); process.exit(1) })
