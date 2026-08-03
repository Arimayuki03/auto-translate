# API 对接说明

> 说明插件如何对接你的自建 AI API。插件通过**适配器层**支持多种 API 格式，在设置页选择即可，翻译协议（批量拼接、提示词）各格式通用。

## 1. 支持的 API 格式

| format 标识 | 适配服务 | 端点 | 鉴权方式 |
| --- | --- | --- | --- |
| `openai`（默认） | OpenAI 官方 / DeepSeek / Kimi / OneAPI / new-api / vLLM / 各类中转 | `POST {baseURL}/chat/completions` | `Authorization: Bearer {key}` |
| `anthropic` | Anthropic Claude / 兼容系 | `POST {baseURL}/v1/messages` | `x-api-key: {key}` + `anthropic-version: 2023-06-01` |
| `gemini` | Google Gemini | `POST {baseURL}/v1beta/models/{model}:generateContent` | `x-goog-api-key: {key}`（或 `?key=`） |
| `ollama` | Ollama 原生 | `POST {baseURL}/api/chat` | 无（本地默认） |

> 提示：Ollama 也可开启 OpenAI 兼容模式（`/v1`），两种方式都支持；OneAPI / new-api / 中转一般建议直接用 `openai` 格式。

## 2. 通用配置项

| 配置 | 必填 | 说明 |
| --- | --- | --- |
| API 格式 | 是 | 上述四种之一，默认 `openai` |
| BaseURL | 是 | 服务地址，**不要**带完整请求路径，如 `https://xxx.com/v1` |
| API Key | 看格式 | OpenAI/Claude/Gemini 必填；Ollama 本地可留空 |
| 模型 | 是 | 服务支持的模型名，如 `gpt-4o-mini`、`claude-sonnet-4-20250514`、`gemini-2.0-flash`、`qwen2.5` |
| 温度 | 否 | 默认 0.3，翻译建议保持低温度 |
| 超时 | 否 | 默认 60 秒 |
| 最大并发 | 否 | 默认 3 |

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
    { "role": "user", "content": "请逐段翻译以下内容，段与段之间用 \"【段】\" 分隔，保持段落顺序：\n\n【段】Hello world\n【段】This is a test." }
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
  "max_tokens": 4096,
  "system": "你是专业翻译引擎。将用户输入翻译为目标语言，只输出译文，不要解释、不要添加任何额外内容。",
  "messages": [
    { "role": "user", "content": "请逐段翻译以下内容，段与段之间用 \"【段】\" 分隔，保持段落顺序：\n\n【段】Hello world\n【段】This is a test." }
  ],
  "temperature": 0.3
}
```

响应取 `content[0].text`。

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
      "parts": [{ "text": "请逐段翻译以下内容，段与段之间用 \"【段】\" 分隔，保持段落顺序：\n\n【段】Hello world\n【段】This is a test." }]
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
    { "role": "user", "content": "请逐段翻译以下内容，段与段之间用 \"【段】\" 分隔，保持段落顺序：\n\n【段】Hello world\n【段】This is a test." }
  ],
  "options": { "temperature": 0.3 }
}
```

响应取 `message.content`。

## 4. 批量翻译协议（各格式通用）

- 插件会将多个段落合并为一次请求，原文段落用分隔符 `【段】` 连接
- 响应按相同分隔符拆分，与请求段落一一对应
- 若单个请求超长（超过模型上下文），自动降级为逐段请求

## 5. 错误处理与重试策略

| 场景 | 表现 | 处理 |
| --- | --- | --- |
| 401 / 403 | Key 无效或权限不足 | 不重试，提示用户检查配置 |
| 404 | BaseURL 或路径错误 | 不重试，提示检查 BaseURL 与格式选择 |
| 400 模型不存在 | 模型名错误 | 不重试，提示检查模型名称 |
| 429 | 触发限流 | 指数退避重试，最多 3 次 |
| 5xx | 服务端错误 | 指数退避重试，最多 3 次 |
| 超时 | 无响应 | 中断并重试 1 次 |

## 6. 常见问题

- **选错格式报 404**：先确认你的服务是哪种格式；中转/网关类优先试 `openai`
- **Claude 报 400**：检查是否缺少 `anthropic-version` 头（插件已自动带），以及模型名是否正确
- **Gemini 报 400**：确认 BaseURL 填到 `/v1beta` 层级，模型名不带 `models/` 前缀
- **Ollama 报 404**：确认 `{baseURL}/api/chat` 可访问；或改用 Ollama 的 OpenAI 兼容端点 `/v1`
- **BaseURL 填错**：只需填到域名/版本层级，插件会自动拼接具体路径
- **上下文长度超限**：插件会自动缩小单次翻译的文本长度
