import path from "node:path"
import { cloudflare } from "@cloudflare/vite-plugin"
import { flue, flueWorkerConfig } from "@flue/vite"
import { sentryVitePlugin } from "@sentry/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { type AliasOptions, defineConfig, perEnvironmentPlugin } from "vite"
import { sentrySourceMapPluginOptions, sentrySourceMapTargetForEnvironment } from "./sentry-vite"

const alias: AliasOptions = {
  "@": path.resolve(__dirname, "./src"),
}

export default defineConfig(({ mode }) => {
  const sourceMapOptionsFor = (environmentName: string) => {
    const target = sentrySourceMapTargetForEnvironment(environmentName)
    return target ? sentrySourceMapPluginOptions(target, process.env) : undefined
  }
  const sourceMapPlugin = perEnvironmentPlugin("jared-sentry-source-maps", (environment) => {
    const options = sourceMapOptionsFor(environment.name)
    return options ? sentryVitePlugin(options) : false
  })

  if (mode === "client")
    return {
      plugins: [react(), tailwindcss(), cloudflare(), sourceMapPlugin],
      build: { sourcemap: sourceMapOptionsFor("client") ? "hidden" : false },
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
      client: {
        build: { sourcemap: sourceMapOptionsFor("client") ? "hidden" : false },
      },
      jared: {
        build: { sourcemap: sourceMapOptionsFor("jared") ? "hidden" : false },
      },
    },
    plugins: [
      // flue() MUST precede cloudflare(), and cloudflare MUST receive
      // flueWorkerConfig() so Flue can inject virtual:flue/worker + DO bindings.
      flue(),
      cloudflare({ config: flueWorkerConfig() }),
      tailwindcss(),
      sourceMapPlugin,
    ],
    resolve: {
      alias,
    },
  }
})
