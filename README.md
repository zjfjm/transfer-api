# Transfer Gemini API Worker

中文 | [English](#english)

这是一个 Cloudflare Worker 中转适配器，把 **Google Gemini API** 封装成 OpenAI 兼容的 `/v1/*` 接口和 Anthropic / Claude Code 兼容的 `/v1/messages` 接口。

适用场景：你的网络无法直接访问 Google，但可以访问 Cloudflare Worker。Worker 在 CF 边缘节点运行，能直连 `generativelanguage.googleapis.com`，你只需要能访问你的 Worker 地址即可。

上游使用 Gemini 的 OpenAI 兼容端点（`/v1beta/openai/chat/completions`），所以 OpenAI 请求几乎原样转发；Anthropic 请求会被转换成 OpenAI 格式再转回（支持 tool 调用）。

## 功能概览

- OpenAI 兼容：`POST /v1/chat/completions`、`POST /v1/responses`、`GET /v1/models`、`POST /v1/embeddings`。
- Anthropic 兼容：`POST /v1/messages`、`GET /v1/models`、`/anthropic/*` 别名。
- 原生 Gemini 代理：`/api/*` 直接转发到 `generativelanguage.googleapis.com/v1beta/*`。
- 客户端密钥保护：可选的 `WORKER_API_KEY`。
- 配置入口说明：`/v1/setup`、`/v1/codex`、`/v1/mcp`。

## 1. 部署到 Cloudflare

推送到 GitHub 后让 Cloudflare 自动部署，或在本地用 wrangler 部署：

```powershell
npm install
npx wrangler login
npx wrangler deploy
```

然后在 Cloudflare 后台填 key（仓库是公开的，不要写进代码）：

```text
Workers & Pages -> 你的 Worker -> Settings -> Variables and Secrets -> Add
  GEMINI_API_KEY   # 必填，https://aistudio.google.com/apikey 申请
  WORKER_API_KEY   # 可选：客户端调用你的 Worker 时要用的密钥
```

也可以在本地用 `npx wrangler secret put GEMINI_API_KEY` 设置。两种方式都是明文/加密变量，代码里统一用 `env.GEMINI_API_KEY` 读取。

也可以在 Cloudflare Dashboard 的 `Workers & Pages -> 你的 Worker -> Settings -> Variables -> Secrets` 里添加这两个值。

> 两个 key 都只能放在 Secret 里，不要写进 `wrangler.toml`、`README.md` 或任何 GitHub 文件。

## 2. 部署后验证

```bash
curl https://<your-worker>.workers.dev/health
curl https://<your-worker>.workers.dev/v1/models \
  -H "Authorization: Bearer <你的 WORKER_API_KEY>"
```

`/health` 返回 `"ok": true` 即正常。模型列表从 Gemini 实时拉取，失败时返回内置的 fallback 列表（gemini-2.5-pro / flash / flash-lite / 2.0-flash）。

## 3. OpenAI 兼容客户端

Base URL：

```text
https://<your-worker>.workers.dev/v1
```

```bash
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <你的 WORKER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

- 请求体原样转发到 Gemini 的 OpenAI 兼容端点，tool calling、streaming、usage 等按上游返回。
- `model` 只接受 Gemini 模型名（如 `gemini-2.5-pro`、`gemini-2.5-flash`），传 `gpt-*`、`claude-*` 等会自动回退到默认模型。
- `/v1/embeddings` 默认使用 `text-embedding-004`。

## 4. Anthropic / Claude Code 客户端

Base URL：

```text
https://<your-worker>.workers.dev
```

```powershell
$env:ANTHROPIC_BASE_URL = "https://<your-worker>.workers.dev"
$env:ANTHROPIC_AUTH_TOKEN = "<你的 WORKER_API_KEY>"
$env:ANTHROPIC_API_KEY = "<你的 WORKER_API_KEY>"
$env:ANTHROPIC_MODEL = "gemini-2.5-pro"
claude
```

Anthropic 格式（`system`、`messages`、`tools`、`tool_choice`、`max_tokens`、`stop_sequences` 等）会被转换成 OpenAI chat 格式发给 Gemini，响应再转回 Anthropic 格式（含流式 tool_use 块）。

## 密钥规则

```text
设置了 WORKER_API_KEY:
  客户端必须传 WORKER_API_KEY
  Worker 用 GEMINI_API_KEY 请求 Gemini

没有设置 WORKER_API_KEY:
  客户端传任意 key 都可以
  优先用 GEMINI_API_KEY；若也没设置，则把客户端传入的 key 当作 Gemini key
```

建议两个都设置，不要直接暴露 Gemini key。

---

## English

A Cloudflare Worker that relays **Google Gemini API** through OpenAI-compatible `/v1/*` routes and Anthropic / Claude Code-compatible `/v1/messages` routes. Useful when your network cannot reach Google directly but can reach your Cloudflare Worker.

The upstream is Gemini's OpenAI-compatible endpoint, so OpenAI requests are forwarded almost verbatim, and Anthropic requests are translated to and from the OpenAI chat format (including tool calls).

### Features

- OpenAI-compatible: `POST /v1/chat/completions`, `POST /v1/responses`, `GET /v1/models`, `POST /v1/embeddings`.
- Anthropic-compatible: `POST /v1/messages`, `GET /v1/models`, `/anthropic/*` aliases.
- Native Gemini passthrough: `/api/*` forwards to `generativelanguage.googleapis.com/v1beta/*`.
- Optional client-facing key protection via `WORKER_API_KEY`.

### Deploy

```powershell
npm install
npx wrangler login
npx wrangler deploy
```

Then add the keys in the Cloudflare dashboard (this repository is public, so do not put them in the code):

```text
Workers & Pages -> your Worker -> Settings -> Variables and Secrets -> Add
  GEMINI_API_KEY   # required, from https://aistudio.google.com/apikey
  WORKER_API_KEY   # optional client-facing key
```

### Usage

OpenAI-compatible base URL: `https://<your-worker>.workers.dev/v1`
Anthropic-compatible base URL: `https://<your-worker>.workers.dev`

Only Gemini model ids are accepted (`gemini-2.5-pro`, `gemini-2.5-flash`, ...). Other names fall back to the configured default model.

### Key rules

- `WORKER_API_KEY` set: clients must send it; the Worker uses `GEMINI_API_KEY` upstream.
- `WORKER_API_KEY` not set: any client key is accepted; `GEMINI_API_KEY` is preferred, otherwise the client key is used as the Gemini key.
