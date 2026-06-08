import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "cloudflare:workers": path.resolve(__dirname, "./src/__mocks__/cloudflare-workers.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
})
