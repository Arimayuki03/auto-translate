/** 打包脚本：读取 dist/manifest.json 版本号，把 dist/ 内容打成 release/*.zip（zip 根即扩展根）
 *  两条硬性约束：
 *   1) 排除 *.map —— sourcemap 里是完整可读的 TS 源码，随包发布等于公开实现细节，
 *      且历史产物还曾被列进 web_accessible_resources，任意网页可 fetch 下来。
 *   2) dist 必须不早于源码 —— 曾经出现过 zip 是 09-15 构建、dist 是 09-17 构建，
 *      直接上传就会把过期代码发出去。 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";

const distManifest = resolve("dist/manifest.json");
if (!existsSync(distManifest)) {
  console.error("缺少 dist/manifest.json，请先运行 npm run build");
  process.exit(1);
}

/** 目录下（递归）最新的 mtime */
function newestMtime(dir) {
  let newest = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else if (entry.name !== ".git") {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

const distMtime = statSync(distManifest).mtimeMs;
const sourceMtime = Math.max(
  newestMtime("src"),
  newestMtime("public"),
  statSync("manifest.json").mtimeMs,
  statSync("vite.config.ts").mtimeMs
);
if (sourceMtime > distMtime) {
  console.error(
    `dist/ 早于源码（源码 ${new Date(sourceMtime).toISOString()} > 构建 ${new Date(distMtime).toISOString()}）。\n` +
      "请先运行 npm run build 再打包，否则会发布过期代码。"
  );
  process.exit(1);
}

const version = JSON.parse(readFileSync(distManifest, "utf-8")).version;
mkdirSync("release", { recursive: true });
const outAbs = resolve(`release/auto-translate-v${version}.zip`);

// 先落到排除 *.map 的暂存目录，再压缩暂存目录（跨平台，避免各压缩命令的排除语法差异）
const staging = resolve(".zip-staging");
rmSync(staging, { recursive: true, force: true });
let excluded = 0;
cpSync("dist", staging, {
  recursive: true,
  filter: (src) => {
    if (src.endsWith(".map")) {
      excluded++;
      return false;
    }
    return true;
  },
});

try {
  if (platform() === "win32") {
    // Windows：PowerShell 内置 Compress-Archive，暂存目录/* 使 zip 根即扩展根
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${staging}/*' -DestinationPath '${outAbs}' -Force"`
    );
  } else {
    // macOS / Linux：zip 命令
    execSync(`cd "${staging}" && zip -qr "${outAbs}" .`);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

console.log(`打包完成: ${outAbs}（已排除 ${excluded} 个 sourcemap）`);
