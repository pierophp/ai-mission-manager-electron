import path from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: path.resolve(process.cwd(), "src/preload.ts"),
      formats: ["cjs"],
    },
    rollupOptions: {
      external: ["electron"],
      output: {
        entryFileNames: "preload.cjs",
        codeSplitting: false,
      },
    },
  },
});
