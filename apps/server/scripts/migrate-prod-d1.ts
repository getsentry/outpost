import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"

const serverRoot = fileURLToPath(new URL("..", import.meta.url))

// Keep the D1 credential local to migration tooling. Wrangler only recognizes
// CLOUDFLARE_API_TOKEN, so map the dedicated token in the child process rather
// than exposing it to the Worker runtime or shell history.
config({ path: `${serverRoot}.env` })

const d1Token = process.env.CLOUDFLARE_D1_API_TOKEN
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID

if (!d1Token) {
  throw new Error("CLOUDFLARE_D1_API_TOKEN must be set to run production D1 migrations")
}

if (!accountId) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID must be set to run production D1 migrations")
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const child = spawn(pnpm, ["exec", "wrangler", "d1", "migrations", "apply", "jared", "--remote"], {
  cwd: serverRoot,
  env: {
    ...process.env,
    CLOUDFLARE_API_TOKEN: d1Token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
  },
  stdio: "inherit",
})

child.once("error", (error) => {
  console.error(`Unable to start Wrangler: ${error.message}`)
  process.exitCode = 1
})

child.once("exit", (code) => {
  process.exitCode = code ?? 1
})
