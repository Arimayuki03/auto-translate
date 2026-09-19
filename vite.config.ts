import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

export default defineConfig({
  plugins: [
    crx({
      manifest,
      // B4：把内容脚本入口打成自包含 IIFE。默认路径下 @crxjs 会为普通 module 型
      // 内容脚本生成 loader，经 chrome.runtime.getURL() 动态 import 内容 chunk，
      // 从而把这些 chunk（含 storage-* 的 Key 混淆实现）硬编码进
      // web_accessible_resources（matches http/https 全开、use_dynamic_url: false），
      // 任意网页都能 fetch 客户端逻辑做指纹化。standaloneFiles 让整个模块图内联进
      // 单文件 IIFE，内容脚本不再需要 loader 导入，WAR 段随之整段消失。
      contentScripts: {
        standaloneFiles: ["src/content/index.ts"],
      },
    }),
  ],
  build: {
    outDir: "dist",
    // 彻底不出 sourcemap。此前是 true：@crxjs 会把产物里的每个 .map 自动写进
    // web_accessible_resources（matches http(s)://*/*），于是任意被访问的网页都能
    // fetch 到完整可读的 TS 源码。"hidden" 也不够——文件仍在 dist 里、仍被列进 WAR，
    // 用「加载已解压扩展」装 dist/ 时泄露面不变。
    // 需要临时调试时按次覆盖：`npx vite build --sourcemap`（用完别拿那个 dist 打包发布）。
    sourcemap: false,
    // E-003：content 脚本运行在隔离世界，Vite 注入的 <link rel="modulepreload">
    // 与 preload polyfill 跨世界不匹配，只会刷警告、白白浪费预加载。
    // 关闭 modulePreload（共享 chunk 的静态导入不受影响）。
    modulePreload: false,
  },
});