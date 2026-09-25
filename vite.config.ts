import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from /<repo-name>/.
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/dannegracht-waterstroom/' : '/',
  test: { environment: 'node' },
});
