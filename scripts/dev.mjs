#!/usr/bin/env node
// dev.mjs — run the HTTPS static server and the local PeerJS broker together,
// for a one-command self-hosted LAN setup. Run via: npm run dev
// (generate certs first with `npm run certs`).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const children = [];

function run(name, file) {
  const child = spawn(process.execPath, [path.join(here, file)], { stdio: "inherit" });
  child.on("exit", (code) => {
    console.log(`[${name}] exited (${code ?? 0}); shutting down.`);
    shutdown(code || 0);
  });
  children.push(child);
}

function shutdown(code) {
  for (const c of children) {
    try { c.kill(); } catch (_) {}
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("serve", "serve.mjs");
run("broker", "broker.mjs");
