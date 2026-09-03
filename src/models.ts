export type Protocol = "chat" | "responses";

export interface MeteorModel {
  key: string;
  name: string;
  zenId: string;
  apiModel: string;
  protocol: Protocol;
  description: string;
}

export const MODELS: Record<string, MeteorModel> = {
  "sunlight-2": {
    key: "sunlight-2",
    name: "Sunlight 2",
    zenId: "opencode/muse-spark-1.2-contributor-free",
    apiModel: "muse-spark-1.2-contributor-free",
    protocol: "responses",
    description: "Sunlight 2",
  },
  "sunlight-2-pro": {
    key: "sunlight-2-pro",
    name: "Sunlight 2 Pro",
    zenId: "opencode/muse-spark-1.3-contributor-free",
    apiModel: "muse-spark-1.3-contributor-free",
    protocol: "chat",
    description: "Sunlight 2 Pro",
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
