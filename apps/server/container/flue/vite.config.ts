import { flue } from "@flue/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [flue()],
  server: {
    port: 4096,
    host: "0.0.0.0",
  },
})
