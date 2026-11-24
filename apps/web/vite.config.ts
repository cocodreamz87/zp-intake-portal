import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In local dev, /api calls go to `wrangler dev` on port 8787.
// In production the form and API share one Worker, so no API address is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
