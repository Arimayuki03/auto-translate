/** 打包脚本：读取 dist/manifest.json 版本号，把 dist/ 内容打成 release/*.zip（zip 根即扩展根） */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";

const distManifest = resolve("dist/manifest.json");
if (!existsSync(distManifest)) {
  console.error("缺少 dist/manifest.json，请先运行 npm run build");
  process.exit(1);
}

const version = JSON.parse(readFileSync(distManifest, "utf-8")).version;
mkdirSync("release", { recursive: true });
const outAbs = resolve(`release/auto-translate-v${version}.zip`);

if (platform() === "win32") {
  // Windows：PowerShell 内置 Compress-Archive，dist/* 使 zip 根即扩展根
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path 'dist/*' -DestinationPath '${outAbs}' -Force"`
  );
} else {
  // macOS / Linux：zip 命令
  execSync(`cd dist && zip -qr "${outAbs}" .`);
}

console.log(`打包完成: ${outAbs}`);
