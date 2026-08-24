#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

console.log("\x1b[1mMeteor — Build Plan (dry-run)\x1b[0m\n");
console.log("This shows what \x1b[33mnpm run build\x1b[0m would do, without writing files.\n");

try {
  const out = execSync("npx tsc --noEmit --listFiles 2>&1", { encoding: "utf8" });
  const files = out.split("\n").map(s => s.trim()).filter(Boolean)
    .filter(f => f.includes("/src/") || f.includes("/src-electron/") || f.includes("\\src\\"))
    .map(f => "  • " + path.relative(process.cwd(), f))
    .join("\n");
  console.log("\x1b[1mWould compile:\x1b[0m");
  console.log(files || "  (no files — check tsconfig)");
} catch (e) {
  const msg = e.stdout || e.message;
  console.log(msg.slice(0, 4000));
}

console.log("\n\x1b[1mWould emit to:\x1b[0m");
console.log("  dist/src/              ← CLI (meteor command)");
console.log("  dist/src-electron/     ← Electron main");

try {
  const check = execSync("npx tsc --noEmit 2>&1", { encoding: "utf8" });
  if (!check.trim()) console.log("\n\x1b[32m✔ Typecheck clean — build would succeed.\x1b[0m");
  else console.log("\n" + check.slice(0, 4000));
} catch (e) {
  console.log("\n\x1b[31m✘ Type errors — build would fail:\x1b[0m");
  console.log((e.stdout || e.message).slice(0, 6000));
}

console.log("\n\x1b[2mRun \x1b[0m\x1b[33mnpm run build\x1b[0m\x1b[2m to actually build, or \x1b[0m\x1b[33mnpm run app\x1b[0m\x1b[2m to build + launch.\x1b[0m");
console.log("\x1b[2mIn the app, use Plan / Build toggle: Plan previews file writes, Build writes them.\x1b[0m");
