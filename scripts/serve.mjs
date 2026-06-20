#!/usr/bin/env node
// serve.mjs — dev-only HTTPS static server for the Fun Meets app.
//
// Serves the project root over HTTPS on all interfaces (so LAN devices can
// connect) with a secure context, which the browser requires for camera and
// screen-share access. This is ONLY for local development — the app is plain
// static files; for real deployment just host them anywhere static (e.g. GitHub
// Pages). Run via: npm run serve   (PORT env overrides the default 8443)
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const certDir = path.join(root, ".certs");
const PORT = Number(process.env.PORT) || 8443;

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp",
  ".wasm": "application/wasm", ".map": "application/json",
};

function handler(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(root, urlPath);
  // Refuse anything that escapes the project root (path traversal).
  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

let key, cert;
try {
  key = fs.readFileSync(path.join(certDir, "key.pem"));
  cert = fs.readFileSync(path.join(certDir, "cert.pem"));
} catch {
  console.error("Missing .certs/ — run `npm run certs` first.");
  process.exit(1);
}

https.createServer({ key, cert }, handler).listen(PORT, "0.0.0.0", () => {
  console.log(`Fun Meets served over HTTPS: https://localhost:${PORT}/`);
  console.log(`LAN: https://<your-lan-ip>:${PORT}/  (accept the self-signed cert on each device)`);
});
