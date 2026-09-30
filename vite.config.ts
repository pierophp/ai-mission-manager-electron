import { defineConfig } from "vite-plus";
import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(process.cwd(), "src/renderer") },
  },
  test: {
    include: ["**/*.{test,spec}.{js,ts,jsx,tsx}", "../shared/**/*.{test,spec}.{js,ts,jsx,tsx}"],
    environment: "happy-dom",
  },
  server: {
    strictPort: true,
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: false,
  },
});
