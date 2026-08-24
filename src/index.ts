import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
import { MODELS, DEFAULT_MODEL, resolveModel, type MeteorModel } from "./models.js";
import { complete, ZenError, type Message } from "./zen.js";
import { clearApiKey, loadConfig, resolveApiKey, resetConfig, saveConfig } from "./config.js";

const VERSION = "0.2.0";
const DEFAULT_SYSTEM =
  "You are Meteor, a helpful assistant. Answer concisely. You can use full markdown: headings, bold, italic, lists, tables, blockquotes, links, and fenced code blocks with language tags. Prefer markdown for structure and readability.";

interface CliArgs {
  model?: string;
  system?: string;
  apiKey?: string;
  reasoningEffort?: string;
  stream: boolean;
  prompt: string[];
  command?: string;
  help: boolean;
  version: boolean;
}

const USAGE = `Meteor — AI in your terminal

Usage
  meteor [prompt...]              One-shot question (streams the answer)
  meteor chat [-m <model>]        Interactive session
  meteor build                    Build the project (emits to dist/)
  meteor plan                     Plan the build — preview without writing files
  meteor models                   List available models
  meteor auth set <api-key>       Store your API key
  meteor auth show                Show where the API key comes from
  meteor auth clear               Remove stored API key

Modes
  Build   actually writes files (code + dist)
  Plan    previews the plan only — no files are written.
          In the app, toggle Plan / Build at the top.
          In the CLI, use  meteor plan  vs  meteor build
          or  npm run plan  vs  npm run build

Models
  sunlight-2        Sunlight 2
  sunlight-2-pro    Sunlight 2 Pro   (default)

Options
  -m, --model <model>    Model (sunlight-2 or sunlight-2-pro)
  -r, --reasoning <effort> Reasoning effort (auto, low, high, max)
  -s, --system <text>    Override the system prompt
      --api-key <key>    Use this key for one call (else METEOR_API_KEY / stored key)
      --no-stream        Wait for the full response instead of streaming
  -h, --help             Show this help
  -v, --version          Show version

Environment
  METEOR_API_KEY         Your Meteor API key
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { stream: true, prompt: [], help: false, version: false };
  const rest = [...argv];
  if (rest.length > 0 && !rest[0].startsWith("-") && ["chat", "models", "auth", "help", "build", "plan"].includes(rest[0])) {
    args.command = rest.shift();
  }
  while (rest.length > 0) {
    const arg = rest.shift()!;
    switch (arg) {
      case "-m":
      case "--model":
        args.model = rest.shift();
        break;
      case "-r":
      case "--reasoning":
        args.reasoningEffort = rest.shift();
        break;
      case "-s":
      case "--system":
        args.system = rest.shift();
        break;
      case "--api-key":
        args.apiKey = rest.shift();
        break;
      case "--no-stream":
        args.stream = false;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        args.prompt.push(arg);
    }
  }
  return args;
}

function requireKey(args: CliArgs): string {
  const key = resolveApiKey(args.apiKey);
  if (!key) {
    console.error(
      "No API key found. Set METEOR_API_KEY, or run:\n  meteor auth set <your-key>",
    );
    process.exit(1);
  }
  return key;
}

async function runCompletion(args: CliArgs, messages: Message[], apiKey: string, model: MeteorModel): Promise<string> {
  const allowed = ["low", "high", "max"];
  const re = args.reasoningEffort && allowed.includes(args.reasoningEffort) ? args.reasoningEffort : undefined;
  const res = await complete(
    {
      apiKey,
      apiModel: model.apiModel,
      protocol: model.protocol,
      messages,
      stream: args.stream,
      reasoningEffort: re,
      onDelta: (text) => process.stdout.write(text),
    },
  );
  if (res.toolCalls.length > 0) {
    process.stdout.write(`\n\n[tool calls: ${res.toolCalls.map((t) => `${t.server}.${t.toolName}`).join(", ")}]\n`);
  }
  return res.text;
}

function renderAnsi(md: string): string {
  const codeBlocks: string[] = [];
  md = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`\x1b[2m\x1b[90m┌─ ${lang || "code"} ─┐\x1b[0m\n${code.trimEnd()}\n\x1b[2m\x1b[90m└${"─".repeat(20)}\x1b[0m`);
    return `\x00CB${idx}\x00`;
  });
  md = md.replace(/`([^`]+?)`/g, (_, c) => `\x1b[7m ${c} \x1b[0m`);
  md = md.replace(/^######\s+(.*)$/gm, "\x1b[1m\x1b[2m$1\x1b[0m");
  md = md.replace(/^#####\s+(.*)$/gm, "\x1b[1m\x1b[2m$1\x1b[0m");
  md = md.replace(/^####\s+(.*)$/gm, "\x1b[1m$1\x1b[0m");
  md = md.replace(/^###\s+(.*)$/gm, "\x1b[1m\x1b[4m$1\x1b[0m");
  md = md.replace(/^##\s+(.*)$/gm, "\x1b[1m\x1b[4m$1\x1b[0m");
  md = md.replace(/^#\s+(.*)$/gm, "\x1b[1m\x1b[4m\x1b[33m$1\x1b[0m");
  md = md.replace(/\*\*(.+?)\*\*/g, "\x1b[1m$1\x1b[22m");
  md = md.replace(/__(.+?)__/g, "\x1b[1m$1\x1b[22m");
  md = md.replace(/~~(.+?)~~/g, "\x1b[9m$1\x1b[29m");
  md = md.replace(/\*(.+?)\*/g, "\x1b[3m$1\x1b[23m");
  md = md.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, "\x1b[4m\x1b[34m$1\x1b[0m (\x1b[2m$2\x1b[0m)");
  md = md.replace(/^\s*>\s?(.*)$/gm, "\x1b[2m▎ $1\x1b[0m");
  md = md.replace(/^\s*[-*+]\s+(.*)$/gm, "  \x1b[33m•\x1b[0m $1");
  md = md.replace(/^\s*\d+\.\s+(.*)$/gm, "  \x1b[33m$&\x1b[0m");
  md = md.replace(/^\s*([-*_])\s*\1\s*\1(\s*\1)*\s*$/gm, "\x1b[2m" + "─".repeat(40) + "\x1b[0m");
  md = md.replace(/\x00CB(\d+)\x00/g, (_, n) => codeBlocks[Number(n)] || "");
  return md;
}

async function askOnce(args: CliArgs): Promise<void> {
  const apiKey = requireKey(args);
  const model = resolveModel(args.model ?? loadConfig().defaultModel);
  const prompt = args.prompt.join(" ").trim();
  if (!prompt) throw new Error("Provide a prompt, e.g. meteor \"explain event loops\"");
  const messages: Message[] = [
    { role: "system", content: args.system ?? DEFAULT_SYSTEM },
    { role: "user", content: prompt },
  ];
  const answer = await runCompletion(args, messages, apiKey, model);
  if (!args.stream && answer) {
    const out = process.stdout.isTTY ? renderAnsi(answer) : answer;
    console.log(out);
  } else process.stdout.write("\n");
}

async function chatLoop(args: CliArgs): Promise<void> {
  const apiKey = requireKey(args);
  const model = resolveModel(args.model ?? loadConfig().defaultModel);
  let reasoningEffort = args.reasoningEffort ?? "";
  const reLabel = () => reasoningEffort ? ` · reasoning ${reasoningEffort}` : "";
  console.log(`Meteor chat — ${model.name}${reLabel()}`);
  console.log('Type /exit to quit, /clear to reset history, /model to switch models, /reasoning to set effort.\n');
  const rl = createInterface({ input, output });
  const history: Message[] = [{ role: "system", content: args.system ?? DEFAULT_SYSTEM }];
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  rl.on("line", (line: string) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      queue.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  const nextLine = (): Promise<string | null> => {
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiter = resolve;
    });
  };
  try {
    while (true) {
      process.stdout.write("you > ");
      const raw = await nextLine();
      if (raw === null) {
        process.stdout.write("\n");
        break;
      }
      const line = raw.trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/clear") {
        history.length = 0;
        history.push({ role: "system", content: args.system ?? DEFAULT_SYSTEM });
        console.log("(history cleared)\n");
        continue;
      }
      if (line === "/model" || line.startsWith("/model ")) {
        const target = line.slice("/model".length).trim() || undefined;
        const next = resolveModel(target);
        model.key = next.key;
        Object.assign(model, next);
        console.log(`switched to ${next.name}${reLabel()}\n`);
        continue;
      }
      if (line === "/reasoning" || line.startsWith("/reasoning ")) {
        const target = line.slice("/reasoning".length).trim().toLowerCase();
        const allowed = ["", "auto", "low", "high", "max"];
        if (!target) {
          console.log(`reasoning effort: ${reasoningEffort || "auto"} (available: ${allowed.filter(Boolean).join(", ")})\n`);
        } else if (!allowed.includes(target)) {
          console.log(`unknown reasoning "${target}". Available: ${allowed.filter(Boolean).join(", ")}\n`);
        } else {
          reasoningEffort = target === "auto" ? "" : target;
          args.reasoningEffort = reasoningEffort;
          console.log(`reasoning effort → ${reasoningEffort || "auto"}\n`);
        }
        continue;
      }
      if (line === "/help") {
        console.log("/exit /clear /model [name] /reasoning [effort] /help\n");
        continue;
      }
      history.push({ role: "user", content: line });
      process.stdout.write(`${model.name.toLowerCase()}${reLabel()} > `);
      let answer = "";
      try {
        answer = await runCompletion(args, history, apiKey, model);
        if (!args.stream && answer) {
          const out = process.stdout.isTTY ? renderAnsi(answer) : answer;
          process.stdout.write(out);
        }
      } catch (err) {
        process.stdout.write("\n");
        if (err instanceof Error) console.error(`error: ${err.message}`);
        history.pop();
        continue;
      }
      process.stdout.write("\n\n");
      history.push({ role: "assistant", content: answer });
    }
  } finally {
    rl.close();
  }
}

function listModels(): void {
  const cfg = loadConfig();
  for (const m of Object.values(MODELS)) {
    const isDefault = m.key === (cfg.defaultModel ? resolveModel(cfg.defaultModel).key : DEFAULT_MODEL);
    console.log(`${m.key.padEnd(16)} ${m.name}${isDefault ? "  [default]" : ""}`);
  }
}

function runBuild(planOnly: boolean): void {
  if (planOnly) {
    const r = spawnSync("node", ["scripts/plan.mjs"], { stdio: "inherit" });
    process.exitCode = r.status ?? 0;
    return;
  }
  console.log("\x1b[1m▶ Building Meteor…\x1b[0m");
  const r = spawnSync("npx", ["tsc"], { stdio: "inherit" });
  if (r.status === 0) console.log("\n\x1b[32m✔ Build complete → dist/\x1b[0m");
  else console.log("\n\x1b[31m✘ Build failed\x1b[0m");
  process.exitCode = r.status ?? 1;
}

async function authAction(sub: string | undefined, value: string | undefined): Promise<void> {
  switch (sub) {
    case "set": {
      if (!value) throw new Error("Usage: meteor auth set <api-key>");
      saveConfig({ apiKey: value });
      console.log("API key saved to ~/.config/meteor/config.json");
      return;
    }
    case "show": {
      const source = process.env.METEOR_API_KEY || process.env.OPENCODE_API_KEY
        ? "environment (METEOR_API_KEY/OPENCODE_API_KEY)"
        : loadConfig().apiKey
          ? "~/.config/meteor/config.json"
          : "not configured";
      console.log(`API key source: ${source}`);
      return;
    }
    case "clear": {
      console.log(clearApiKey() ? "Stored API key removed." : "No stored API key found.");
      return;
    }
    default:
      throw new Error("Usage: meteor auth <set|show|clear> [args]");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) return console.log(`meteor ${VERSION}`);
  if (args.help || args.command === "help") return console.log(USAGE);

  try {
    switch (args.command) {
      case "chat":
        return await chatLoop(args);
      case "build":
        return runBuild(false);
      case "plan":
        return runBuild(true);
      case "models":
        return listModels();
      case "auth":
        return await authAction(args.prompt[0], args.prompt[1]);
      default:
        if (args.prompt.length === 0) return console.log(USAGE);
        return await askOnce(args);
    }
  } catch (err) {
    if (err instanceof ZenError && err.status === 401) {
      console.error("error: Unauthorized — check your API key");
    } else if (err instanceof Error) {
      console.error(`error: ${err.message}`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  }
}

await main();

export { resetConfig };
