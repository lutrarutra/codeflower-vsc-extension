import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Stable file names let the extension reference the bundle from its
// Content-Security-Policy-protected webview HTML.
export default defineConfig({
  // Relative URLs: the webview serves dist/ from its own vscode-resource origin.
  base: './',
  plugins: [tailwindcss(), svelte()],
  // A linked codeflower-ui checkout has its own svelte; the chat must use this one.
  resolve: { dedupe: ['svelte'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: '[name].js',
        // Fonts and icons keep their own names next to main.css.
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.css')) ? 'main[extname]' : 'assets/[name]-[hash][extname]'
      }
    }
  }
});
