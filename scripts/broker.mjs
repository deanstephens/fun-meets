#!/usr/bin/env node
// broker.mjs — dev-only local PeerJS signaling broker over WSS.
//
// Runs a PeerJS server matching the app's `?broker=local` defaults (port 9100,
// path /myapp) so a LAN can do its own signaling instead of using the public
// PeerJS cloud broker. Signaling only — audio/video/data still flow directly
// peer-to-peer. Uses the .certs/ cert for wss:// (the app page is HTTPS, so the
// broker must be too, or the browser blocks the mixed ws:// connection).
//
// Run via: npm run broker   (BROKER_PORT / BROKER_PATH env override defaults)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PeerServer } from "peer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const certDir = path.join(root, ".certs");
const PORT = Number(process.env.BROKER_PORT) || 9100;
const BROKER_PATH = process.env.BROKER_PATH || "/myapp";

let ssl;
try {
  ssl = {
    key: fs.readFileSync(path.join(certDir, "key.pem")),
    cert: fs.readFileSync(path.join(certDir, "cert.pem")),
  };
} catch {
  console.error("Missing .certs/ — run `npm run certs` first.");
  process.exit(1);
}

PeerServer({ port: PORT, path: BROKER_PATH, ssl }, () => {
  console.log(`PeerJS broker (WSS) on wss://localhost:${PORT}${BROKER_PATH}`);
  console.log(`Open the app with ?broker=local (same host, port ${PORT}).`);
  console.log(`Accept the broker cert once per device at https://<lan-ip>:${PORT}${BROKER_PATH}`);
});
