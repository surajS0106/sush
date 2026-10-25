import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served by the relay (`apps/server`): the page at /join/:id, its files under /viewer/.
// In dev, Vite proxies the relay's API and WebSocket so the page is same-origin with it.
export default defineConfig({
  base: "/viewer/",
  plugins: [react()],
  server: {
    port: 1430,
    proxy: {
      "/api": { target: "http://localhost:3000", ws: true },
    },
  },
});
