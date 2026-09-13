import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: "dist",
    sourcemap: true,
    // E-003：content 脚本运行在隔离世界，Vite 注入的 <link rel="modulepreload">
    // 与 preload polyfill 跨世界不匹配，只会刷警告、白白浪费预加载。
    // 关闭 modulePreload（共享 chunk 的静态导入不受影响）。
    modulePreload: false,
  },
});