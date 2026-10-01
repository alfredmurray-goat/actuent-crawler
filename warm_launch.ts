// Launch week (13–16 October 2026): keeps the questions Product Hunt visitors are told to try in the
// search cache, so they answer instantly. Every 20 minutes; outside launch week it does nothing (each
// warm-up is a Vercel invocation, and the free plan's limits matter).

const QUESTIONS = [
  "concerts in new york this weekend", "what's open near me right now", "cheapest hoka clifton", "does notion have a free plan",
  "what is actuent", "lawpy", "hello", "what is a cat", "cafes in brooklyn", "best burger in new york", "tacos in austin",
  "concerts in los angeles", "notion vs obsidian", "cheapest airpods pro", "café in copenhagen that's open now", "concerts copenhagen this weekend"
]

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
