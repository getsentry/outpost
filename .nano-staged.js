export default {
  "./{apps,packages}/**/src/**/*.{js,ts,jsx,tsx}": (api) =>
    `pnpm dlx @biomejs/biome check --write ${api.filenames.join(" ")}`,
};
