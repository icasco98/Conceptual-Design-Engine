import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The Python backend (api/main.py) serves the built app from frontend/dist.
// During development this dev server proxies /api to it instead, so the
// two can be run side by side with hot reload on the frontend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8000" },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
