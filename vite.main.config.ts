import path from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: path.resolve(process.cwd(), "src/main.ts"),
      formats: ["cjs"],
    },
    rollupOptions: {
      external: ["electron", /^node:/],
      output: {
        entryFileNames: "main.cjs",
        codeSplitting: false,
      },
    },
  },
});
