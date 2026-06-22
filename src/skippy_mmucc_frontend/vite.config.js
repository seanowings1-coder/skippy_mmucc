import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'url';
import environment from 'vite-plugin-environment';
import dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });

export default defineConfig({
  build: {
    emptyOutDir: true,
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: "globalThis",
      },
    },
  },
  server: {
    host: "0.0.0.0",
    // Vite blocks unrecognized Host headers by default (DNS-rebinding
    // protection). Disabled so tunneling services with dynamic hostnames
    // (localtunnel, ngrok, etc.) can reach the dev server for mobile testing.
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4943",
        changeOrigin: true,
      },
      // Same-origin route to the Skippy brain proxy (OpenRouter/ElevenLabs).
      // Routing through Vite (rather than the frontend hitting :8787 cross-origin
      // directly) avoids Mixed Content blocks when the page is loaded over HTTPS
      // (e.g. via a localtunnel/ngrok tunnel) but the proxy is plain HTTP.
      "/skippy-api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/skippy-api/, ""),
        // Pillar 12's Guardian Emergency Protocol opens a WebSocket to the
        // proxy's /emergency-ws — needs ws:true so Vite proxies the upgrade
        // request too, same same-origin reasoning as the rest of this block.
        ws: true,
      },
    },
  },
  publicDir: "assets",
  plugins: [
    environment("all", { prefix: "CANISTER_" }),
    environment("all", { prefix: "DFX_" }),
  ],
  resolve: {
    alias: [
      {
        find: "declarations",
        replacement: fileURLToPath(
          new URL("../declarations", import.meta.url)
        ),
      },
    ],
    dedupe: ['@icp-sdk/core'],
  },
});
