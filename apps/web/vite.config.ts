import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In local dev, /api calls go to `wrangler dev` on port 8787.
// In production, set VITE_API_BASE to your Worker's URL (see README).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
