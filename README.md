<div align="center">

# AI 沉浸式网页翻译

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/Arimayuki03/auto-translate/releases)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/concepts/mv3-overview)
[![Chrome](https://img.shields.io/badge/Chrome-109%2B-green?logo=googlechrome&logoColor=white)](https://www.google.com/chrome/)
[![Edge](https://img.shields.io/badge/Edge-109%2B-green?logo=microsoftedge&logoColor=white)](https://www.microsoft.com/edge)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Tests](https://img.shields.io/badge/tests-516%20passed-brightgreen)](.github/workflows/build.yml)
[![License](https://img.shields.io/badge/license-MIT-yellow)](#许可)

**仿沉浸式翻译（Immersive Translate）的浏览器扩展，使用自建 AI API 实现网页双语对照翻译。**

支持 OpenAI 兼容 / Claude / Gemini / Ollama，也内置 Google / Microsoft 免费翻译通道——无需申请任何 Key，开箱即用。

[功能特性](#-功能特性) · [安装](#-安装) · [快速上手](#-快速上手) · [构建](#-构建) · [文档](#-项目文档)

</div>

---

## ✨ 功能特性

### 核心翻译

- **网页全文翻译**：段落级双语对照 / 仅译文 / 原文三种显示模式，`Alt+M` 一键轮换
- **视口懒翻译**：只翻译当前浏览内容，滚动到附近才译新内容，节省 API 额度
- **划词翻译**：选中文本弹出译文气泡，支持流式输出（SSE）与一键朗读（Edge TTS 免费）
- **输入框翻译**：输入框右上角一键将已输入内容翻译回填
- **悬停翻译**：鼠标悬停块级元素出现「译」角标，局部段落按需翻译
- **插件总开关**：点击工具栏图标一键开 / 关全部翻译功能，所有标签页即时生效、无需刷新

### API 与工程化

- **多格式 AI API**：OpenAI 兼容 / Claude / Gemini / Ollama 原生协议，自定义 BaseURL / Key / 模型
- **免费通道**：Google / Microsoft 免费翻译通道无需 Key，可作主力或互为备份自动切换
- **备用 API**：主 API 失败自动切换备用配置，免费通道也可作兜底
- **译文缓存**：跨会话复用（FNV-1a 校验防碰撞错译），并发限流、失败重试、请求去重
- **站点黑白名单**：内置排除区 + 用户自定义规则，只翻译想翻译的站点
- **SPA 支持**：监听 History API，单页应用路由切换后自动重译

## 📦 安装

### 方式一：下载 Release（推荐普通用户）

1. 从 [Releases](https://github.com/Arimayuki03/auto-translate/releases/latest) 下载最新的 `auto-translate-v1.0.0.zip`
2. 解压到任意目录
3. 按 [方式二](#方式二手动加载开发者模式) 的步骤加载解压后的目录

> Chrome / Edge 不允许直接安装未上架商店的 crx，因此 zip 解压后以开发者模式加载。

### 方式二：手动加载（开发者模式）

1. 下载并解压 Release zip，或本地构建得到 `dist/` 目录
2. 打开 Chrome / Edge（109 或更高版本），地址栏输入 `chrome://extensions/`
3. 右上角开启 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择解压后的目录（或项目的 `dist/` 目录）

## 🚀 快速上手

### 1. 配置翻译 API（首次使用必做）

**开箱即用（免费通道，无需 Key）**：点击插件图标 → 设置 → 「API 格式」选 **Google 免费** 或 **Microsoft 免费**，保存即可。

**使用自建 AI API（翻译质量更佳）**：

| 参数 | 示例 |
| --- | --- |
| API 格式 | OpenAI 兼容 |
| BaseURL | `https://api.deepseek.com/v1` |
| API Key | 你的密钥 |
| 模型 | `deepseek-chat` |

点击 **测试连接**，看到「连接成功」即配置完成。

### 2. 开始翻译

- 打开任意外语网页，点击页面右侧的 **红色小圆圈** → 面板中点「翻译」
- 或在设置里开启「自动翻译」，打开页面自动翻译当前屏

### 3. 常用快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Alt+T` | 翻译 / 还原当前页面 |
| `Alt+M` | 轮换显示模式（双语 / 仅译文 / 原文） |

完整功能说明见 [docs/使用说明.md](docs/使用说明.md)。

## 🛠️ 构建

```bash
git clone https://github.com/Arimayuki03/auto-translate.git
cd auto-translate
npm install        # 安装依赖
npm run dev        # 开发构建并监听（产物在 dist/）
npm run zip        # 打包发布 zip（产物在 release/，自动排除 sourcemap）
```

其他脚本：

```bash
npm run build      # 生产构建
npm run typecheck  # 双 tsconfig 类型检查
npm run lint       # ESLint
npm test           # Vitest 单元测试 + Playwright e2e 冒烟
```

## 📁 项目结构

```
├── manifest.json          # MV3 清单
├── src/
│   ├── background/        # 后台服务（API 适配器 / 限流 / 缓存 / offscreen TTS）
│   ├── content/           # 页面脚本（提取 / 渲染 / 工具条 / 气泡 / 输入框 / 站点规则）
│   ├── options/           # 设置页
│   ├── popup/             # 弹窗（总开关 / 快捷入口）
│   └── shared/            # 公共类型与工具
├── tests/                 # Vitest 单测 + Playwright e2e（49 文件 516 用例）
├── scripts/               # 打包脚本
└── docs/                  # 项目文档
```

## 📚 项目文档

| 文档 | 说明 |
| --- | --- |
| [docs/需求分析.md](docs/需求分析.md) | 功能需求与优先级 |
| [docs/设计文档.md](docs/设计文档.md) | 系统架构与技术设计 |
| [docs/API对接说明.md](docs/API对接说明.md) | 自建 AI API 对接指南 |
| [docs/测试计划.md](docs/测试计划.md) | 测试用例与验收标准 |
| [docs/使用说明.md](docs/使用说明.md) | 用户使用手册 |
| [docs/未来方向.md](docs/未来方向.md) | 对照 read-frog 的路线图与待验证清单 |

## 🗺️ Roadmap

- [x] 网页全文翻译（双语对照 / 仅译文）与视口懒翻译
- [x] 划词翻译（流式输出）+ Edge TTS 朗读
- [x] 输入框翻译与悬停翻译
- [x] 多格式 AI API（OpenAI 兼容 / Claude / Gemini / Ollama）+ 备用 API
- [x] 免费 Google / Microsoft 翻译通道
- [x] 站点黑白名单与 SPA 路由支持
- [ ] Firefox 上架与跨浏览器适配
- [ ] 译文缓存导出 / 导入
- [ ] 自定义 prompt 模板（部分已支持，待开放 UI）

## 🤝 贡献

欢迎 Issue 与 PR。提交前请确保：

```bash
npm run typecheck && npm run lint && npm test
```

## ⭐ 致谢

- [沉浸式翻译](https://immersivetranslate.com/) —— 产品形态参考
- [Read Frog 陪读蛙](https://github.com/mengxi-ream/read-frog) —— 路线图对照
- [Edge TTS](https://github.com/andresayac/edge-tts) —— 免费语音合成

## 📄 许可

[MIT](LICENSE) © 2026 Arimayuki03

本项目仅用于个人学习与自用，API Key 由用户自行保管。
