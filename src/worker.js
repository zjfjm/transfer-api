// Cloudflare Worker that relays Google Gemini API through OpenAI- and
// Anthropic-compatible endpoints. Gemini exposes an OpenAI-compatible layer at
// https://generativelanguage.googleapis.com/v1beta/openai, so OpenAI requests can
// be forwarded almost verbatim, while Anthropic requests are translated to the
// OpenAI chat-completions format and the responses are translated back.

const DEFAULT_UPSTREAM_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_NATIVE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-pro";
const DEFAULT_CLAUDE_MODEL = "gemini-2.5-pro";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-004";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type,x-api-key,anthropic-api-key,anthropic-version,anthropic-beta,openai-beta",
  "Access-Control-Expose-Headers": "content-type,request-id,x-request-id",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    try {
      const authError = validateWorkerApiKey(request, env);
      if (authError) return authError;

      if (path === "/" || path === "/health") {
        return jsonResponse(serviceInfo(request, env));
      }

      // Raw passthrough to the native Gemini API (v1beta), e.g. /api/models.
      if (path.startsWith("/api/")) {
        return await proxyNative(request, env, path);
      }

      if (path === "/mcp" || path === "/v1/mcp" || path === "/anthropic/mcp" || path === "/anthropic/v1/mcp") {
        return jsonResponse(mcpInfo(request));
      }

      if (path === "/codex" || path === "/v1/codex" || path === "/anthropic/codex" || path === "/anthropic/v1/codex") {
        return textResponse(codexSetup(request), "text/plain; charset=utf-8");
      }

      if (path === "/v1/setup" || path === "/anthropic/setup" || path === "/anthropic/v1/setup") {
        return textResponse(agentSetup(request), "text/plain; charset=utf-8");
      }

      if (path === "/v1/messages" || (path === "/v1/models" && looksLikeAnthropicRequest(request)) || path.startsWith("/anthropic/")) {
        return await handleAnthropic(request, env, path);
      }

      if (path.startsWith("/v1/")) {
        return await handleOpenAI(request, env, path);
      }

      return errorResponse(404, "not_found", `No route for ${path}`);
    } catch (error) {
      return errorResponse(500, "internal_error", error && error.message ? error.message : String(error));
    }
  },
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handleOpenAI(request, env, path) {
  if (path === "/v1/models" && request.method === "GET") {
    if (looksLikeAnthropicRequest(request)) return anthropicModels(request, env);
    return openAIModels(request, env);
  }

  if (path === "/v1/chat/completions" && request.method === "POST") {
    const body = await readJson(request);
    return proxyChatCompletions(request, env, body);
  }

  if (path === "/v1/responses" && request.method === "POST") {
    const body = await readJson(request);
    return handleResponses(request, env, body);
  }

  if (path === "/v1/embeddings" && request.method === "POST") {
    const body = await readJson(request);
    return proxyEmbeddings(request, env, body);
  }

  if (path === "/v1/files" && request.method === "GET") {
    return jsonResponse({ object: "list", data: [], has_more: false });
  }

  if (path.startsWith("/v1/files")) {
    return errorResponse(404, "not_found", "This Worker is a stateless proxy. File persistence is not available.");
  }

  if (path === "/v1/key" || path === "/v1/auth-key" || path === "/v1/usage") {
    return errorResponse(501, "unsupported_endpoint", "Key and usage inspection are not available for the Gemini upstream. Use the Google AI Studio dashboard instead.");
  }

  return errorResponse(404, "not_found", `Unsupported OpenAI-compatible route ${path}`);
}

async function handleAnthropic(request, env, path) {
  const anthPath = path.startsWith("/anthropic/") ? normalizePath(path.slice("/anthropic".length) || "/") : path;

  if ((anthPath === "/v1/models" || anthPath === "/models") && request.method === "GET") {
    return anthropicModels(request, env);
  }

  if ((anthPath === "/v1/messages" || anthPath === "/messages") && request.method === "POST") {
    const body = await readJson(request);
    return handleAnthropicMessages(request, env, body);
  }

  if (anthPath === "/v1/setup" || anthPath === "/setup") {
    return textResponse(agentSetup(request), "text/plain; charset=utf-8");
  }

  return errorResponse(404, "not_found", `Unsupported Anthropic-compatible route ${path}`);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible handling (direct pass-through to Gemini's OpenAI layer)
// ---------------------------------------------------------------------------

async function proxyChatCompletions(request, env, body) {
  const payload = { ...body, model: resolveModel(body.model, env) };
  const response = await fetchUpstream(request, env, "/chat/completions", payload);
  if (!response.ok) return upstreamErrorResponse(response);
  return passthroughResponse(response);
}

async function proxyEmbeddings(request, env, body) {
  const payload = { ...body, model: body.model || env.DEFAULT_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL };
  const response = await fetchUpstream(request, env, "/embeddings", payload);
  if (!response.ok) return upstreamErrorResponse(response);
  return passthroughResponse(response);
}

async function handleResponses(request, env, body) {
  const model = resolveModel(body.model, env);
  const chatBody = responsesToChatBody(body, model);
  const meta = { id: `resp_${randomId()}`, created: nowSeconds(), model };

  const upstream = await fetchUpstream(request, env, "/chat/completions", chatBody);
  if (!upstream.ok) return upstreamErrorResponse(upstream);

  if (body.stream) return sseResponse(streamResponsesFromChat(upstream, meta));

  const chat = await upstream.json();
  return jsonResponse(chatToResponsesObject(chat, body, meta));
}

// ---------------------------------------------------------------------------
// Anthropic-compatible handling (translate Anthropic <-> OpenAI)
// ---------------------------------------------------------------------------

async function handleAnthropicMessages(request, env, body) {
  const model = resolveModel(body.model, env, env.DEFAULT_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL);
  const chatBody = anthropicToOpenAIBody(body, model);
  const meta = { id: `msg_${randomId()}`, model };

  const upstream = await fetchUpstream(request, env, "/chat/completions", chatBody);
  if (!upstream.ok) return upstreamErrorResponse(upstream);

  if (body.stream) return sseResponse(streamAnthropicFromChat(upstream, meta));

  const chat = await upstream.json();
  return jsonResponse(chatToAnthropicMessage(chat, meta));
}

function anthropicToOpenAIBody(body, model) {
  const messages = [];

  const systemText = contentToText(body.system);
  if (systemText) messages.push({ role: "system", content: systemText });

  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const message of source) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role === "assistant" ? "assistant" : "user", content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    const parts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image" && block.source) {
        const src = block.source;
        if (src.type === "base64" && src.media_type && typeof src.data === "string") {
          parts.push({ type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } });
        } else if (src.type === "url" && src.url) {
          parts.push({ type: "image_url", image_url: { url: src.url } });
        }
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id || `call_${randomId()}`,
          type: "function",
          function: {
            name: block.name || "tool",
            arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {}),
          },
        });
      } else if (block.type === "tool_result") {
        const resultText = typeof block.content === "string" ? block.content : contentToText(block.content);
        toolResults.push({ role: "tool", tool_call_id: block.tool_use_id, content: resultText || "" });
      }
    }

    if (parts.length) {
      const content = parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
      messages.push({ role: message.role === "assistant" ? "assistant" : "user", content });
    }

    if (toolCalls.length) {
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        last.tool_calls = toolCalls;
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: toolCalls });
      }
    }

    for (const result of toolResults) messages.push(result);
  }

  const payload = { model, messages, stream: !!body.stream };

  if (typeof body.max_tokens === "number") payload.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) payload.stop = body.stop_sequences;

  const tools = anthropicToolsToOpenAI(body.tools);
  if (tools) payload.tools = tools;
  if (body.tool_choice) payload.tool_choice = anthropicToolChoiceToOpenAI(body.tool_choice);

  return payload;
}

function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const mapped = tools
    .filter((tool) => tool && tool.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    }));
  return mapped.length ? mapped : undefined;
}

function anthropicToolChoiceToOpenAI(choice) {
  if (!choice || typeof choice !== "object") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) return { type: "function", function: { name: choice.name } };
  return "auto";
}

function chatToAnthropicMessage(chat, meta) {
  const choice = (chat.choices && chat.choices[0]) || {};
  const message = choice.message || {};
  const text = typeof message.content === "string" ? message.content : contentToText(message.content);

  const content = [];
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    if (text) content.push({ type: "text", text });
    for (const call of message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse((call.function && call.function.arguments) || "{}");
      } catch (_) {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: call.id || `toolu_${randomId()}`,
        name: (call.function && call.function.name) || "tool",
        input,
      });
    }
  } else if (text) {
    content.push({ type: "text", text });
  }

  const usage = chat.usage || {};

  return {
    id: meta.id,
    type: "message",
    role: "assistant",
    model: meta.model,
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: anthropicStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

// Streams Anthropic-format SSE events by translating OpenAI-format chunks that
// come back from Gemini's OpenAI-compatible endpoint.
function streamAnthropicFromChat(upstream, meta) {
  return new ReadableStream({
    async start(controller) {
      let nextIndex = 0;
      let openTextIndex = null;
      const toolBlocks = new Map();
      let finished = false;

      const closeTextBlock = () => {
        if (openTextIndex !== null) {
          writeSseEvent(controller, "content_block_stop", { type: "content_block_stop", index: openTextIndex });
          openTextIndex = null;
        }
      };

      writeSseEvent(controller, "message_start", {
        type: "message_start",
        message: {
          id: meta.id,
          type: "message",
          role: "assistant",
          model: meta.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      try {
        await forEachSseEvent(upstream, (chunk) => {
          const choice = chunk.choices && chunk.choices[0];
          const delta = choice && choice.delta;

          if (delta && typeof delta.content === "string" && delta.content) {
            if (openTextIndex === null) {
              openTextIndex = nextIndex++;
              writeSseEvent(controller, "content_block_start", {
                type: "content_block_start",
                index: openTextIndex,
                content_block: { type: "text", text: "" },
              });
            }
            writeSseEvent(controller, "content_block_delta", {
              type: "content_block_delta",
              index: openTextIndex,
              delta: { type: "text_delta", text: delta.content },
            });
          }

          if (delta && Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              if (!call || typeof call !== "object") continue;
              let block = toolBlocks.get(call.index);
              if (!block) {
                closeTextBlock();
                const id = call.id || `toolu_${randomId()}`;
                block = { index: nextIndex++, id, name: (call.function && call.function.name) || "tool" };
                toolBlocks.set(call.index, block);
                writeSseEvent(controller, "content_block_start", {
                  type: "content_block_start",
                  index: block.index,
                  content_block: { type: "tool_use", id, name: block.name, input: {} },
                });
              }
              const args = call.function && call.function.arguments;
              if (args) {
                writeSseEvent(controller, "content_block_delta", {
                  type: "content_block_delta",
                  index: block.index,
                  delta: { type: "input_json_delta", partial_json: args },
                });
              }
            }
          }

          if (finished || !choice || !choice.finish_reason) return;
          finished = true;

          closeTextBlock();
          for (const block of toolBlocks.values()) {
            writeSseEvent(controller, "content_block_stop", { type: "content_block_stop", index: block.index });
          }

          const usage = chunk.usage || {};
          writeSseEvent(controller, "message_delta", {
            type: "message_delta",
            delta: { stop_reason: anthropicStopReason(choice.finish_reason), stop_sequence: null },
            usage: { output_tokens: usage.completion_tokens || 0 },
          });
          writeSseEvent(controller, "message_stop", { type: "message_stop" });
        });

        if (!finished) {
          finished = true;
          closeTextBlock();
          for (const block of toolBlocks.values()) {
            writeSseEvent(controller, "content_block_stop", { type: "content_block_stop", index: block.index });
          }
          writeSseEvent(controller, "message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 0 },
          });
          writeSseEvent(controller, "message_stop", { type: "message_stop" });
        }
      } catch (error) {
        writeRawSse(controller, `event: error\ndata: ${JSON.stringify({ error: { type: "api_error", message: error.message || String(error) } })}\n\n`);
      } finally {
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/responses handling (translate Responses API <-> chat completions)
// ---------------------------------------------------------------------------

function responsesToChatBody(body, model) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  const inputText = inputToText(body.input);
  if (inputText) messages.push({ role: "user", content: inputText });

  const payload = { model, messages, stream: !!body.stream };

  if (typeof body.max_output_tokens === "number") payload.max_tokens = body.max_output_tokens;
  else if (typeof body.max_tokens === "number") payload.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;

  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools.map((tool) =>
      tool && tool.type === "function"
        ? {
            type: "function",
            function: {
              name: tool.name,
              description: tool.description || "",
              parameters: tool.parameters || { type: "object", properties: {} },
            },
          }
        : tool
    );
  }

  return payload;
}

function chatToResponsesObject(chat, body, meta) {
  const message = (chat.choices && chat.choices[0] && chat.choices[0].message) || {};
  const text = typeof message.content === "string" ? message.content : contentToText(message.content);
  const usage = chat.usage || {};

  return {
    id: meta.id,
    object: "response",
    created_at: meta.created,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: body.instructions || null,
    max_output_tokens: body.max_output_tokens || body.max_tokens || null,
    model: meta.model,
    output: [
      {
        id: `msg_${randomId()}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    output_text: text,
    parallel_tool_calls: true,
    previous_response_id: body.previous_response_id || null,
    reasoning: body.reasoning || null,
    store: body.store || false,
    temperature: typeof body.temperature === "number" ? body.temperature : null,
    text: body.text || { format: { type: "text" } },
    tool_choice: body.tool_choice || "auto",
    tools: body.tools || [],
    top_p: typeof body.top_p === "number" ? body.top_p : null,
    truncation: body.truncation || "disabled",
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
    user: body.user || null,
  };
}

function streamResponsesFromChat(upstream, meta) {
  const outputId = `msg_${randomId()}`;

  return new ReadableStream({
    async start(controller) {
      writeSseEvent(controller, "response.created", {
        type: "response.created",
        response: { id: meta.id, object: "response", created_at: meta.created, status: "in_progress", model: meta.model, output: [] },
      });
      writeSseEvent(controller, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: outputId, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
      writeSseEvent(controller, "response.content_part.added", {
        type: "response.content_part.added",
        item_id: outputId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });

      try {
        await forEachSseEvent(upstream, (chunk) => {
          const choice = chunk.choices && chunk.choices[0];
          const delta = choice && choice.delta;

          if (delta && typeof delta.content === "string" && delta.content) {
            writeSseEvent(controller, "response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: outputId,
              output_index: 0,
              content_index: 0,
              delta: delta.content,
            });
          }

          if (!choice || !choice.finish_reason) return;

          writeSseEvent(controller, "response.output_text.done", {
            type: "response.output_text.done",
            item_id: outputId,
            output_index: 0,
            content_index: 0,
            text: "",
          });
          writeSseEvent(controller, "response.content_part.done", {
            type: "response.content_part.done",
            item_id: outputId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
          writeSseEvent(controller, "response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item: { id: outputId, type: "message", status: "completed", role: "assistant", content: [] },
          });
          writeSseEvent(controller, "response.completed", {
            type: "response.completed",
            response: { id: meta.id, object: "response", created_at: meta.created, status: "completed", model: meta.model },
          });
          writeRawSse(controller, "data: [DONE]\n\n");
        });
      } catch (error) {
        writeRawSse(controller, `event: error\ndata: ${JSON.stringify({ error: { type: "api_error", message: error.message || String(error) } })}\n\n`);
      } finally {
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

async function getModelCatalog(request, env) {
  try {
    const headers = {};
    const key = optionalUpstreamApiKey(request, env);
    if (key) headers["Authorization"] = `Bearer ${key}`;

    const response = await fetch(resolveUpstreamUrl(upstreamBase(env), "/models"), { headers });
    if (!response.ok) throw new Error(`models failed: ${response.status}`);

    const data = await response.json();
    const models = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
    return models
      .map((model) => ({
        id: String(model.id || model.name || model).replace(/^models\//, ""),
        name: String(model.name || model.id || model).replace(/^models\//, ""),
        provider: model.owned_by || model.provider || "google",
      }))
      .filter((model) => model.id);
  } catch (_) {
    return fallbackModelCatalog();
  }
}

async function openAIModels(request, env) {
  const catalog = await getModelCatalog(request, env);
  return jsonResponse({
    object: "list",
    data: catalog.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: model.provider || "google",
      permission: [],
      root: model.id,
      parent: null,
    })),
  });
}

async function anthropicModels(request, env) {
  const catalog = await getModelCatalog(request, env);
  const data = catalog.map((model) => toAnthropicModel(model));
  return jsonResponse({
    data: data.length ? data : [toAnthropicModel({ id: DEFAULT_CLAUDE_MODEL, name: "Gemini 2.5 Pro" })],
    has_more: false,
    first_id: data[0] ? data[0].id : DEFAULT_CLAUDE_MODEL,
    last_id: data.length ? data[data.length - 1].id : DEFAULT_CLAUDE_MODEL,
  });
}

function toAnthropicModel(model) {
  const id = String(model.id || DEFAULT_CLAUDE_MODEL);
  return {
    id,
    type: "model",
    display_name: model.name || prettifyModelName(id),
    created_at: "2026-01-01T00:00:00Z",
  };
}

function prettifyModelName(id) {
  return String(id || "").replace(/^gemini-/i, "Gemini ").replace(/-/g, " ");
}

function fallbackModelCatalog() {
  return [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", provider: "google" },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "google" },
  ];
}

// ---------------------------------------------------------------------------
// Upstream access
// ---------------------------------------------------------------------------

async function fetchUpstream(request, env, path, payload) {
  const key = upstreamApiKey(request, env);
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (payload && payload.stream) headers["Accept"] = "text/event-stream";

  return fetch(resolveUpstreamUrl(upstreamBase(env), path), {
    method: "POST",
    headers,
    body: JSON.stringify(payload || {}),
  });
}

async function proxyNative(request, env, path) {
  const nativePath = path.replace(/^\/api/, "") || "/";
  const upstreamUrl = resolveUpstreamUrl(nativeBase(env), nativePath, new URL(request.url).search);

  const headers = new Headers(request.headers);
  const key = optionalUpstreamApiKey(request, env);
  if (key) {
    headers.set("authorization", `Bearer ${key}`);
    headers.set("x-goog-api-key", key);
  }
  headers.delete("host");

  const init = {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  };

  const response = await fetch(upstreamUrl, init);
  return passthroughResponse(response);
}

async function upstreamErrorResponse(response) {
  let message = `upstream returned ${response.status}`;
  let code = "upstream_error";

  try {
    const text = await response.text();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        message = (parsed.error && (parsed.error.message || parsed.error.type)) || parsed.message || text;
        code = (parsed.error && (parsed.error.code || parsed.error.type)) || parsed.type || code;
      } catch (_) {
        message = text;
      }
    }
  } catch (_) {
    // leave defaults
  }

  return errorResponse(response.status === 0 ? 502 : response.status, code, message);
}

function upstreamApiKey(request, env) {
  const key = optionalUpstreamApiKey(request, env);
  if (key) return key;

  if (env.WORKER_API_KEY) {
    throw new Error("Missing upstream API key. Set GEMINI_API_KEY when WORKER_API_KEY is enabled.");
  }

  throw new Error("Missing upstream API key. Set GEMINI_API_KEY or pass Authorization: Bearer <key> / x-api-key: <key>.");
}

function optionalUpstreamApiKey(request, env) {
  const configured = env.GEMINI_API_KEY || env.API_KEY || env.AUTH_KEY;
  if (configured) return configured;

  // When the Worker is protected by WORKER_API_KEY but no upstream key is set,
  // return an empty string so callers fail with a clear message instead of
  // silently forwarding a client key.
  if (env.WORKER_API_KEY) return "";

  return clientApiKey(request);
}

function upstreamBase(env) {
  return stripTrailingSlash(env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL) + "/";
}

function nativeBase(env) {
  return stripTrailingSlash(env.NATIVE_BASE_URL || DEFAULT_NATIVE_BASE_URL) + "/";
}

// Resolve a (possibly absolute-looking) path against a base URL that itself has
// a non-root path, e.g. ".../v1beta/openai/" + "/chat/completions" must keep the
// "/v1beta/openai" prefix, which new URL() would otherwise discard.
function resolveUpstreamUrl(base, path, search = "") {
  return new URL(path.replace(/^\/+/, "") + search, base);
}

// ---------------------------------------------------------------------------
// Client auth
// ---------------------------------------------------------------------------

function validateWorkerApiKey(request, env) {
  const expected = env.WORKER_API_KEY;
  if (!expected) return null;

  const actual = clientApiKey(request);
  if (actual && constantTimeEqual(actual, expected)) return null;

  return jsonResponse(
    {
      error: {
        message: "Invalid or missing Worker API key.",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
  );
}

function clientApiKey(request) {
  const auth = request.headers.get("authorization") || "";
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();

  const xKey = request.headers.get("x-api-key") || request.headers.get("anthropic-api-key");
  return xKey ? xKey.trim() : "";
}

function constantTimeEqual(actual, expected) {
  const actualText = String(actual || "");
  const expectedText = String(expected || "");
  if (actualText.length !== expectedText.length) return false;

  let diff = 0;
  for (let i = 0; i < actualText.length; i += 1) {
    diff |= actualText.charCodeAt(i) ^ expectedText.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// SSE utilities
// ---------------------------------------------------------------------------

async function forEachSseEvent(response, onData) {
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  const handleLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    const parsed = parseJsonSafe(payload);
    if (parsed) onData(parsed);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) handleLine(line);
  }

  if (buffer.startsWith("data:")) handleLine(buffer);
}

function writeSse(controller, data) {
  writeRawSse(controller, `data: ${JSON.stringify(data)}\n\n`);
}

function writeSseEvent(controller, event, data) {
  writeRawSse(controller, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeRawSse(controller, chunk) {
  controller.enqueue(new TextEncoder().encode(chunk));
}

function sseResponse(body) {
  return new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function passthroughResponse(response) {
  return addCors(response);
}

// Copy an upstream response while dropping hop-by-hop and transport headers.
// The Workers runtime already decodes gzip/deflate on fetch(), so forwarding the
// original content-encoding/content-length would make the body disagree with the
// headers and break the response mid-stream.
function sanitizedHeaders(src) {
  const headers = new Headers(src);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.delete("connection");
  return headers;
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function textResponse(text, contentType, init = {}) {
  return new Response(text, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function errorResponse(status, code, message) {
  return jsonResponse(
    {
      error: {
        message,
        type: code,
        code,
      },
    },
    { status }
  );
}

function addCors(response) {
  const headers = sanitizedHeaders(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function readJson(request) {
  if (!request.body) return {};
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error("Request body must be valid JSON.");
  }
}

// ---------------------------------------------------------------------------
// Content conversion
// ---------------------------------------------------------------------------

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => contentToText(part))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.input_text === "string") return content.input_text;
    if (content.type === "image_url") return `[image: ${content.image_url && content.image_url.url ? content.image_url.url : "attached"}]`;
    if (content.type === "image") return "[image attached]";
    if (content.type === "tool_result") return `[tool_result ${content.tool_use_id || ""}] ${contentToText(content.content)}`;
    if (content.type === "tool_use") return `[tool_use ${content.name || "tool"}] ${JSON.stringify(content.input || {})}`;
    if (content.type) return `[${content.type}] ${JSON.stringify(content)}`;
  }
  return String(content);
}

function inputToText(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return contentToText(input);

  return input
    .map((item) => {
      if (typeof item === "string") return item;
      if (item.type === "message") return `${item.role || "user"}: ${contentToText(item.content)}`;
      if (item.role) return `${item.role}: ${contentToText(item.content)}`;
      if (item.type === "input_text" || item.type === "output_text") return item.text || "";
      return contentToText(item);
    })
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

function resolveModel(model, env, fallback) {
  const defaultModel = fallback || env.DEFAULT_MODEL || DEFAULT_MODEL;
  if (!model) return defaultModel;
  // Gemini's OpenAI layer reports ids like "models/gemini-2.5-pro"; accept both
  // spellings. Anything else (gpt-*, claude-*) cannot be served here.
  const normalized = String(model).replace(/^models\//, "");
  if (/^(gemini|text-embedding)/i.test(normalized)) return normalized;
  return defaultModel;
}

function anthropicStopReason(reason) {
  if (!reason || reason === "stop") return "end_turn";
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  return reason;
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function normalizePath(path) {
  if (!path || path === "") return "/";
  const normalized = path.replace(/\/+/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function looksLikeAnthropicRequest(request) {
  return request.headers.has("anthropic-version") || request.headers.has("anthropic-beta") || request.headers.has("x-api-key");
}

function parseJsonSafe(data) {
  try {
    return JSON.parse(data);
  } catch (_) {
    return null;
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Info endpoints
// ---------------------------------------------------------------------------

function serviceInfo(request, env) {
  const origin = new URL(request.url).origin;
  return {
    ok: true,
    service: "Gemini OpenAI/Anthropic compatibility Worker",
    upstream: stripTrailingSlash(env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL),
    models_hint: "Use GET /v1/models to list models supported by the configured Gemini key.",
    routes: {
      openai: `${origin}/v1/chat/completions, /v1/responses, /v1/models, /v1/embeddings`,
      anthropic: `${origin}/v1/messages or ${origin}/anthropic/v1/messages`,
      native: `${origin}/api/* (raw Gemini v1beta passthrough)`,
      setup: `${origin}/v1/setup, /v1/codex, /v1/mcp`,
    },
  };
}

function agentSetup(request) {
  const origin = new URL(request.url).origin;
  return `Claude Code / Anthropic-compatible setup (backed by Gemini)

PowerShell:
$env:ANTHROPIC_BASE_URL = "${origin}"
$env:ANTHROPIC_AUTH_TOKEN = "<your WORKER_API_KEY>"
$env:ANTHROPIC_API_KEY = "<your WORKER_API_KEY>"
$env:ANTHROPIC_MODEL = "${DEFAULT_CLAUDE_MODEL}"
claude

Bash:
export ANTHROPIC_BASE_URL="${origin}"
export ANTHROPIC_AUTH_TOKEN="<your WORKER_API_KEY>"
export ANTHROPIC_API_KEY="<your WORKER_API_KEY>"
export ANTHROPIC_MODEL="${DEFAULT_CLAUDE_MODEL}"
claude

Other agents (Goose, Hermes, ...):
Provider: Anthropic-compatible
Base URL: ${origin}
API key: <your WORKER_API_KEY>
Model: ${DEFAULT_CLAUDE_MODEL}

Messages endpoint: POST ${origin}/v1/messages
Models endpoint: GET ${origin}/v1/models

Requests are translated to the OpenAI-compatible Gemini endpoint. Tool calls are
converted between the Anthropic and OpenAI formats.
`;
}

function codexSetup(request) {
  const origin = new URL(request.url).origin;
  return `Codex / OpenAI-compatible setup (backed by Gemini)

OpenAI-compatible Chat Completions:
base_url = "${origin}/v1"
api_key = "<your WORKER_API_KEY>"
model = "${DEFAULT_MODEL}"

Responses-compatible route for newer agents:
POST ${origin}/v1/responses

Direct smoke test:
curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer <your WORKER_API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${DEFAULT_MODEL}","messages":[{"role":"user","content":"Write a small test function."}],"stream":true}'

Models endpoint: GET ${origin}/v1/models
`;
}

function mcpInfo(request) {
  const origin = new URL(request.url).origin;
  return {
    supported: true,
    model_endpoint: origin,
    note: "MCP servers execute inside the client or agent. This Worker supplies OpenAI/Anthropic-compatible model endpoints backed by Gemini and does not run local MCP tools.",
    endpoints: {
      openai_chat_completions: `${origin}/v1/chat/completions`,
      openai_responses: `${origin}/v1/responses`,
      anthropic_messages: `${origin}/v1/messages`,
      setup: `${origin}/v1/setup`,
    },
  };
}
