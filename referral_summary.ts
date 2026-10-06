import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { sendEmail, esc, emailEnabled, lawpyImg } from "./email"

// Monthly (the 1st): referrers who earned free months last month get one short email saying so, with
// their link's clicks so far. Only in months they earned something, so it's never noise.
// DRY_RUN=1 only prints.

async function get(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS })
  return r.ok ? r.json() : []
}

async function main() {
  const now = new Date()
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString()
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const month = new Date(from).toLocaleString("en", { month: "long", timeZone: "UTC" })
  const conversions = await get(`referral_conversions?select=code,credited&created_at=gte.${encodeURIComponent(from)}&created_at=lt.${encodeURIComponent(to)}`)
  const byCode = new Map<string, { joined: number, credited: number }>()
  for (const c of conversions) {
    const x = byCode.get(c.code) || { joined: 0, credited: 0 }
    x.joined++; if (c.credited) x.credited++
    byCode.set(c.code, x)
  }
  console.log(`${conversions.length} referred sign-ups in ${month}, ${byCode.size} referrers`)
  for (const [code, { joined, credited }] of byCode) {
    const [ref] = await get(`referrals?select=email,clicks&code=eq.${encodeURIComponent(code)}`)
    if (!ref?.email) continue
    const months = credited === 1 ? "one free month" : `${credited} free months`
    const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;color:#1a1a1a">
${lawpyImg("dance")}
<p>Hi! In ${esc(month)}, <strong>${joined}</strong> ${joined === 1 ? "person" : "people"} joined Actuent Pro through your link${credited ? `, so you've earned <strong>${months}</strong> of Pro, already taken off your next bill` : ""}.</p>
${credited < joined ? `<p>${joined - credited} of them couldn't be credited yet (usually because your Stripe account wasn't found). We'll keep trying; if it doesn't show up, reply to this email.</p>` : ""}
<p>Your link has been opened <strong>${Number(ref.clicks || 0)}</strong> times so far: <a href="https://agents.actuent.ai/r/${esc(code)}">agents.actuent.ai/r/${esc(code)}</a></p>
<p>Lawpy says thanks. He's taking partial credit.</p>
<p style="color:#777;font-size:12px">You get this email only in months your link earns you something. Questions: support@localilabs.com</p></div>`
    if (process.env.DRY_RUN || !emailEnabled) { console.log(`${code}: ${joined} joined, ${credited} credited (would email)`); continue }
    const ok = await sendEmail(ref.email, credited ? `You earned ${months} of Actuent Pro` : `${joined} ${joined === 1 ? "person" : "people"} joined Actuent through your link`, html)
    console.log(`${code}: ${ok ? "emailed" : "email failed"}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
