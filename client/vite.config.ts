import { defineConfig } from 'vite';

// For GitHub Pages the deploy build sets BASE=/<repo name>/.
export default defineConfig({
  base: process.env.BASE ?? '/',
});
