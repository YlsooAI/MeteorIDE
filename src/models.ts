export type Protocol = "chat" | "responses";
export type Provider = "zen" | "mercury" | "tokenrouter" | "orcarouter" | "openrouter" | "apinex";

export interface MeteorModel {
  key: string;
  name: string;
  zenId: string;
  apiModel: string;
  protocol: Protocol;
  provider: Provider;
  baseUrl?: string;
  description: string;
  /** Input types the model accepts besides text. Uploads of other types are blocked in the app. */
  inputs: Array<"image" | "video" | "file">;
}

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

export const MODELS: Record<string, MeteorModel> = {
  "sunlight-2.1": {
    key: "sunlight-2.1",
    name: "Sunlight 2.1",
    zenId: "apinex/free/hy4",
    apiModel: "free/hy4",
    protocol: "chat",
    provider: "apinex",
    baseUrl: "https://api.apinex.bond/v1",
    description: "Sunlight 2.1",
    inputs: [],
  },
};

// Models that were removed, mapped to their replacement so saved settings keep working.
const RETIRED_MODELS: Record<string, string> = {
  "sunlight-2": "sunlight-2.1",
  "sunlight-2-pro": "sunlight-2.1",
  "sunlight-2-lite": "sunlight-2.1",
};

// Reasoning efforts supported by Sunlight 2.1.
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

export const DEFAULT_MODEL = "sunlight-2.1";

export function resolveModel(input: string | undefined): MeteorModel {
  if (!input) return MODELS[DEFAULT_MODEL];
  const normalized = input.toLowerCase().replace(/^meteor\//, "");
  if (MODELS[normalized]) return MODELS[normalized];
  if (RETIRED_MODELS[normalized]) return MODELS[RETIRED_MODELS[normalized]];
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