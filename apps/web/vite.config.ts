import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  publicDir: resolve(
    import.meta.dirname,
    "../../node_modules/@excalidraw/excalidraw/dist/prod",
  ),
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
