import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 相对路径：同一份产物既能放在主机的 /next/ 下，也能打进桌面版
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    // npm run dev 时把接口转给本机的 xpanel（桌面版主机模式或 xp serve）
    proxy: { "/api": "http://127.0.0.1:8765" },
  },
});
