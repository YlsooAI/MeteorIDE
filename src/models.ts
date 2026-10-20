export type Protocol = "chat" | "responses";
export type Provider = "zen" | "mercury" | "tokenrouter" | "orcarouter" | "openrouter";

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

// All models are served through OpenRouter (OpenAI-compatible, provider/model ids).
export const OPENROUTER_URL = "https://openrouter.ai/api/v1";
// For now all three Sunlight tiers use the same free model.
const SUNLIGHT_MODEL = "minimax/minimax-m3.1-flash:free";

export const MODELS: Record<string, MeteorModel> = {
  "sunlight-2": {
    key: "sunlight-2",
    name: "Sunlight 2",
    zenId: `openrouter/${SUNLIGHT_MODEL}`,
    apiModel: SUNLIGHT_MODEL,
    protocol: "chat",
    provider: "openrouter",
    baseUrl: OPENROUTER_URL,
    description: "Sunlight 2",
  },
  "sunlight-2-pro": {
    key: "sunlight-2-pro",
    name: "Sunlight 2 Pro",
    zenId: `openrouter/${SUNLIGHT_MODEL}`,
    apiModel: SUNLIGHT_MODEL,
    protocol: "chat",
    provider: "openrouter",
    baseUrl: OPENROUTER_URL,
    description: "Sunlight 2 Pro",
  },
  "sunlight-2-lite": {
    key: "sunlight-2-lite",
    name: "Sunlight 2 Lite",
    zenId: `openrouter/${SUNLIGHT_MODEL}`,
    apiModel: SUNLIGHT_MODEL,
    protocol: "chat",
    provider: "openrouter",
    baseUrl: OPENROUTER_URL,
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
