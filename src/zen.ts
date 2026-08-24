import type { Protocol } from "./models.js";

export const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string };

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MessageContentPart[];
  // optional tool fields kept compatible
  tool_call_id?: string;
  tool_calls?: unknown;
  name?: string;
}

export type ReasoningEffort = "auto" | "low" | "high" | "max" | "" | string;

export interface ToolDefinition {
  server: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolCall {
  id: string;
  name: string; // combined server__tool
  server: string;
  toolName: string;
  arguments: string; // JSON string
  parsedArgs?: unknown;
}

export interface CompletionResult {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
}

export interface CompletionOptions {
  apiKey: string;
  apiModel: string;
  protocol: Protocol;
  messages: (Message & { tool_call_id?: string; name?: string; tool_calls?: unknown })[];
  stream?: boolean;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  onToolCallDelta?: (delta: { index: number; id?: string; name?: string; arguments?: string }) => void;
  reasoningEffort?: ReasoningEffort;
  tools?: ToolDefinition[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const ZenError = ApiError;

async function readError(res: Response): Promise<never> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = json.error?.message ?? json.message ?? text;
    } catch {
      detail = text;
    }
  } catch {}
  throw new ApiError(
    `API error ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${detail ? `: ${detail}` : ""}`,
    res.status,
  );
}

async function* sseDataEvents(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new ApiError("Empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, sep).replace(/\r$/, "");
      buffer = buffer.slice(sep + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  for (const line of buffer.split("\n")) {
    if (line.startsWith("data:")) yield line.slice(5).trim();
  }
}

function extractResponsesText(payload: unknown): string {
  const obj = payload as {
    output_text?: unknown;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };
  if (typeof obj.output_text === "string") return obj.output_text;
  const parts: string[] = [];
  for (const item of obj.output ?? []) {
    if (item.type && item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if ((c.type === "output_text" || typeof c.text === "string") && c.text) parts.push(c.text);
    }
  }
  return parts.join("");
}

function mcpToolsToChatTools(tools?: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: `${t.server}__${t.name}`,
      description: t.description || `MCP tool ${t.name} from ${t.server}`,
      parameters: t.inputSchema || { type: "object", properties: {}, additionalProperties: true },
    },
  }));
}

function parseChatToolCalls(acc: Map<number, { id: string; name: string; arguments: string }>, deltaToolCalls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string }; type?: string }>) {
  if (!deltaToolCalls) return;
  for (const tc of deltaToolCalls) {
    const idx = tc.index ?? 0;
    const prev = acc.get(idx) || { id: "", name: "", arguments: "" };
    if (tc.id) prev.id = tc.id;
    if (tc.function?.name) prev.name = tc.function.name;
    if (tc.function?.arguments) prev.arguments += tc.function.arguments;
    acc.set(idx, prev);
  }
}

async function completeChat(opts: CompletionOptions): Promise<CompletionResult> {
  const allowedEffort = opts.reasoningEffort && ["low", "high", "max"].includes(opts.reasoningEffort) ? opts.reasoningEffort : undefined;
  const reasoningPayload = allowedEffort
      ? { reasoning_effort: allowedEffort, reasoning: { effort: allowedEffort } }
      : {};
  const chatTools = mcpToolsToChatTools(opts.tools);
  // Normalize messages for tool results
  const messages = opts.messages.map((m) => {
    if ((m as { tool_call_id?: string }).tool_call_id) {
      return { role: "tool" as const, tool_call_id: (m as { tool_call_id: string }).tool_call_id, content: m.content };
    }
    if ((m as { tool_calls?: unknown }).tool_calls) {
      return { role: "assistant" as const, content: m.content || null, tool_calls: (m as { tool_calls: unknown }).tool_calls };
    }
    return m;
  });
  const res = await fetch(`${ZEN_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.apiModel,
      messages,
      stream: opts.stream !== false,
      ...(chatTools ? { tools: chatTools, tool_choice: "auto" } : {}),
      ...reasoningPayload,
    }),
    signal: opts.signal,
  });
  if (!res.ok) await readError(res);

  if (opts.stream === false) {
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string }; type: string }> } }>;
    };
    const msg = json.choices?.[0]?.message as { content?: string | null; reasoning?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string }; type: string }> } | undefined;
    const text = msg?.content ?? "";
    const reasoning = (msg?.reasoning ?? msg?.reasoning_content ?? "") as string;
    if (reasoning) opts.onReasoningDelta?.(reasoning);
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => {
      const [server, ...rest] = tc.function.name.split("__");
      const toolName = rest.join("__") || tc.function.name;
      return {
        id: tc.id,
        name: tc.function.name,
        server: server || "unknown",
        toolName,
        arguments: tc.function.arguments,
        parsedArgs: (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })(),
      };
    });
    if (text) opts.onDelta?.(text);
    return { text, reasoning, toolCalls };
  }

  let out = "";
  let reasoningOut = "";
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const data of sseDataEvents(res)) {
    if (data === "[DONE]") break;
    let chunk: {
      choices?: Array<{
        delta?: {
          content?: string | null;
          reasoning?: string | null;
          reasoning_content?: string | null;
          reasoning_details?: string | null;
          tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string }; type?: string }>;
        } & Record<string, unknown>;
        message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null };
        finish_reason?: string | null;
      }>;
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = (choice.delta?.content ?? choice.message?.content ?? "") as string;
    if (delta) {
      out += delta;
      opts.onDelta?.(delta);
    }
    // reasoning delta: handle various field names
    const reasoningDelta =
      (choice.delta as { reasoning?: string; reasoning_content?: string; reasoning_details?: string })?.reasoning ??
      (choice.delta as { reasoning_content?: string })?.reasoning_content ??
      (choice.delta as { reasoning_details?: string })?.reasoning_details ??
      (choice.message as { reasoning?: string; reasoning_content?: string })?.reasoning ??
      (choice.message as { reasoning_content?: string })?.reasoning_content ??
      "";
    if (reasoningDelta) {
      reasoningOut += reasoningDelta;
      opts.onReasoningDelta?.(reasoningDelta);
    }
    // also catch generic reasoning field via iteration
    if (!reasoningDelta) {
      for (const [k, v] of Object.entries(choice.delta as Record<string, unknown> ?? {})) {
        if (typeof v === "string" && /reason/i.test(k) && v) {
          reasoningOut += v;
          opts.onReasoningDelta?.(v);
        }
      }
    }
    if (choice.delta?.tool_calls) {
      parseChatToolCalls(toolAcc, choice.delta.tool_calls);
      for (const tc of choice.delta.tool_calls) {
        opts.onToolCallDelta?.({ index: tc.index ?? 0, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments });
      }
    }
  }
   const toolCalls: ToolCall[] = [];
  for (const [, v] of toolAcc) {
    if (!v.name) continue;
    const [server, ...rest] = v.name.split("__");
    const toolName = rest.join("__") || v.name;
    toolCalls.push({
      id: v.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: v.name,
      server: server || "unknown",
      toolName,
      arguments: v.arguments,
      parsedArgs: (() => { try { return JSON.parse(v.arguments || "{}"); } catch { return v.arguments; } })(),
    });
  }
  return { text: out, reasoning: reasoningOut || undefined, toolCalls };
}

function mcpToolsToResponsesTools(tools?: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    name: `${t.server}__${t.name}`,
    description: t.description || `MCP tool ${t.name} from ${t.server}`,
    parameters: t.inputSchema || { type: "object", properties: {}, additionalProperties: true },
  }));
}

async function completeResponses(opts: CompletionOptions): Promise<CompletionResult> {
  const systemMessages = opts.messages.filter((m) => m.role === "system");
  const conversation = opts.messages.filter((m) => m.role !== "system");
  const allowedEffort = opts.reasoningEffort && ["low", "high", "max"].includes(opts.reasoningEffort) ? opts.reasoningEffort : undefined;
  const reasoningPayload = allowedEffort
      ? { reasoning: { effort: allowedEffort }, reasoning_effort: allowedEffort }
      : {};
  const responsesTools = mcpToolsToResponsesTools(opts.tools);
  const input = conversation.map((m) => {
    const anyM = m as { tool_call_id?: string; tool_calls?: unknown; name?: string };
    if (anyM.tool_call_id) {
      const txt = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return {
        role: "tool" as const,
        content: [{ type: "input_text" as const, text: txt }],
        tool_call_id: anyM.tool_call_id,
      };
    }
    if (anyM.tool_calls) {
      const txt = typeof m.content === "string" ? m.content : "";
      return {
        role: "assistant" as const,
        content: txt ? [{ type: "output_text" as const, text: txt }] : [],
        tool_calls: anyM.tool_calls,
      };
    }
    // handle array content (multimodal)
    if (Array.isArray(m.content)) {
      const blocks = (m.content as MessageContentPart[]).map((p) => {
        if ((p as { type: string }).type === "image_url" || (p as { type: string }).type === "input_image") {
          const url = (p as { image_url: { url: string } | string }).image_url;
          const u = typeof url === "string" ? url : (url as { url: string }).url;
          return { type: "input_image" as const, image_url: u };
        }
        const txt = (p as { text?: string }).text ?? (p as { type: string }).type === "text" ? (p as { text: string }).text : "";
        return { type: m.role === "assistant" ? "output_text" as const : "input_text" as const, text: txt ?? "" };
      });
      return { role: m.role as "user" | "assistant", content: blocks };
    }
    return {
      role: m.role as "user" | "assistant",
      content: [{ type: m.role === "assistant" ? "output_text" as const : "input_text" as const, text: m.content as string }],
    };
  });
  const res = await fetch(`${ZEN_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.apiModel,
      instructions: systemMessages.map((m) => m.content).join("\n\n") || undefined,
      input,
      stream: opts.stream !== false,
      ...(responsesTools ? { tools: responsesTools } : {}),
      ...reasoningPayload,
    }),
    signal: opts.signal,
  });
  if (!res.ok) await readError(res);

  if (opts.stream === false) {
    const json = await res.json();
    const text = extractResponsesText(json);
    let reasoning: string | undefined;
    try {
      const objR = json as { output?: Array<{ type?: string; summary?: Array<{ text?: string }> | string; content?: Array<{ type?: string; text?: string }> }> };
      for (const item of objR.output ?? []) {
        if (item.type && /reasoning/i.test(item.type)) {
          if (typeof item.summary === "string") reasoning = (reasoning ?? "") + item.summary;
          else if (Array.isArray(item.summary)) reasoning = (reasoning ?? "") + item.summary.map(s=>s.text ?? "").join("");
          else if (Array.isArray(item.content)) reasoning = (reasoning ?? "") + item.content.map(c=>c.text ?? "").join("");
          else if ((item as { reasoning?: string }).reasoning) reasoning = (reasoning ?? "") + (item as { reasoning: string }).reasoning;
        }
      }
      if (reasoning) opts.onReasoningDelta?.(reasoning);
    } catch {}
    // Try to extract tool calls from non-stream response
    const toolCalls: ToolCall[] = [];
    const obj = json as { output?: Array<{ type?: string; name?: string; arguments?: string; call_id?: string; id?: string }> };
    for (const item of obj.output ?? []) {
      if (item.type === "function_call" && item.name) {
        const [server, ...rest] = item.name.split("__");
        toolCalls.push({
          id: item.call_id || item.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: item.name,
          server: server || "unknown",
          toolName: rest.join("__") || item.name,
          arguments: item.arguments || "{}",
          parsedArgs: (() => { try { return JSON.parse(item.arguments || "{}"); } catch { return item.arguments; } })(),
        });
      }
    }
    if (text) opts.onDelta?.(text);
    return { text, reasoning, toolCalls };
  }

  let out = "";
  let reasoningOut = "";
  const toolAcc = new Map<string, { name: string; arguments: string; id: string }>();
  // For responses, tool calls may come as events
  for await (const data of sseDataEvents(res)) {
    if (!data || data === "[DONE]") continue;
    let event: { type?: string; delta?: unknown; text?: string; summary?: string; reasoning?: string; name?: string; arguments?: string; call_id?: string; output_index?: number; item?: unknown; content?: unknown };
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      out += event.delta;
      opts.onDelta?.(event.delta);
    } else if ((event.type && /reasoning/i.test(event.type)) && typeof event.delta === "string") {
      reasoningOut += event.delta;
      opts.onReasoningDelta?.(event.delta);
    } else if ((event.type && /reasoning/i.test(event.type)) && typeof event.text === "string") {
      reasoningOut += event.text;
      opts.onReasoningDelta?.(event.text);
    } else if ((event.type && /reasoning/i.test(event.type)) && typeof event.summary === "string") {
      reasoningOut += event.summary;
      opts.onReasoningDelta?.(event.summary);
    } else if ((event.type && /reasoning/i.test(event.type)) && typeof event.reasoning === "string") {
      reasoningOut += event.reasoning;
      opts.onReasoningDelta?.(event.reasoning);
    } else if (event.type && event.type.includes("reasoning") && event.delta && typeof (event.delta as { text?: string }).text === "string") {
      const t = (event.delta as { text: string }).text;
      reasoningOut += t;
      opts.onReasoningDelta?.(t);
    } else if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const id = event.call_id || String(event.output_index ?? 0);
      const prev = toolAcc.get(id) || { name: event.name || "", arguments: "", id };
      prev.arguments += event.delta as string;
      if (event.name) prev.name = event.name;
      toolAcc.set(id, prev);
      opts.onToolCallDelta?.({ index: Number(id) || 0, id, name: event.name, arguments: event.delta as string });
    } else if (event.type === "response.output_item.added" && event.item) {
      const item = event.item as { type?: string; name?: string; call_id?: string; id?: string };
      if (item.type === "function_call" && item.name) {
        const id = item.call_id || item.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        toolAcc.set(id, { name: item.name, arguments: "", id });
      } else if (item.type && /reasoning/i.test(item.type)) {
        // reasoning item added
      }
    } else if (event.type === "response.function_call_arguments.done" && event.call_id) {
      // done, keep as is
    } else if (
      event.type === "response.failed" ||
      event.type === "response.incomplete" ||
      event.type === "error"
    ) {
      throw new ApiError(`Stream error: ${data}`);
    } else if (event.type && /reasoning/i.test(event.type)) {
      // fallback generic reasoning handling
      const maybe = (event as { delta?: string; text?: string }).delta ?? (event as { text?: string }).text;
      if (typeof maybe === "string" && maybe) {
        reasoningOut += maybe;
        opts.onReasoningDelta?.(maybe);
      }
    }
  }
  const toolCalls: ToolCall[] = [];
  for (const [, v] of toolAcc) {
    if (!v.name) continue;
    const [server, ...rest] = v.name.split("__");
    toolCalls.push({
      id: v.id,
      name: v.name,
      server: server || "unknown",
      toolName: rest.join("__") || v.name,
      arguments: v.arguments,
      parsedArgs: (() => { try { return JSON.parse(v.arguments || "{}"); } catch { return v.arguments; } })(),
    });
  }
  return { text: out, reasoning: reasoningOut || undefined, toolCalls };
}

export function complete(opts: CompletionOptions): Promise<CompletionResult> {
  return opts.protocol === "chat" ? completeChat(opts) : completeResponses(opts);
}

// Backwards compat: some callers expect string, provide helper
export async function completeText(opts: CompletionOptions): Promise<string> {
  const r = await complete(opts);
  return r.text;
}
