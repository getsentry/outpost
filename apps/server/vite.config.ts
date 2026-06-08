import { AliasOptions, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

const alias: AliasOptions = {
  "@": path.resolve(__dirname, "./src"),
};

export default defineConfig(({ mode }) => {
  if (mode === "client")
    return {
      plugins: [react(), tailwindcss(), cloudflare()],
      resolve: {
        alias,
      },
    };

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
      // buildServer({
      //   entry: "/src/index.ts",
      // }),
      cloudflare(),
      tailwindcss(),
    ],
    resolve: {
      alias,
    },
  };
});
