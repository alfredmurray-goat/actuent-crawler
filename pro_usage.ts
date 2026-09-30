import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { sendEmail, esc, emailEnabled, lawpyImg } from "./email"

// Daily: Pro keys that came close to their limit (60 searches a minute) yesterday get a friendly
// heads-up, before their app starts getting "slow down" answers. Close = 48 or more in one minute
// (80%). Counted from the search log; nothing about what was searched goes in the email.

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
const LIMIT = 60, WARN = Math.ceil(LIMIT * 0.8)

async function main() {
  if (!emailEnabled) { console.log("RESEND_API_KEY isn't set — skipping"); return }
  const end = new Date(); end.setUTCHours(0, 0, 0, 0)
  const start = new Date(end.getTime() - 86400000)
  const perMinute = new Map<string, Map<string, number>>()
  for (let offset = 0; offset < 500000; offset += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/searches?select=api_key,created_at&api_key=not.is.null&created_at=gte.${start.toISOString()}&created_at=lt.${end.toISOString()}&order=created_at.asc&limit=1000&offset=${offset}`, { headers: SUPABASE_HEADERS }).catch(() => null)
    const rows: any[] = r?.ok ? await r.json() : []
    for (const x of rows) {
      const m = perMinute.get(x.api_key) || new Map<string, number>(); const k = String(x.created_at).slice(0, 16)
      m.set(k, (m.get(k) || 0) + 1); perMinute.set(x.api_key, m)
    }
    if (rows.length < 1000) break
  }
  let sent = 0
  for (const [key, minutes] of perMinute) {
    const busiest = Math.max(...minutes.values())
    if (busiest < WARN) continue
    const close = [...minutes.values()].filter(n => n >= WARN).length
    const [account] = await fetch(`${SUPABASE_URL}/rest/v1/api_keys?select=email&key_hash=eq.${key}`, { headers: SUPABASE_HEADERS }).then(r => r.ok ? r.json() : []).catch(() => [])
    if (!account?.email) continue
    const html = `${lawpyImg("think")}<p>Hi,</p>
<p>Yesterday your Actuent Pro key came close to its limit of ${LIMIT} searches a minute: <strong>${busiest}</strong> in its busiest minute, and ${close} minute${close === 1 ? "" : "s"} over ${WARN}.</p>
<p>Past ${LIMIT} a minute, searches get a "slow down" answer (HTTP 429 with how long to wait). If your app sends bursts, spread them out a little, or use a separate key per app (Analytics → Account → API keys) so one busy app doesn't hold up the others.</p>
<p>Need more? Just reply to this email.</p>
<p style="color:#666;font-size:13px">Actuent, made by localilabs. A heads-up about your own usage; we send it at most once a day.</p>`
    if (await sendEmail(account.email, `Actuent: your key came close to ${LIMIT} searches a minute`, html)) sent++
  }
  console.log(`Pro usage: ${perMinute.size} keys searched yesterday, ${sent} heads-ups sent`)
}

main().catch(e => { console.error(e); process.exit(1) })
