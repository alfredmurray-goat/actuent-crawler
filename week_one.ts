import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { sendEmail, lawpyImg, emailEnabled } from "./email"

// Daily: one email a week after someone signs up, never more.
//   • Pro accounts (api_keys, the account's first key) whose sign-up day was exactly 7 days ago:
//     what Pro does that they may not have tried yet.
//   • Weekly-email subscribers (newsletter, confirmed) who confirmed exactly 7 days ago: three things to
//     try with their AI, how to connect it, and the launch code while it's still valid.
// "Exactly 7 days ago" is a whole UTC day, so a daily run never sends anyone two. Replies go to
// hello@localilabs.com. DRY_RUN=1 only counts; PREVIEW_TO=you@… sends one of each there instead.
const REPLY = "hello@localilabs.com"

const DRY = !!process.env.DRY_RUN
const CODE_UNTIL = "2026-10-21" // PH553M: launch week only
const day = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10)
const get = (path: string) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS, signal: AbortSignal.timeout(30000) }).then(r => r.ok ? r.json() : []).catch(() => []) as Promise<any[]>
const foot = (why: string) => `<p style="color:#666;font-size:13px">Actuent, made by localilabs. ${why}</p>`
const box = (rows: [string, string][]) => `<table cellpadding="8" style="border-collapse:collapse;font-size:15px;margin:6px 0 14px">${rows.map(([a, b]) => `<tr><td style="vertical-align:top;font-size:20px">${a}</td><td>${b}</td></tr>`).join("")}</table>`

function proEmail(): { subject: string, html: string } {
  return {
    subject: "A week with Actuent Pro: 5 things worth trying",
    html: `${lawpyImg("wave")}<p>Hi! You've had Actuent Pro for a week. Here's what it does that most people haven't tried yet. Just ask your AI:</p>
${box([
  ["🔔", `<strong>"Tell me when tickets for [artist] go on sale"</strong><br><span style="color:#555">Actuent watches the page and emails you. Works for "back in stock" too.</span>`],
  ["💸", `<strong>"Watch this and tell me if the price drops"</strong> (with a product link)<br><span style="color:#555">A price-drop email, with a cart link when it's a Shopify shop.</span>`],
  ["✉️", `<strong>"Ask the restaurant if they have gluten-free options"</strong><br><span style="color:#555">Actuent emails the business for you; they reply to you directly. Your AI shows you the text first.</span>`],
  ["🧠", `<strong>"Remember I'm vegan and I live in Copenhagen"</strong><br><span style="color:#555">Used on your searches from then on. See or delete it in Analytics → Account.</span>`],
  ["🏪", `<strong>Have a website?</strong> Claim it in <a href="https://analytics.actuent.ai">Analytics → My sites</a><br><span style="color:#555">See what AI assistants find about it, and decide what they see.</span>`]
])}
<p>Questions or something that didn't work? Just reply. Lawpy reads everything (Alfred does too).</p>
${foot("You get this once, a week after joining Actuent Pro.")}`
  }
}

function subscriberEmail(token: string): { subject: string, html: string } {
  const unsubscribe = `https://api.actuent.ai/api/newsletter?unsubscribe=${token}`
  const code = new Date().toISOString().slice(0, 10) <= CODE_UNTIL
  return {
    subject: "Your AI + the live internet: 3 things to try",
    html: `${lawpyImg("wave")}<p>Hi! A week ago you signed up for Actuent's weekly email. Here are three things your AI can't do on its own, but can with Actuent connected:</p>
${box([
  ["🎷", `<strong>"What's on tonight near me? Add the best one to my calendar."</strong>`],
  ["👟", `<strong>"Is this in stock in my size?"</strong> (paste any shop link)`],
  ["🍷", `<strong>"Plan dinner then drinks on Friday and give me a link to send my friends."</strong>`]
])}
<p><strong>Not connected yet?</strong> It takes 30 seconds and it's free, no account: <a href="https://docs.actuent.ai/connect">docs.actuent.ai/connect</a> (it's a tiny game: beat the Hallucinator 👻).</p>
${code ? `<p>🎁 Launch week only: code <strong>PH553M</strong> gives 55% off your first 3 months of Pro (until ${CODE_UNTIL.slice(8)} October).</p>` : ""}
${foot(`You get this because you signed up for the weekly State of the AI web. <a href="${unsubscribe}">Unsubscribe</a>`)}`
  }
}

async function main() {
  if (!emailEnabled && !DRY) { console.log("RESEND_API_KEY isn't set"); return }
  if (process.env.PREVIEW_TO) {
    for (const m of [proEmail(), subscriberEmail("preview")]) await sendEmail(process.env.PREVIEW_TO, `[Preview] ${m.subject}`, m.html, undefined, REPLY)
    console.log("Previews sent"); return
  }
  const [keys, subs] = await Promise.all([
    get(`api_keys?select=email,created_at&parent_key_hash=is.null&active=eq.true&created_at=gte.${day}&created_at=lt.${next}&limit=1000`),
    get(`newsletter?select=email,token&confirmed_at=gte.${day}&confirmed_at=lt.${next}&unsubscribed_at=is.null&limit=1000`)
  ])
  const pro = [...new Set(keys.map(k => String(k.email || "").toLowerCase()).filter(e => e.includes("@")))]
  const proSet = new Set(pro)
  // Someone who is both gets the Pro one only.
  const readers = subs.filter(s => s.email && !proSet.has(String(s.email).toLowerCase()))
  console.log(`Signed up ${day}: ${pro.length} Pro, ${readers.length} weekly-email${DRY ? " (dry run)" : ""}`)
  if (DRY) return
  let sent = 0
  for (const email of pro) { const m = proEmail(); if (await sendEmail(email, m.subject, m.html, undefined, REPLY)) sent++; await new Promise(r => setTimeout(r, 600)) }
  for (const s of readers) {
    const m = subscriberEmail(s.token), unsub = `https://api.actuent.ai/api/newsletter?unsubscribe=${s.token}`
    if (await sendEmail(s.email, m.subject, m.html, { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, REPLY)) sent++
    await new Promise(r => setTimeout(r, 600))
  }
  console.log(`Sent ${sent}`)
}

main().catch(e => { console.error(e); process.exit(1) })
