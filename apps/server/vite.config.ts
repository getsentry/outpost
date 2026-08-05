import path from "node:path"
import { cloudflare } from "@cloudflare/vite-plugin"
import { flue, flueWorkerConfig } from "@flue/vite"
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
      // flue() MUST precede cloudflare(), and cloudflare MUST receive
      // flueWorkerConfig() so Flue can inject virtual:flue/worker + DO bindings.
      flue(),
      cloudflare({ config: flueWorkerConfig() }),
      tailwindcss(),
    ],
    resolve: {
      alias,
    },
  }
})
