import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto"
import { gzipSync, gunzipSync } from "zlib"
import fs from "fs"
import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"

// Weekly backup of what Actuent can't rebuild by crawling again: accounts and keys (hashed), claimed
// sites' owners, saved searches, price watches, sign-ups, referrals, plus the whole sites table.
// The file is gzipped and then encrypted (AES-256-GCM, key derived from the Supabase service key), so
// it can sit as a workflow artifact on this public repository without anyone else being able to read it.
//   Make one:   SUPABASE_SERVICE_KEY=… npx tsx backup.ts                 → backup/actuent-<date>.bin
//   Read one:   SUPABASE_SERVICE_KEY=… npx tsx backup.ts restore <file>  → <file>.json (nothing is written to the database)

const TABLES: { table: string, order: string }[] = [
  { table: "api_keys", order: "created_at" }, { table: "user_site_accounts", order: "created_at" }, { table: "saved_searches", order: "created_at" },
  { table: "price_watches", order: "created_at" }, { table: "newsletter", order: "created_at" }, { table: "referrals", order: "created_at" },
  { table: "site_watch", order: "created_at" }, { table: "client_sites", order: "created_at" }, { table: "webhooks", order: "created_at" },
  { table: "lawp_sites", order: "domain" }
]

const key = () => createHash("sha256").update(`actuent-backup:${process.env.SUPABASE_SERVICE_KEY}`).digest()

async function dump(table: string, order: string): Promise<any[] | null> {
  const rows: any[] = []
  for (let offset = 0; ; offset += 1000) {
    let r: Response | null = null
    for (let attempt = 0; attempt < 3 && !r?.ok; attempt++) {
      r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&order=${order}.asc&limit=1000&offset=${offset}`, { headers: SUPABASE_HEADERS, signal: AbortSignal.timeout(60000) }).catch(() => null)
      if (r?.status === 404 || r?.status === 400) return offset ? rows : null // table (or column) doesn't exist
      if (!r?.ok) await new Promise(res => setTimeout(res, 5000))
    }
    if (!r?.ok) throw new Error(`${table}: failed at row ${offset} (${r?.status})`)
    const page: any[] = await r.json()
    rows.push(...page)
    if (page.length < 1000) return rows
    await new Promise(res => setTimeout(res, 200)) // gentle on the free database
  }
}

async function backup() {
  const out: Record<string, any[]> = {}
  for (const { table, order } of TABLES) {
    const rows = await dump(table, order).catch(async e => { console.log(String(e)); return null })
    if (rows === null) { console.log(`${table}: skipped`); continue }
    out[table] = rows
    console.log(`${table}: ${rows.length} rows`)
  }
  const plain = gzipSync(Buffer.from(JSON.stringify({ made_at: new Date().toISOString(), tables: out })))
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  fs.mkdirSync("backup", { recursive: true })
  const file = `backup/actuent-${new Date().toISOString().slice(0, 10)}.bin`
  fs.writeFileSync(file, Buffer.concat([Buffer.from("ACTB1"), iv, cipher.getAuthTag(), body]))
  console.log(`${file}: ${(fs.statSync(file).size / 1048576).toFixed(1)} MB (encrypted)`)
}

function restore(file: string) {
  const data = fs.readFileSync(file)
  if (data.subarray(0, 5).toString() !== "ACTB1") throw new Error("Not an Actuent backup")
  const iv = data.subarray(5, 17), tag = data.subarray(17, 33)
  const decipher = createDecipheriv("aes-256-gcm", key(), iv)
  decipher.setAuthTag(tag)
  const json = gunzipSync(Buffer.concat([decipher.update(data.subarray(33)), decipher.final()]))
  fs.writeFileSync(`${file}.json`, json)
  const d = JSON.parse(json.toString())
  console.log(`Backup from ${d.made_at}: ${Object.entries(d.tables).map(([t, rows]: any) => `${t} ${rows.length}`).join(", ")} → ${file}.json`)
}

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
if (process.argv[2] === "restore") restore(process.argv[3])
else backup().catch(e => { console.error(e); process.exit(1) })
