import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import fs from "fs";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    tsconfigPaths(),
    {
      name: "copy-panels",
      closeBundle() {
        const apiUrl = (process.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
        const panelFiles = ["auth.html", "admin.html", "agent-dashboard.html"];
        const panelsDir = path.resolve(process.cwd(), "panels");
        const distDir = path.resolve(process.cwd(), "dist");

        for (const file of panelFiles) {
          const src = path.join(panelsDir, file);
          if (!fs.existsSync(src)) {
            console.warn(`[copy-panels] Missing: panels/${file} — skipping`);
            continue;
          }
          const content = fs.readFileSync(src, "utf8").replace(/__API_URL__/g, apiUrl);
          fs.writeFileSync(path.join(distDir, file), content);
        }

        console.log(`[copy-panels] Copied ${panelFiles.length} panels — API: ${apiUrl || "(none — users enter it at login)"}`);
      },
    },
  ],
  build: {
    outDir: "dist",
  },
});
