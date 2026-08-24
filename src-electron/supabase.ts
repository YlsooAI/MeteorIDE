import { createClient, type SupabaseClient, type Session, type User } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig, EMBEDDED_SUPABASE_URL, EMBEDDED_SUPABASE_ANON_KEY } from "../src/config.js";
import { WebSocket as WS } from "ws";
if (!(globalThis as unknown as { WebSocket?: unknown }).WebSocket) {
  (globalThis as unknown as Record<string, unknown>).WebSocket = WS as unknown;
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "meteor") : join(homedir(), ".config", "meteor");
}
function supabaseSessionFile(): string { return join(configDir(), "supabase-session.json"); }
function mockAuthFile(): string { return join(configDir(), "mock-auth.json"); }

function getSupabaseEnv(): { url?: string; anonKey?: string } {
  const cfg = loadConfig() as { supabaseUrl?: string; supabaseAnonKey?: string };
  return {
    url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || cfg.supabaseUrl || EMBEDDED_SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || cfg.supabaseAnonKey || EMBEDDED_SUPABASE_ANON_KEY,
  };
}

export function isSupabaseConfigured(): boolean {
  const { url, anonKey } = getSupabaseEnv();
  return Boolean(url && anonKey);
}

// ── file storage for real Supabase ──
function fileStorage() {
  return {
    getItem(key: string): string | null {
      try {
        if (!existsSync(supabaseSessionFile())) return null;
        const raw = JSON.parse(readFileSync(supabaseSessionFile(), "utf8"));
        return raw[key] ?? null;
      } catch { return null; }
    },
    setItem(key: string, value: string) {
      try {
        mkdirSync(configDir(), { recursive: true });
        let raw: Record<string, string> = {};
        if (existsSync(supabaseSessionFile())) {
          try { raw = JSON.parse(readFileSync(supabaseSessionFile(), "utf8")); } catch {}
        }
        raw[key] = value;
        writeFileSync(supabaseSessionFile(), JSON.stringify(raw, null, 2), { mode: 0o600 });
      } catch {}
    },
    removeItem(key: string) {
      try {
        if (!existsSync(supabaseSessionFile())) return;
        const raw = JSON.parse(readFileSync(supabaseSessionFile(), "utf8"));
        delete raw[key];
        writeFileSync(supabaseSessionFile(), JSON.stringify(raw, null, 2), { mode: 0o600 });
      } catch {}
    },
  };
}

let supabaseClient: SupabaseClient | null = null;
export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseClient) return supabaseClient;
  const { url, anonKey } = getSupabaseEnv();
  if (!url || !anonKey) return null;
  supabaseClient = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: fileStorage() as unknown as Storage,
      storageKey: "meteor-supabase-auth",
    },
  });
  return supabaseClient;
}

// ── mock auth (local) ──
interface MockUser { id: string; email: string; passwordHash: string; created_at: string; }
interface MockSession { access_token: string; refresh_token: string; user: { id: string; email: string }; expires_at: number; }

function loadMock(): { users: MockUser[]; session: MockSession | null } {
  try {
    if (existsSync(mockAuthFile())) return JSON.parse(readFileSync(mockAuthFile(), "utf8"));
  } catch {}
  return { users: [], session: null };
}
function saveMock(data: { users: MockUser[]; session: MockSession | null }) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(mockAuthFile(), JSON.stringify(data, null, 2), { mode: 0o600 });
}
function hashPw(pw: string): string { return createHash("sha256").update(pw).digest("hex"); }

async function mockSignUp(email: string, password: string) {
  email = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid email");
  if (password.length < 6) throw new Error("Password must be at least 6 characters");
  const db = loadMock();
  if (db.users.find(u => u.email === email)) throw new Error("User already exists");
  const user: MockUser = { id: randomUUID(), email, passwordHash: hashPw(password), created_at: new Date().toISOString() };
  db.users.push(user);
  const session: MockSession = {
    access_token: "mock_" + randomUUID(),
    refresh_token: "mock_refresh_" + randomUUID(),
    user: { id: user.id, email: user.email },
    expires_at: Date.now() + 1000 * 60 * 60 * 24 * 7,
  };
  db.session = session;
  saveMock(db);
  return { user: { id: user.id, email: user.email } as User, session: session as unknown as Session };
}
async function mockSignIn(email: string, password: string) {
  email = email.trim().toLowerCase();
  const db = loadMock();
  const user = db.users.find(u => u.email === email);
  if (!user) throw new Error("Invalid email or password");
  if (user.passwordHash !== hashPw(password)) throw new Error("Invalid email or password");
  const session: MockSession = {
    access_token: "mock_" + randomUUID(),
    refresh_token: "mock_refresh_" + randomUUID(),
    user: { id: user.id, email: user.email },
    expires_at: Date.now() + 1000 * 60 * 60 * 24 * 7,
  };
  db.session = session;
  saveMock(db);
  return { user: { id: user.id, email: user.email } as User, session: session as unknown as Session };
}
async function mockSignOut() {
  const db = loadMock();
  db.session = null;
  saveMock(db);
}
async function mockGetSession(): Promise<{ session: Session | null; user: User | null }> {
  const db = loadMock();
  if (!db.session) return { session: null, user: null };
  if (db.session.expires_at < Date.now()) {
    db.session = null;
    saveMock(db);
    return { session: null, user: null };
  }
  const u = db.users.find(x => x.id === db.session!.user.id);
  if (!u) return { session: null, user: null };
  return { session: db.session as unknown as Session, user: { id: u.id, email: u.email } as User };
}
async function mockGetUser(): Promise<User | null> {
  const { user } = await mockGetSession();
  return user;
}

// ── unified API ──
export async function authSignUp(email: string, password: string) {
  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) {
      const low = error.message.toLowerCase();
      if (low.includes("confirmation") || low.includes("sending") || low.includes("email") && low.includes("confirm")) {
        // user may have been created but email failed to send — surface helpful hint
        if (data?.user) return { user: data.user, session: data.session };
        throw new Error("Account created but confirmation email failed — disable 'Confirm email' in Supabase Dashboard > Authentication > Providers > Email, or configure SMTP.");
      }
      throw new Error(error.message);
    }
    return { user: data.user, session: data.session };
  }
  return mockSignUp(email, password);
}
export async function authSignIn(email: string, password: string) {
  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    return { user: data.user, session: data.session };
  }
  return mockSignIn(email, password);
}
export async function authSignOut() {
  const client = getSupabaseClient();
  if (client) {
    const { error } = await client.auth.signOut();
    if (error) throw new Error(error.message);
    try { if (existsSync(supabaseSessionFile())) rmSync(supabaseSessionFile()); } catch {}
    return;
  }
  return mockSignOut();
}
export async function authGetSession(): Promise<{ session: Session | null; user: User | null; isMock: boolean; isConfigured: boolean }> {
  const client = getSupabaseClient();
  const isConfigured = isSupabaseConfigured();
  if (client) {
    const { data } = await client.auth.getSession();
    const session = data.session;
    // supabase-js already handles expiry
    return { session, user: session?.user ?? null, isMock: false, isConfigured };
  }
  const { session, user } = await mockGetSession();
  return { session, user, isMock: true, isConfigured: false };
}
export async function authGetUser(): Promise<User | null> {
  const client = getSupabaseClient();
  if (client) {
    const { data } = await client.auth.getUser();
    return data.user ?? null;
  }
  return mockGetUser();
}

export async function getProfileAvatar(userId: string): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;
  try {
    const { data, error } = await client.from("profiles").select("avatar_url").eq("id", userId).maybeSingle();
    if (error) return null;
    const url = (data as { avatar_url?: string | null })?.avatar_url;
    return url && typeof url === "string" && url.trim() ? url.trim() : null;
  } catch { return null; }
}

export async function getProfile(userId: string): Promise<{ avatarUrl: string | null; fullName: string | null }> {
  const client = getSupabaseClient();
  if (!client) return { avatarUrl: null, fullName: null };
  try {
    const { data, error } = await client.from("profiles").select("avatar_url, full_name, username").eq("id", userId).maybeSingle();
    if (error) return { avatarUrl: null, fullName: null };
    const row = data as { avatar_url?: string | null; full_name?: string | null; username?: string | null } | null;
    const avatarUrl = row?.avatar_url && typeof row.avatar_url === "string" && row.avatar_url.trim() ? row.avatar_url.trim() : null;
    const fullName = row?.full_name && typeof row.full_name === "string" && row.full_name.trim() ? row.full_name.trim() : (row?.username && typeof row.username === "string" && row.username.trim() ? row.username.trim() : null);
    return { avatarUrl, fullName };
  } catch { return { avatarUrl: null, fullName: null }; }
}

// ── Projects (meteor_ prefix) ──
export interface MeteorProject {
  id: string;
  user_id: string;
  name: string;
  folder_path: string;
  created_at: string;
  updated_at: string;
  last_message?: string | null;
  preview?: string | null;
  message_count?: number;
}

function projectsFile(): string { return join(configDir(), "meteor_projects.json"); }

function loadProjectsFile(): MeteorProject[] {
  try { if (existsSync(projectsFile())) return JSON.parse(readFileSync(projectsFile(), "utf8")); } catch {}
  return [];
}
function saveProjectsFile(projects: MeteorProject[]) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(projectsFile(), JSON.stringify(projects, null, 2), { mode: 0o600 });
}

export async function listProjects(): Promise<MeteorProject[]> {
  const user = await authGetUser();
  if (!user) return [];
  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.from("meteor_projects").select("*").eq("user_id", user.id).order("updated_at", { ascending: false });
      if (!error && data) return data as MeteorProject[];
      if (error && !error.message.includes("Could not find the table")) throw error;
    } catch {}
  }
  // fallback to local file
  const all = loadProjectsFile();
  return all.filter(p => p.user_id === user.id).sort((a,b)=> new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

export async function createProject(input: { name: string; folder_path: string; last_message?: string }): Promise<MeteorProject> {
  const user = await authGetUser();
  if (!user) throw new Error("Not authenticated");
  const now = new Date().toISOString();
  const proj: MeteorProject = {
    id: randomUUID(),
    user_id: user.id,
    name: input.name,
    folder_path: input.folder_path,
    created_at: now,
    updated_at: now,
    last_message: input.last_message ?? null,
    preview: input.last_message ? input.last_message.slice(0, 120) : null,
    message_count: 1,
  };
  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.from("meteor_projects").insert({
        id: proj.id,
        user_id: proj.user_id,
        name: proj.name,
        folder_path: proj.folder_path,
        last_message: proj.last_message,
        preview: proj.preview,
        message_count: proj.message_count,
      }).select().single();
      if (!error && data) return data as MeteorProject;
      if (error && !error.message.includes("Could not find the table")) throw error;
    } catch {}
  }
  const all = loadProjectsFile();
  all.push(proj);
  saveProjectsFile(all);
  return proj;
}

export async function getProject(id: string): Promise<MeteorProject | null> {
  const user = await authGetUser();
  if (!user) return null;
  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.from("meteor_projects").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      if (!error && data) return data as MeteorProject;
      if (error && !error.message.includes("Could not find the table")) throw error;
    } catch {}
  }
  const all = loadProjectsFile();
  return all.find(p => p.id === id && p.user_id === user.id) || null;
}

export async function updateProject(id: string, updates: Partial<Pick<MeteorProject, "name" | "folder_path" | "last_message" | "preview" | "message_count">>): Promise<MeteorProject | null> {
  const user = await authGetUser();
  if (!user) return null;
  const now = new Date().toISOString();
  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.from("meteor_projects").update({ ...updates, updated_at: now }).eq("id", id).eq("user_id", user.id).select().single();
      if (!error && data) return data as MeteorProject;
      if (error && !error.message.includes("Could not find the table")) throw error;
    } catch {}
  }
  const all = loadProjectsFile();
  const idx = all.findIndex(p => p.id === id && p.user_id === user.id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...updates, updated_at: now };
  saveProjectsFile(all);
  return all[idx];
}

export async function deleteProject(id: string): Promise<void> {
  const user = await authGetUser();
  if (!user) return;
  const client = getSupabaseClient();
  if (client) {
    try {
      const { error } = await client.from("meteor_projects").delete().eq("id", id).eq("user_id", user.id);
      if (!error) {
        // also try to delete messages if table exists
        try { await client.from("meteor_messages").delete().eq("chat_id", id); } catch {}
        return;
      }
      if (!error.message.includes("Could not find the table")) throw error;
    } catch {}
  }
  const all = loadProjectsFile();
  const filtered = all.filter(p => !(p.id === id && p.user_id === user.id));
  saveProjectsFile(filtered);
  // also delete messages file if exists
  try { const f = join(configDir(), "meteor_messages", `${id}.json`); if (existsSync(f)) rmSync(f); } catch {}
}

function messagesFile(projectId: string): string { return join(configDir(), "meteor_messages", `${projectId}.json`); }

export async function saveProjectMessages(projectId: string, messages: Array<{ role: string; content: unknown }>): Promise<void> {
  // local file fallback
  try {
    mkdirSync(join(configDir(), "meteor_messages"), { recursive: true });
    writeFileSync(messagesFile(projectId), JSON.stringify(messages, null, 2), { mode: 0o600 });
  } catch {}
  // also try Supabase if available (best effort, ignore RLS errors)
  const client = getSupabaseClient();
  if (!client) return;
  try {
    const user = await authGetUser();
    if (!user) return;
    // For Supabase, we store last_message preview in project, messages are kept local for now
    // Attempt to upsert into meteor_messages is optional and may fail due to RLS — ignore
  } catch {}
}

export async function loadProjectMessages(projectId: string): Promise<Array<{ role: string; content: unknown }>> {
  try {
    const f = messagesFile(projectId);
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  } catch {}
  return [];
}
