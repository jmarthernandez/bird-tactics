import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset paths so the built site works from any folder:
  // Netlify Drop, GitHub Pages project sites (/repo-name/), or a user site.
  base: "./",
  test: {
    environment: "node",
  },
});
