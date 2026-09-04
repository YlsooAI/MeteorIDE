import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";

export const FREE_TIER_TOKEN_LIMIT = 1_000_000; // 1 Million tokens
export const FREE_TIER_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours in ms

export interface QuotaState {
  windowStart: number;
  tokensUsed: number;
  lastUpdated: number;
}

export interface QuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  windowStart: number;
  resetAt: number;
  resetsInMs: number;
  timeRemainingFormatted: string;
  percentUsed: number;
  isExceeded: boolean;
  isFreeTier: boolean;
}

function quotaFile(): string {
  return join(configDir(), "quota.json");
}

export function loadQuotaState(): QuotaState {
  const now = Date.now();
  const fallback: QuotaState = {
    windowStart: now,
    tokensUsed: 0,
    lastUpdated: now,
  };

  try {
    const file = quotaFile();
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8")) as Partial<QuotaState>;
      if (
        typeof data.windowStart === "number" &&
        typeof data.tokensUsed === "number" &&
        !isNaN(data.windowStart) &&
        !isNaN(data.tokensUsed)
      ) {
        // Check if current 5-hour window has expired
        if (now - data.windowStart >= FREE_TIER_WINDOW_MS) {
          // Window expired: start new 5h cycle
          const fresh: QuotaState = {
            windowStart: now,
            tokensUsed: 0,
            lastUpdated: now,
          };
          saveQuotaState(fresh);
          return fresh;
        }
        return {
          windowStart: data.windowStart,
          tokensUsed: Math.max(0, data.tokensUsed),
          lastUpdated: typeof data.lastUpdated === "number" ? data.lastUpdated : now,
        };
      }
    }
  } catch {}

  saveQuotaState(fallback);
  return fallback;
}

export function saveQuotaState(state: QuotaState): void {
  try {
    const dir = configDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(quotaFile(), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    console.warn("Failed to persist quota state:", err);
  }
}

export function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function getQuotaStatus(isFreeTier = true): QuotaStatus {
  const state = loadQuotaState();
  const now = Date.now();
  const elapsed = Math.max(0, now - state.windowStart);
  const resetsInMs = Math.max(0, FREE_TIER_WINDOW_MS - elapsed);
  const resetAt = state.windowStart + FREE_TIER_WINDOW_MS;
  const used = state.tokensUsed;
  const remaining = Math.max(0, FREE_TIER_TOKEN_LIMIT - used);
  const percentUsed = Math.min(100, Math.round((used / FREE_TIER_TOKEN_LIMIT) * 1000) / 10);
  const isExceeded = isFreeTier && used >= FREE_TIER_TOKEN_LIMIT;

  return {
    limit: FREE_TIER_TOKEN_LIMIT,
    used,
    remaining,
    windowStart: state.windowStart,
    resetAt,
    resetsInMs,
    timeRemainingFormatted: formatTimeRemaining(resetsInMs),
    percentUsed,
    isExceeded,
    isFreeTier,
  };
}

export class QuotaExceededError extends Error {
  constructor(
    public readonly status: QuotaStatus,
    message?: string,
  ) {
    const resetTime = new Date(status.resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const timeLeft = formatTimeRemaining(status.resetsInMs);
    super(
      message ||
        `Free tier quota exceeded: 1,000,000 tokens limit reached for this 5-hour period. Quota resets in ${timeLeft} (at ${resetTime}). Set your own API key with 'meteor auth set <key>' or wait for reset.`,
    );
    this.name = "QuotaExceededError";
  }
}

export function checkQuotaOrThrow(isFreeTier: boolean): void {
  if (!isFreeTier) return;
  const status = getQuotaStatus(true);
  if (status.isExceeded) {
    throw new QuotaExceededError(status);
  }
}

export function recordTokenUsage(tokens: number, isFreeTier: boolean): QuotaStatus {
  if (tokens <= 0) return getQuotaStatus(isFreeTier);

  const state = loadQuotaState();
  state.tokensUsed += tokens;
  state.lastUpdated = Date.now();
  saveQuotaState(state);

  return getQuotaStatus(isFreeTier);
}

export function resetQuota(): void {
  const now = Date.now();
  saveQuotaState({
    windowStart: now,
    tokensUsed: 0,
    lastUpdated: now,
  });
}
