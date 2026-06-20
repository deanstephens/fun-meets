#!/usr/bin/env node
// gen-certs.mjs — create a self-signed cert/key for local HTTPS development.
//
// The cert's SAN covers localhost, 127.0.0.1, and this machine's LAN IPv4
// address(es), so other devices on the network (phones, laptops) can reach the
// dev server and broker. Camera, screen share, and wss:// all need a secure
// context, hence HTTPS even on a LAN. Output goes to .certs/ (gitignored).
//
// Self-signed certs are untrusted, so each browser/device must accept the
// warning once (see the README). Run via: npm run certs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".certs");

function lanIPv4s() {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) ips.push(a.address);
    }
  }
  return ips;
}

const ips = lanIPv4s();
const altNames = [
  { type: 2, value: "localhost" }, // DNS
  { type: 7, ip: "127.0.0.1" }, // IP
  ...ips.map((ip) => ({ type: 7, ip })),
];

const pems = selfsigned.generate([{ name: "commonName", value: "localhost" }], {
  days: 3650,
  keySize: 2048,
  algorithm: "sha256",
  extensions: [{ name: "subjectAltName", altNames }],
});

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "key.pem"), pems.private);
fs.writeFileSync(path.join(outDir, "cert.pem"), pems.cert);

console.log("Wrote .certs/key.pem and .certs/cert.pem");
console.log("SAN: localhost, 127.0.0.1" + (ips.length ? ", " + ips.join(", ") : ""));
console.log("Self-signed — accept the warning once in each browser/device.");
