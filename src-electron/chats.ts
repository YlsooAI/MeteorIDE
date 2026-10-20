import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configDir } from "../src/config.js";

/**
 * Chats are stored locally, several per project (folder):
 *   meteor_chats/<projectId>.json               → index: ChatMeta[]
 *   meteor_messages/<projectId>/<chatId>.json   → messages
 * Older builds kept one chat per project in meteor_messages/<projectId>.json;
 * that file is migrated into a chat the first time the project is listed.
 */

export interface ChatMeta {
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

type Msg = { role: string; content: unknown };

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function check(id: string, what: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Invalid ${what}`);
  return id;
}
function indexFile(projectId: string): string {
  return join(configDir(), "meteor_chats", `${check(projectId, "project id")}.json`);
}
function chatDir(projectId: string): string {
  return join(configDir(), "meteor_messages", check(projectId, "project id"));
}
function chatFile(projectId: string, chatId: string): string {
  return join(chatDir(projectId), `${check(chatId, "chat id")}.json`);
}
function legacyFile(projectId: string): string {
  return join(configDir(), "meteor_messages", `${check(projectId, "project id")}.json`);
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

function readIndex(projectId: string): ChatMeta[] {
  try {
    const f = indexFile(projectId);
    if (existsSync(f)) {
      const list = JSON.parse(readFileSync(f, "utf8"));
      if (Array.isArray(list)) return list as ChatMeta[];
    }
  } catch {}
  return [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: string }).text ?? "") : "")).join(" ");
  return "";
}

function previewOf(messages: Msg[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return textOf(lastUser?.content).replace(/\s+/g, " ").trim().slice(0, 120);
}

function migrateLegacy(projectId: string, legacyTitle: string): void {
  const legacy = legacyFile(projectId);
  if (!existsSync(legacy)) return;
  try {
    const messages = JSON.parse(readFileSync(legacy, "utf8")) as Msg[];
    if (Array.isArray(messages) && messages.length) {
      const id = randomUUID();
      const now = Date.now();
      writeJson(chatFile(projectId, id), messages);
      const firstUser = textOf(messages.find((m) => m.role === "user")?.content);
      const meta: ChatMeta = {
        id,
        title: legacyTitle || firstUser.slice(0, 60) || "Chat",
        preview: previewOf(messages),
        createdAt: now,
        updatedAt: now,
        messageCount: messages.length,
      };
      writeJson(indexFile(projectId), [meta, ...readIndex(projectId)]);
    }
    rmSync(legacy, { force: true });
  } catch {
    // leave the legacy file in place if anything goes wrong
  }
}

export function listChats(projectId: string, legacyTitle = ""): ChatMeta[] {
  migrateLegacy(projectId, legacyTitle);
  return readIndex(projectId).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadChat(projectId: string, chatId: string): Msg[] {
  try {
    const f = chatFile(projectId, chatId);
    if (existsSync(f)) {
      const msgs = JSON.parse(readFileSync(f, "utf8"));
      if (Array.isArray(msgs)) return msgs as Msg[];
    }
  } catch {}
  return [];
}

/** Save messages for a chat. Creates the chat when chatId is missing or unknown. */
export function saveChat(projectId: string, chatId: string | null, messages: Msg[]): ChatMeta {
  const index = readIndex(projectId);
  const now = Date.now();
  let meta = chatId ? index.find((c) => c.id === chatId) : undefined;
  if (!meta) {
    const firstUser = textOf(messages.find((m) => m.role === "user")?.content).replace(/\s+/g, " ").trim();
    meta = { id: chatId && SAFE_ID.test(chatId) ? chatId : randomUUID(), title: firstUser.slice(0, 60) || "New chat", preview: "", createdAt: now, updatedAt: now, messageCount: 0 };
    index.unshift(meta);
  }
  meta.preview = previewOf(messages);
  meta.updatedAt = now;
  meta.messageCount = messages.length;
  writeJson(chatFile(projectId, meta.id), messages);
  writeJson(indexFile(projectId), index);
  return meta;
}

export function renameChat(projectId: string, chatId: string, title: string): ChatMeta | null {
  const index = readIndex(projectId);
  const meta = index.find((c) => c.id === chatId);
  if (!meta) return null;
  meta.title = title.slice(0, 80);
  writeJson(indexFile(projectId), index);
  return meta;
}

export function deleteChat(projectId: string, chatId: string): void {
  writeJson(indexFile(projectId), readIndex(projectId).filter((c) => c.id !== chatId));
  rmSync(chatFile(projectId, chatId), { force: true });
}

export function deleteProjectChats(projectId: string): void {
  rmSync(indexFile(projectId), { force: true });
  rmSync(chatDir(projectId), { recursive: true, force: true });
  rmSync(legacyFile(projectId), { force: true });
}
