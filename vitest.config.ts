import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // SPA 导航测试（jsdom 环境）需要匹配 GitHub 同源 URL，pushState 才能用
    environmentOptions: { jsdom: { url: "https://github.com/settings/profile" } },
    include: ["tests/**/*.test.ts"],
  },
});
