# AI 沉浸式网页翻译插件

> 仿照沉浸式翻译（Immersive Translate）的浏览器扩展，使用**自建 AI API**（OpenAI 兼容 / Claude / Gemini / Ollama）实现网页双语对照翻译。

## 功能特性

- 网页全文翻译：段落级双语对照 / 仅译文 / 原文三种模式
- 视口懒翻译：只翻译当前浏览内容，滚动到附近才译新内容，节省额度
- 划词翻译：选中文本弹出译文气泡，可一键朗读译文（Edge TTS 免费）
- 输入框翻译：在输入框中快捷翻译已输入内容
- 一键复制译文：工具条「复制译文」导出整页译文
- 多格式 AI API：OpenAI 兼容 / Claude / Gemini / Ollama 原生，自定义 BaseURL / Key / 模型
- 译文缓存（跨会话复用）、并发限流、失败重试，节省 API 调用
- 站点黑白名单：只翻译想翻译的站点，避免浪费 API 额度

## 技术栈

- Edge / Chrome 扩展（Manifest V3）
- TypeScript + Vite（@crxjs/vite-plugin）

## 快速开始（开发调试）

```bash
npm install          # 安装依赖
npm run dev          # 构建并监听（产物在 dist/）
```

然后打开浏览器：

1. 访问 `chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择项目下的 `dist/` 目录

## 项目文档

| 文档 | 说明 |
| --- | --- |
| [docs/需求分析.md](docs/需求分析.md) | 功能需求与优先级 |
| [docs/设计文档.md](docs/设计文档.md) | 系统架构与技术设计 |
| [docs/API对接说明.md](docs/API对接说明.md) | 自建 AI API 对接指南 |
| [docs/开发计划.md](docs/开发计划.md) | 分阶段开发任务清单 |
| [docs/测试计划.md](docs/测试计划.md) | 测试用例与验收标准 |
| [docs/使用说明.md](docs/使用说明.md) | 用户使用手册 |

## 项目结构

```
├── manifest.json          # MV3 清单
├── src/
│   ├── background/        # 后台服务（API 请求 / 限流 / 缓存）
│   ├── content/           # 页面脚本（提取 / 渲染 / 工具条 / 气泡 / 输入框）
│   ├── options/           # 设置页
│   ├── popup/             # 弹窗
│   └── shared/            # 公共类型与工具
└── docs/                  # 项目文档
```

## 许可

本项目仅用于个人学习与自用，API Key 由用户自行保管。
