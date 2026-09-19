/** 打包脚本：读取 dist/manifest.json 版本号，用 fflate 把 dist/ 内容打成 release/*.zip（zip 根即扩展根）
 *  两条硬性约束：
 *   1) 排除 *.map —— sourcemap 里是完整可读的 TS 源码，随包发布等于公开实现细节，
 *      且历史产物还曾被列进 web_accessible_resources，任意网页可 fetch 下来。
 *   2) dist 必须不早于源码 —— 曾经出现过 zip 是 09-15 构建、dist 是 09-17 构建，
 *      直接上传就会把过期代码发出去。
 *  实现说明（fflate 纯 JS 压缩，不经过任何 shell 命令）：
 *   - zip 条目键一律是相对 dist 的 posix 正斜杠路径，产物内部结构不再随平台
 *     分隔符变化（旧实现 win32 走 PowerShell Compress-Archive 会产生反斜杠条目）；
 *   - 版本号先经严格格式校验（形如 x.y.z 或 x.y.z- prerelease/+build），不匹配直接
 *     拒绝打包，且只作为纯 JS 字符串参与文件名拼接——旧实现把它内插进
 *     powershell -Command 的单引号段，版本含单引号即命令注入。 */
import { zipSync } from "fflate";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
      "请先运行 npm run build 再打包，否则会发布过期代码。\n" +
      "注意：git checkout / 切分支会把源码 mtime 刷新为当前时间，之后即使 dist 内容仍然有效也会被拦下——" +
      "这是保守方向的误报，重跑一次 npm run build 即可。"
  );
  process.exit(1);
}

const version = String(JSON.parse(readFileSync(distManifest, "utf-8")).version ?? "");
// 版本号会拼进 zip 文件名（历史上还被内插进 shell 命令）：不匹配标准 semver 形态直接拒绝
if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
  console.error(
    `dist/manifest.json 的 version 字段格式非法: ${JSON.stringify(version)}，` +
      "应为 x.y.z 或 x.y.z-预发布/+构建号 形态，拒绝打包。"
  );
  process.exit(1);
}

/** sourcemap 判定：不区分大小写的 .map 后缀（涵盖独立 .map 与 .js.map/.css.map 等命名变体） */
const isSourcemap = (name) => /\.map$/i.test(name);

/** 递归收集 dir 下全部文件，返回 [相对 posix 路径, 绝对路径] 列表 */
function collectFiles(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(full, rel));
    else files.push([rel, full]);
  }
  return files;
}

const entries = {};
let excluded = 0;
for (const [rel, full] of collectFiles("dist")) {
  if (isSourcemap(rel)) {
    excluded++;
    continue;
  }
  // 键用相对 dist 的 posix 路径（collectFiles 自拼 "/"），zip 根即扩展根
  entries[rel] = readFileSync(full);
}

mkdirSync("release", { recursive: true });
const outAbs = resolve(`release/auto-translate-v${version}.zip`);
writeFileSync(outAbs, zipSync(entries, { level: 9 }));

console.log(`打包完成: ${outAbs}（${Object.keys(entries).length} 个文件，已排除 ${excluded} 个 sourcemap）`);
