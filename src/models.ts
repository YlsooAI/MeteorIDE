export type Protocol = "chat" | "responses";
export type Provider = "zen" | "mercury" | "tokenrouter" | "orcarouter" | "vercel";

export interface MeteorModel {
  key: string;
  name: string;
  zenId: string;
  apiModel: string;
  protocol: Protocol;
  provider: Provider;
  baseUrl?: string;
  description: string;
}

// All models are served through the Vercel AI Gateway (OpenAI-compatible, provider/model ids).
export const VERCEL_AI_GATEWAY_URL = "https://ai-gateway.vercel.sh/v1";

export const MODELS: Record<string, MeteorModel> = {
  "sunlight-2": {
    key: "sunlight-2",
    name: "Sunlight 2",
    zenId: "vercel/xiaomi/mimo-v2.6-flash",
    apiModel: "xiaomi/mimo-v2.6-flash",
    protocol: "chat",
    provider: "vercel",
    baseUrl: VERCEL_AI_GATEWAY_URL,
    description: "Sunlight 2",
  },
  "sunlight-2-pro": {
    key: "sunlight-2-pro",
    name: "Sunlight 2 Pro",
    zenId: "vercel/alibaba/qwen3.8-omni-flash",
    apiModel: "alibaba/qwen3.8-omni-flash",
    protocol: "chat",
    provider: "vercel",
    baseUrl: VERCEL_AI_GATEWAY_URL,
    description: "Sunlight 2 Pro",
  },
  "sunlight-2-lite": {
    key: "sunlight-2-lite",
    name: "Sunlight 2 Lite",
    zenId: "vercel/inception/mercury-2",
    apiModel: "inception/mercury-2",
    protocol: "chat",
    provider: "vercel",
    baseUrl: VERCEL_AI_GATEWAY_URL,
    description: "Sunlight 2 Lite",
  },
};

// Reasoning efforts supported by Sunlight 2 and Sunlight 2 Pro (same set).
// "" = Default (model default, nothing sent). Ordered low → high.
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffortValue = (typeof REASONING_EFFORTS)[number];
export const REASONING_EFFORT_LABELS: Record<ReasoningEffortValue, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
};

export const DEFAULT_MODEL = "sunlight-2-pro";

export function resolveModel(input: string | undefined): MeteorModel {
  if (!input) return MODELS[DEFAULT_MODEL];
  const normalized = input.toLowerCase().replace(/^meteor\//, "");
  if (MODELS[normalized]) return MODELS[normalized];
  for (const m of Object.values(MODELS)) {
    if (
      normalized === m.name.toLowerCase() ||
      normalized.replace(/\s+/g, "-") === m.name.toLowerCase().replace(/\s+/g, "-") ||
      normalized === m.zenId ||
      normalized === m.apiModel ||
      normalized.endsWith(m.apiModel)
    ) {
      return m;
    }
  }
  throw new Error(
    `Unknown model "${input}". Available: ${Object.values(MODELS).map((m) => `${m.key} (${m.name})`).join(", ")}`,
  );
}
