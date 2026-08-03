import path from "node:path"
import { cloudflare } from "@cloudflare/vite-plugin"
import { flue } from "@flue/vite"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { type AliasOptions, defineConfig } from "vite"

const alias: AliasOptions = {
  "@": path.resolve(__dirname, "./src"),
}

export default defineConfig(({ mode }) => {
  if (mode === "client")
    return {
      plugins: [react(), tailwindcss(), cloudflare()],
      resolve: {
        alias,
      },
    }

  return {
    ssr: {
      external: ["react", "react-dom"],
    },
    environments: {
      ssr: {
        keepProcessEnv: true,
      },
    },
    plugins: [
      // flue() must come before cloudflare(): it prepares the generated Worker
      // entry and merges Flue DO bindings into the wrangler input config.
      flue(),
      cloudflare(),
      tailwindcss(),
    ],
    resolve: {
      alias,
    },
  }
})
