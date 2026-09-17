# API 对接说明

> 说明插件如何对接你的自建 AI API。插件通过**适配器层**支持多种 API 格式，在设置页选择即可，翻译协议（批量拼接、提示词）各格式通用。

## 1. 支持的 API 格式

| format 标识 | 适配服务 | 端点 | 鉴权方式 |
| --- | --- | --- | --- |
| `openai`（默认） | OpenAI 官方 / DeepSeek / Kimi / OneAPI / new-api / vLLM / 各类中转 | `POST {baseURL}/chat/completions` | `Authorization: Bearer {key}` |
| `anthropic` | Anthropic Claude / 兼容系 | `POST {baseURL}/v1/messages` | `x-api-key: {key}` + `anthropic-version: 2023-06-01` |
| `gemini` | Google Gemini | `POST {baseURL}/v1beta/models/{model}:generateContent` | `x-goog-api-key: {key}` 请求头（**不进 URL**，避免被中转/代理的访问日志记录） |
| `ollama` | Ollama 原生 | `POST {baseURL}/api/chat` | 无（本地默认） |
| `googlefree` | Google 免费翻译通道 | `GET translate.googleapis.com/translate_a/single`（可自定义主/备端点） | 无（免 Key，有频率限制） |
| `microsoft` | Microsoft / Edge 免费翻译通道 | `POST edge.microsoft.com/translate/translatetext` | 无（免 Key，有频率限制） |

> 提示：Ollama 也可开启 OpenAI 兼容模式（`/v1`），两种方式都支持；OneAPI / new-api / 中转一般建议直接用 `openai` 格式。没有 Key 时选 `googlefree` 或 `microsoft` 开箱即用——两个免费通道互为备份，其中一个被限流（429/不可达）时会自动切到另一个再试一次。

## 2. 通用配置项

| 配置 | 必填 | 说明 |
| --- | --- | --- |
| API 格式 | 是 | 上述六种之一，默认 `openai` |
| BaseURL | 看格式 | LLM 格式必填，**不要**带完整请求路径，如 `https://xxx.com/v1`；`googlefree` 留空 |
| API Key | 看格式 | OpenAI/Claude/Gemini 必填；Ollama / googlefree / microsoft 可留空 |
| 模型 | 看格式 | LLM 格式必填，如 `gpt-4o-mini`、`claude-sonnet-4-20250514`、`gemini-2.0-flash`、`qwen2.5`；`googlefree` 留空 |
| 温度 | 否 | 默认 0.3，翻译建议保持低温度 |
| 超时 | 否 | 默认 60 秒 |
| 最大并发 | 否 | 默认 2 |
| 请求间隔（毫秒） | 否 | 相邻请求的最小启动间隔，默认 500（≈2 请求/秒）；中转站/服务商限额严格时调大（如 1000～2000） |
| 批量协议 | 否 | 逐行（默认，兼容性最好）/ 哨兵 `===IT_SEP===`；`googlefree` 固定哨兵，无需配置 |
| 免费端点 | 否 | 仅 `googlefree` 显示，自定义主/备端点；留空用内置公开端点 |

## 3. 各格式请求示例

### 3.1 OpenAI 兼容（openai）

```http
POST {baseURL}/chat/completions
Authorization: Bearer {apiKey}
Content-Type: application/json
```

```json
{
  "model": "{model}",
  "messages": [
    { "role": "system", "content": "你是专业翻译引擎。将用户输入翻译为目标语言，只输出译文，不要解释、不要添加任何额外内容。" },
    { "role": "user", "content": "请逐行翻译以下内容，每行一个译文，保持顺序，不要编号，不要任何额外文字：\nHello world\nThis is a test." }
  ],
  "temperature": 0.3,
  "stream": false
}
```

响应取 `choices[0].message.content`。

### 3.2 Anthropic Claude（anthropic）

```http
POST {baseURL}/v1/messages
x-api-key: {apiKey}
anthropic-version: 2023-06-01
Content-Type: application/json
```

```json
{
  "model": "{model}",
  "max_tokens": 8192,
  "system": "你是专业翻译引擎。将用户输入翻译为目标语言，只输出译文，不要解释、不要添加任何额外内容。",
  "messages": [
    { "role": "user", "content": "请逐行翻译以下内容，每行一个译文，保持顺序，不要编号，不要任何额外文字：\nHello world\nThis is a test." }
  ],
  "temperature": 0.3
}
```

响应取 `content[0].text`。`max_tokens` 随批量输入长度动态调整（4096～8192）；模型输出上限恰为 4096（如 claude-3-haiku）被 400 拒绝时自动降回 4096 重试。

### 3.3 Google Gemini（gemini）

```http
POST {baseURL}/v1beta/models/{model}:generateContent?key={apiKey}
Content-Type: application/json
```

```json
{
  "system_instruction": {
    "parts": [{ "text": "你是专业翻译引擎。将用户输入翻译为目标语言，只输出译文，不要解释、不要添加任何额外内容。" }]
  },
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "请逐行翻译以下内容，每行一个译文，保持顺序，不要编号，不要任何额外文字：\nHello world\nThis is a test." }]
    }
  ],
  "generationConfig": { "temperature": 0.3 }
}
```

响应取 `candidates[0].content.parts[0].text`。

### 3.4 Ollama 原生（ollama）

```http
POST {baseURL}/api/chat
Content-Type: application/json
```

```json
{
  "model": "{model}",
  "stream": false,
  "messages": [
    { "role": "system", "content": "你是专业翻译引擎。将用户输入翻译为目标语言，只输出译文，不要解释、不要添加任何额外内容。" },
    { "role": "user", "content": "请逐行翻译以下内容，每行一个译文，保持顺序，不要编号，不要任何额外文字：\nHello world\nThis is a test." }
  ],
  "options": { "temperature": 0.3 }
}
```

响应取 `message.content`。

## 4. 批量翻译协议（各格式通用）

- 插件将多个段落合并为一次请求（默认每批 ≤30 段 / ≤60 个句子分块），重复携带的「系统提示词 + 页面上下文」开销随批量增大而摊薄
- **逐行协议（默认）**：原文段落**每行一条**（文本已规范为单行），提示词要求「每行一个译文，保持顺序」；响应按换行拆分（模型加编号时自动剥离「数字. 」前缀）
- **哨兵协议（可选，`batchMode: "separator"`）**：段落间用单独一行 `===IT_SEP===` 分隔，模型按哨兵逐段输出；段落含换行时更可靠。原文本身含该哨兵字符串时自动强制逐行
- **三级降级**：整批解析失败 → 拆 ≤8 段小批量重试（仅「响应正常但解析失败」触发，API 报错不放大）→ 仍失败的组才逐段请求（并发受限 + 请求启动限速），不会形成请求风暴
- 整页翻译会在 system 提示词附带页面标题/描述/正文摘要（仅用于理解语境，可在设置关闭）

## 5. 错误处理与重试策略

| 场景 | 表现 | 处理 |
| --- | --- | --- |
| 401 / 403 | Key 无效或权限不足 | 不重试，提示用户检查配置 |
| 404 | BaseURL 或路径错误 | 不重试，提示检查 BaseURL 与格式选择 |
| 400 模型不存在 | 模型名错误 | 不重试，提示检查模型名称 |
| 429 | 触发限流 | 指数退避重试（尊重 Retry-After 头）；同时全队列冷却，冷却结束先放 1 个探针请求 |
| 5xx | 服务端错误 | 指数退避重试，最多 3 次 |
| 超时 | 无响应 | 中断并指数退避重试，最多 3 次 |

## 6. 常见问题

- **选错格式报 404**：先确认你的服务是哪种格式；中转/网关类优先试 `openai`
- **Claude 报 400**：检查是否缺少 `anthropic-version` 头（插件已自动带），以及模型名是否正确
- **Gemini 报 400**：确认 BaseURL 填到 `/v1beta` 层级，模型名不带 `models/` 前缀
- **Ollama 报 404**：确认 `{baseURL}/api/chat` 可访问；或改用 Ollama 的 OpenAI 兼容端点 `/v1`
- **BaseURL 填错**：只需填到域名/版本层级，插件会自动拼接具体路径
- **上下文长度超限**：插件会自动缩小单次翻译的文本长度
