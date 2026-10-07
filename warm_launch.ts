// Launch week (13–16 October 2026): keeps the questions Product Hunt visitors are told to try (and ~180
// more they are likely to) in the
// search cache, so they answer instantly. Every 20 minutes; outside launch week it does nothing (each
// warm-up is a Vercel invocation, and the free plan's limits matter).

// The questions people are told to try (every run)…
const CORE = [
  "concerts in new york this weekend", "what's open near me right now", "cheapest hoka clifton", "does notion have a free plan",
  "what is actuent", "lawpy", "hello", "what is a cat", "cafes in brooklyn", "best burger in new york", "tacos in austin",
  "concerts in los angeles", "notion vs obsidian", "cheapest airpods pro", "café in copenhagen that's open now", "concerts copenhagen this weekend",
  "what's on in copenhagen tonight", "comedy in chicago this week", "jazz in copenhagen this week", "is the louvre open on monday"
]
// …and ~180 more a Product Hunt visitor is likely to try, in turns (60 a run, all of them every hour).
const CITIES = ["new york", "san francisco", "london", "los angeles", "chicago", "austin", "seattle", "boston", "berlin", "copenhagen", "paris", "amsterdam", "toronto", "stockholm"]
const KINDS = ["coffee open now in", "best pizza in", "vegan restaurant in", "concerts this weekend in", "things to do today in", "bars open late in", "brunch in", "museums open today in"]
const MORE = [
  ...CITIES.flatMap(c => KINDS.map(k => `${k} ${c}`)).filter((_, i) => i % 2 === 0),
  "cheapest nike pegasus", "cheapest iphone 16", "best running shoes", "best noise cancelling headphones", "cheapest macbook air",
  "does spotify have a student discount", "how much is chatgpt plus", "does figma have a free plan", "best password manager", "best crm for startups",
  "figma vs canva", "stripe vs paypal", "slack vs teams", "openai", "anthropic", "latest news about ai", "what time does trader joe's close",
  "where is new balance from", "who owns zara", "best project management tool", "vpn", "weather in new york", "markets in copenhagen this weekend"
]
const QUESTIONS = (() => {
  const slot = Math.floor(Date.now() / (20 * 60_000)) % Math.ceil(MORE.length / 60)
  return [...CORE, ...MORE.slice(slot * 60, slot * 60 + 60)]
})()

async function main() {
  const today = new Date().toISOString().slice(0, 10)
  if (!process.env.FORCE && (today < "2026-10-13" || today > "2026-10-16")) { console.log(`Not launch week (${today}): nothing to warm.`); return }
  for (const q of QUESTIONS) {
    const t = Date.now()
    const r = await fetch(`https://api.actuent.ai/api/search?q=${encodeURIComponent(q)}`, { headers: { "User-Agent": "Actuent-Warm/1.0" }, signal: AbortSignal.timeout(30000) }).catch(() => null)
    console.log(`${r?.status ?? "failed"} ${String(Date.now() - t).padStart(5)}ms ${q}`)
    await new Promise(res => setTimeout(res, 3500)) // under the free rate limit
  }
}

main().catch(e => { console.error(e); process.exit(1) })
