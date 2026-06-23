// Circle Developer-Controlled Wallets — one-time setup via REST + Node crypto (NO SDK).
// Steps: fetch entity public key -> generate 32-byte entity secret -> RSA-OAEP(sha256) encrypt ->
// register (save recovery file) -> create a wallet set -> create wallets on ARC-TESTNET.
// Secrets (entity secret, recovery file) are saved LOCALLY only and never printed.
// Run: NODE_USE_ENV_PROXY=1 node circle-setup.mjs
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const ENVF = resolve(here, "../.env");                 // shared root .env (D:\桌面\arc\.env)
// secrets stay in-repo but .gitignored; wallet list is in-repo + committed (addresses only, no secret)
const RECOVERY = resolve(here, "circle-recovery.dat");
const SECRET_BACKUP = resolve(here, "circle-entity-secret.txt");

function loadEnv(p) {
  const e = {};
  for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
    const s = l.trim(); if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("="); if (i < 1) continue;
    e[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return e;
}
const env = loadEnv(ENVF);
const KEY = env.CIRCLE_API_KEY;
if (!KEY) throw new Error("CIRCLE_API_KEY missing in .env");
const BASE = "https://api.circle.com/v1/w3s";
const H = { authorization: `Bearer ${KEY}`, "content-type": "application/json", accept: "application/json" };

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// 1. entity public key
const publicKey = (await api("GET", "/config/entity/publicKey")).data.publicKey;
console.log("✓ fetched entity public key");

// 2. entity secret (reuse if already set up)
let entitySecret = env.CIRCLE_ENTITY_SECRET;
const firstTime = !entitySecret;
if (firstTime) {
  entitySecret = crypto.randomBytes(32).toString("hex");
  writeFileSync(SECRET_BACKUP, entitySecret, "utf8"); // local backup before any network call, so it's never lost
}
const encrypt = () => crypto.publicEncrypt(
  { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
  Buffer.from(entitySecret, "hex"),
).toString("base64"); // FRESH ciphertext per call (RSA-OAEP is randomized + single-use)

// 3. register entity secret (first time only) -> save recovery file
if (firstTime) {
  const reg = await api("POST", "/config/entity/entitySecret/ciphertext", { entitySecretCiphertext: encrypt() });
  const recovery = reg.data?.recoveryFile ?? "";
  writeFileSync(RECOVERY, recovery, "utf8");
  appendFileSync(ENVF, `\nCIRCLE_ENTITY_SECRET=${entitySecret}`);
  console.log("✓ entity secret registered; recovery file -> circle-recovery.dat (KEEP SAFE, do not commit)");
} else {
  console.log("• entity secret already in .env — skipping registration");
}

// 4. wallet set
let walletSetId = env.CIRCLE_WALLET_SET_ID;
if (!walletSetId) {
  const ws = await api("POST", "/developer/walletSets", { idempotencyKey: crypto.randomUUID(), entitySecretCiphertext: encrypt(), name: "Bazaar" });
  walletSetId = ws.data.walletSet.id;
  appendFileSync(ENVF, `\nCIRCLE_WALLET_SET_ID=${walletSetId}`);
  console.log("✓ wallet set:", walletSetId);
} else {
  console.log("• wallet set already exists:", walletSetId);
}

// 5. wallets on ARC-TESTNET
const blockchain = process.env.CIRCLE_BLOCKCHAIN ?? "ARC-TESTNET";
const count = Number(process.env.CIRCLE_WALLET_COUNT ?? 2);
const accountType = process.env.CIRCLE_ACCOUNT_TYPE ?? "EOA";
console.log(`creating ${count} ${accountType} wallet(s) on ${blockchain}…`);
const created = await api("POST", "/developer/wallets", {
  idempotencyKey: crypto.randomUUID(), entitySecretCiphertext: encrypt(),
  walletSetId, blockchains: [blockchain], count, accountType,
});
const wallets = (created.data.wallets ?? []).map((w) => ({ id: w.id, address: w.address, blockchain: w.blockchain, accountType: w.accountType, state: w.state }));
console.log("✓ wallets created:");
console.log(JSON.stringify(wallets, null, 2));
writeFileSync(resolve(here, "circle-wallets.json"), JSON.stringify(wallets, null, 2));
console.log("saved -> circle-wallets.json");
