export default {
  "./{apps,packages}/**/src/**/*.{js,ts}": (api) =>
    `pnpm dlx @biomejs/biome check --write ${api.filenames.join(" ")}`,
};
