import { sendEmail, esc, lawpyImg, emailEnabled } from "./email"

// One of every email Actuent sends, with sample data, to PREVIEW_TO (default hello@localilabs.com),
// so they can be read and checked in a real inbox. Subjects start with "[Preview]". Nothing else is
// sent and no data is read or changed. Run: Actions → Email Previews.
// The wording mirrors each job's template (score_emails, weekly_report, holiday_reminders, watches,
// saved_searches, change_alerts, page_watches, pro_usage, referral_summary, launch_watch, monthly_report)
// and actuent-public's (welcome, newsletter confirmation, business messages, receipts).

const TO = process.env.PREVIEW_TO || "hello@localilabs.com"
const unsub = `<a href="https://api.actuent.ai/api/unsubscribe">Unsubscribe</a>`
const foot = (why: string) => `<p style="color:#666;font-size:13px">Actuent, made by localilabs. ${why}</p>`
const wrap = (body: string) => `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;line-height:1.6">${body}</div>`
const btn = (href: string, label: string, color = "#ff8a3d") => `<a href="${href}" style="display:inline-block;background:${color};color:#0a0a0a;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700">${label}</a>`
const quote = (t: string) => `<blockquote style="border-left:3px solid #ff8a3d;margin:12px 0;padding:4px 14px;white-space:pre-wrap">${esc(t)}</blockquote>`

const EMAILS: [string, string, string][] = [
  // ── For people who claimed their site ──
  ["Site owner · welcome", "lagkagehuset.dk is live on Actuent", wrap(`<img src="https://api.actuent.ai/assets/lawpy/lawpy-dance.gif" width="108" height="72" alt="Lawpy" style="display:block;margin:0 0 6px;border:0">
<h2 style="margin:0 0 12px">lagkagehuset.dk is live on Actuent 🎉</h2>
<p>You've claimed <strong>lagkagehuset.dk</strong>. AI agents using Actuent (in ChatGPT, Claude and other apps) now see the version you control.</p>
<p>${btn("https://api.actuent.ai/site/lagkagehuset.dk", "See what AI agents see →")}</p>
<p><strong>Next steps</strong></p><ol><li>Edit your pages and actions any time in <a href="https://analytics.actuent.ai">Analytics → My sites</a>.</li><li>Make actions executable by publishing your own <code>/.well-known/lawp.json</code>.</li><li>Work through the <a href="https://docs.actuent.ai/checklist">agent-ready checklist</a>.</li><li>Show your score: <code>&lt;img src="https://api.actuent.ai/badge.svg?domain=lagkagehuset.dk"&gt;</code></li></ol>
<p>Questions? Just reply to this email.</p>${foot("You got this email because you claimed lagkagehuset.dk on Actuent.")}`)],
  ["Site owner · weekly digest", "lagkagehuset.dk: 78/100 agent-ready (up from 71)", `${lawpyImg("wave")}<p>Hi,</p>
<p><strong>Lagkagehuset</strong> is <strong>78/100</strong> agent-ready this week (up from 71): mostly agent-ready.</p>
<p>AI bots visited 214 times in the last 7 days (GPTBot 96, ClaudeBot 71, PerplexityBot 47).</p>
<p>Among 38 similar sites (bakeries in Copenhagen) you're <strong>#4</strong>. 21 of them have something you don't: opening hours for holidays.</p>
<p>You came up in <strong>63</strong> searches this week and Actuent sent you <strong>12</strong> visits.<br>Top searches: bakery copenhagen open now <span style="color:#666">(9)</span>, cinnamon bun nørrebro <span style="color:#666">(5)</span></p>
<p><strong>Agents looked for this on your site but couldn't find it:</strong><br>Gluten-free options <span style="color:#666">(4 searches)</span><br>Add it in <a href="https://analytics.actuent.ai">the editor</a>.</p>
<p><strong>Your next step (+15 points):</strong> Add holiday opening hours.<br>Use schema.org specialOpeningHoursSpecification, or add them in Analytics.</p>
<p><a href="https://api.actuent.ai/site/lagkagehuset.dk">See your full score and starter files →</a></p>${foot(`You get this weekly because you claimed lagkagehuset.dk on Actuent. ${unsub}`)}`],
  ["Site owner · holiday reminder", "lagkagehuset.dk: holiday hours for Juleaftensdag?", `${lawpyImg("think")}<p>Hi,</p>
<p>A public holiday is coming up: <strong>Juleaftensdag (Thursday, 24 December)</strong>.</p>
<p>AI assistants read <strong>Lagkagehuset</strong>'s opening hours from your site, and they don't cover this day yet. If your hours are different, add them as holiday hours (or in <a href="https://analytics.actuent.ai">Analytics</a>), so assistants don't send people to a closed door.</p>${foot(`You get this because you claimed lagkagehuset.dk on Actuent. ${unsub}`)}`],
  ["Site owner · change alert", "lagkagehuset.dk: 2 things changed on your site", `${lawpyImg("think")}<p>Hi,</p><p>Actuent noticed some changes on <strong>lagkagehuset.dk</strong> since yesterday:</p>
<ul><li>Opening hours changed to: Mon–Fri 07:00–18:00; Sat–Sun 08:00–17:00</li><li>This link now shows an error or "not found", so agents can't send people there: https://lagkagehuset.dk/bestil</li></ul>
<p>If that's intended, there's nothing to do. If not, it's worth fixing before customers (and their AI assistants) run into it.</p>
<p><a href="https://analytics.actuent.ai">Edit what agents see →</a></p>${foot(`You get this because you claimed lagkagehuset.dk on Actuent. ${unsub}`)}`],
  ["Site owner · lawp.json broke", "lagkagehuset.dk: something changed on your site", `${lawpyImg("think")}<p>Hi,</p><p>Actuent noticed a change on <strong>lagkagehuset.dk</strong> since yesterday:</p>
<ul><li>Your /.well-known/lawp.json has a problem, so AI agents fall back to guessing about your site: it isn't valid JSON any more (a missing comma or quote?). Check it at https://docs.actuent.ai/checklist?site=lagkagehuset.dk</li></ul>
<p><a href="https://analytics.actuent.ai">Edit what agents see →</a></p>${foot(`You get this because you claimed lagkagehuset.dk on Actuent. ${unsub}`)}`],
  ["Site owner · monthly report (off by default)", "lagkagehuset.dk and AI agents: your September 2026 report", `${lawpyImg("talk")}<p>Hi,</p>
<p>Here's how AI agents saw <strong>Lagkagehuset</strong> on Actuent over the last 30 days.</p>
<table cellpadding="6" style="border-collapse:collapse;font-size:15px"><tr><td>In AI agents' search results</td><td><strong>241</strong> times</td></tr><tr><td>Visits Actuent sent you</td><td><strong>38</strong></td></tr><tr><td>Agent-readiness score</td><td><strong>78/100</strong></td></tr></table>
<p><strong>Searches you came up for:</strong><br>bakery copenhagen <span style="color:#666">(31)</span><br>cinnamon bun <span style="color:#666">(12)</span></p>${foot(`You get this because you claimed lagkagehuset.dk on Actuent. ${unsub}`)}`],
  ["Site owner · message from an AI user", "Question from Maria via their AI assistant", wrap(`<p>Maria (maria@example.com) sent a question for lagkagehuset.dk through their AI assistant:</p>${quote("Hi! Do you have gluten-free bread at the Nørrebro shop on Saturdays?")}
<p>Just reply to this email to answer them.</p><p style="color:#777;font-size:12px">Sent by Actuent, which helps AI assistants find and contact businesses. Don't want messages like this? <a href="https://api.actuent.ai">Stop messages for lagkagehuset.dk</a>.</p>`)],
  ["Site owner · booking request", "Booking request from Maria via their AI assistant", wrap(`<p>Maria (maria@example.com) sent a booking request for noma.dk through their AI assistant:</p>${quote("A table for 4 on Friday, if you have one. We're celebrating a birthday!")}
<p><strong>2026-10-16 at 19:00, 4 people</strong></p><p>${btn("https://api.actuent.ai", "Accept", "#3fb950")} &nbsp; ${btn("https://api.actuent.ai", "Decline", "#cccccc")}</p>
<p>Just reply to this email to answer them (or use the buttons).</p><p style="color:#777;font-size:12px">Sent by Actuent. You see these in Actuent Analytics → Inbox too.</p>`)],

  // ── For people using Actuent through their AI ──
  ["User · message receipt", "Sent: your question to lagkagehuset.dk", wrap(`<p>Your AI assistant sent this to <strong>lagkagehuset.dk</strong> through Actuent:</p>${quote("Hi! Do you have gluten-free bread at the Nørrebro shop on Saturdays?")}<p>They'll answer you by email, at this address.</p><p style="color:#777;font-size:12px">Didn't mean to? Reply to this email and tell us.</p>`)],
  ["User · booking accepted", "noma.dk accepted your booking request", wrap(`<p><strong>noma.dk</strong> accepted your request for 2026-10-16 19:00, 4 people.</p><p>See you there! Reply to their email if anything changes.</p>`)],
  ["User · booking declined", "noma.dk declined your booking request", wrap(`<p><strong>noma.dk</strong> declined your request for 2026-10-16 19:00, 4 people.</p><p>Your AI assistant can help find another time or place.</p>`)],
  ["User · action receipt", "Done: Request a callback on vinumhistoria.dk", wrap(`<p>Your AI assistant did this for you through Actuent:</p><p><strong>Request a callback</strong> on <strong>vinumhistoria.dk</strong></p><p style="white-space:pre-wrap;color:#444">{ "status": "received", "message": "We'll call you back within one working day." }</p><p style="color:#777;font-size:12px">This can be undone on the site. Questions: support@localilabs.com</p>`)],
  ["User · price drop (Pro)", "Price drop: HOKA Clifton 9 is now 1049 DKK (−22%)", `${lawpyImg("dance")}<p><strong>HOKA Clifton 9</strong> on runnersworld.dk dropped from €180.00 to <strong>€140.70</strong> (1049 DKK), 22% off.</p><p><a href="https://example.com">View it on runnersworld.dk →</a></p><p style="color:#666;font-size:13px">You're getting this because you asked your AI assistant to watch this product with Actuent. Ask it to stop watching to turn this off.</p>`],
  ["User · back in stock (Pro)", "Back in stock: Men's Tree Runners", `${lawpyImg("dance")}<p><strong>Men's Tree Runners</strong> is available again on allbirds.com, at 100 USD.</p><p><a href="https://www.allbirds.com/cart/33179624702032:1" style="background:#ff8a3d;color:#111;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:600">Buy it now (opens the shop's cart) →</a></p><p><a href="https://www.allbirds.com/products/mens-tree-runners">View it on allbirds.com →</a></p><p style="color:#666;font-size:13px">You're getting this because you asked your AI assistant to watch this product with Actuent. Ask it to stop watching to turn this off.</p>`],
  ["User · page watch (Pro)", "Cat Power tickets now says “tickets on sale”", `${lawpyImg("dance")}<p>The page you asked Actuent to watch now says “tickets on sale”:</p><p><a href="https://vega.dk">Cat Power tickets</a></p><p style="color:#666;font-size:13px">You're getting this because you asked your AI assistant to watch this page with Actuent. Ask it to stop watching to turn this off.</p>`],
  ["User · saved search alert (Pro)", "New on Actuent for “vegan café copenhagen”: Plant Power Food", `${lawpyImg("dance")}<p>Hi,</p><p>A new site matches your saved search <strong>“vegan café copenhagen”</strong>:</p><ul><li><a href="https://api.actuent.ai/site/plantpowerfood.dk">Plant Power Food</a> (plantpowerfood.dk)<br><span style="color:#555">A plant-based café in Vesterbro with brunch, cakes and coffee.</span></li></ul><p><a href="https://humans.actuent.ai/?q=vegan%20caf%C3%A9%20copenhagen">See all results →</a></p>${foot("You get this because you saved this search. Remove it in Actuent Analytics → Alerts, or ask your AI assistant to stop the alert.")}`],
  ["User · Pro usage heads-up", "Actuent: your key came close to 60 searches a minute", `${lawpyImg("think")}<p>Hi,</p><p>Yesterday your Actuent Pro key came close to its limit of 60 searches a minute: <strong>57</strong> in its busiest minute, and 3 minutes over 48.</p><p>Past 60 a minute, searches get a "slow down" answer (HTTP 429 with how long to wait). If your app sends bursts, spread them out a little, or use a separate key per app (Analytics → Account → API keys).</p><p>Need more? Just reply to this email.</p>${foot("A heads-up about your own usage; we send it at most once a day.")}`],
  ["User · referral summary", "You earned one free month of Actuent Pro", wrap(`${lawpyImg("dance")}<p>Hi! In September, <strong>2</strong> people joined Actuent Pro through your link, so you've earned <strong>one free month</strong> of Pro, already taken off your next bill.</p><p>1 of them couldn't be credited yet (usually because your Stripe account wasn't found). We'll keep trying; if it doesn't show up, reply to this email.</p><p>Your link has been opened <strong>41</strong> times so far: <a href="https://agents.actuent.ai/r/alfred">agents.actuent.ai/r/alfred</a></p><p>Lawpy says thanks. He's taking partial credit.</p><p style="color:#777;font-size:12px">You get this email only in months your link earns you something. Questions: support@localilabs.com</p>`)],

  // ── Weekly email for everyone who signed up ──
  ["Everyone · weekly email sign-up confirmation", "Confirm: the State of the AI web, weekly", wrap(`<img src="https://api.actuent.ai/assets/lawpy/lawpy-wave.gif" width="108" height="72" alt="Lawpy" style="display:block;margin:0 0 6px;border:0"><p>Hi! Someone (hopefully you) asked for Actuent's weekly "State of the AI web" email at this address.</p><p>${btn("https://api.actuent.ai", "Yes, send it to me →")}</p><p style="color:#666;font-size:13px">If it wasn't you, ignore this email and nothing more will be sent.</p>`)],
  ["Everyone · weekly email", "The State of the AI web, week 41", `${lawpyImg("talk")}<h2 style="margin:0 0 12px">The State of the AI web, week 41</h2>
<p>98,198 websites are now readable by AI assistants through Actuent, and 13,442 events are coming up, from Copenhagen's libraries to Chicago comedy.</p><p>The most asked question this week: "what's on tonight?"</p>
<p><a href="https://api.actuent.ai/state">Read it on the web, with the charts →</a></p>
<p><strong>Your AI got smarter this week:</strong> <a href="https://api.actuent.ai/smarter">see what Lawpy found →</a></p>
<p><strong>Try this week</strong> (ask your AI, with Actuent connected):</p><ul><li>What's on near me this weekend? Add the best one to my calendar.</li><li>Is my size in stock here? (paste any shop link)</li><li>Plan dinner then drinks near me on Friday, and give me a link to send my friends.</li></ul>${foot(`You get this because you signed up for the weekly State of the AI web. ${unsub}`)}`],

  // ── For you ──
  ["Alfred · launch-day hourly report", "Launch watch: 3 empty, 1 reported, 0 busy (last hour)", wrap(`<p>Last hour: 412 searches, 3 found nothing, 0 busy answers, 1 reported wrong answers.</p><h3>Searches that found nothing</h3><ul><li>ramen in boise <strong>×2</strong></li><li>dog friendly bars in porto</li></ul><h3>Wrong answers people reported</h3><ul><li><strong>is tivoli open today</strong> (actuent_search): It said open, but Tivoli is closed for the season <em>Should be: closed until 13 November</em></li></ul><p style="color:#777;font-size:12px">Paste this into Claude Code and say "fix these".</p>`)]
]

async function main() {
  if (!emailEnabled) { console.error("RESEND_API_KEY isn't set"); process.exit(1) }
  let sent = 0
  for (const [label, subject, html] of EMAILS) {
    const ok = await sendEmail(TO, `[Preview] ${subject}`, `<p style="font:12px monospace;color:#999;border-bottom:1px solid #eee;padding-bottom:6px">PREVIEW · ${esc(label)} · sample data</p>${html}`)
    console.log(`${ok ? "sent" : "FAILED"}: ${label}`)
    if (ok) sent++
    await new Promise(r => setTimeout(r, 700)) // Resend allows 2 a second
  }
  console.log(`${sent} of ${EMAILS.length} previews sent to ${TO}`)
  if (sent < EMAILS.length) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
