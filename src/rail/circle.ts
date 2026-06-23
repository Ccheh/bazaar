// Circle Developer-Controlled Wallets — minimal REST client (NO SDK), used to let a Bazaar agent
// pay from a Circle-managed wallet on ARC-TESTNET. Auth = CIRCLE_API_KEY; sensitive ops append a
// fresh entitySecretCiphertext (RSA-OAEP-sha256 of the 32-byte CIRCLE_ENTITY_SECRET). Needs the
// sandbox egress proxy at runtime (NODE_USE_ENV_PROXY=1).
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../config.js"; // side-effect: loads the shared root .env

const here = dirname(fileURLToPath(import.meta.url));
const BASE = "https://api.circle.com/v1/w3s";

export function circleEnabled(): boolean {
  return Boolean(process.env.CIRCLE_API_KEY && process.env.CIRCLE_ENTITY_SECRET);
}

function authHeaders(): Record<string, string> {
  const k = process.env.CIRCLE_API_KEY;
  if (!k) throw new Error("CIRCLE_API_KEY missing in ../.env");
  return { authorization: `Bearer ${k}`, "content-type": "application/json", accept: "application/json" };
}

export async function circleApi<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json().catch(() => ({}))) as { data?: T };
  if (!res.ok) throw new Error(`Circle ${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json.data as T;
}

let cachedPk: string | undefined;
async function publicKey(): Promise<string> {
  if (!cachedPk) cachedPk = (await circleApi<{ publicKey: string }>("GET", "/config/entity/publicKey")).publicKey;
  return cachedPk;
}

/** Fresh, single-use ciphertext required by every sensitive Circle call (randomized RSA-OAEP). */
export async function entityCiphertext(): Promise<string> {
  const secret = process.env.CIRCLE_ENTITY_SECRET;
  if (!secret) throw new Error("CIRCLE_ENTITY_SECRET missing — run circle-setup.mjs / register in console first");
  const pk = await publicKey();
  return crypto.publicEncrypt(
    { key: pk, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(secret, "hex"),
  ).toString("base64");
}

export interface CircleWallet { id: string; address: string; blockchain: string; accountType: string; state: string }
export function circleWallets(): CircleWallet[] {
  const p = resolve(here, "../../circle-wallets.json"); // in-repo (bazaar/), produced by `npm run circle:setup`
  if (!existsSync(p)) throw new Error("circle-wallets.json missing — run `npm run circle:setup` first (creates Circle wallets on ARC-TESTNET)");
  return JSON.parse(readFileSync(p, "utf8")) as CircleWallet[];
}

interface TokenBalance { token: { id: string; isNative: boolean; symbol: string }; amount: string }
export async function nativeTokenId(walletId: string): Promise<string> {
  const r = await circleApi<{ tokenBalances: TokenBalance[] }>("GET", `/wallets/${walletId}/balances?includeAll=true`);
  const native = (r.tokenBalances ?? []).find((t) => t.token?.isNative);
  if (!native) throw new Error("no native token found for wallet (fund it first)");
  return native.token.id;
}

export interface TxState { id: string; state: string; txHash?: string }
/** Initiate a developer-controlled transfer (native USDC on Arc). Returns the Circle transaction id + initial state. */
export async function transfer(walletId: string, destinationAddress: string, amount: string, tokenId: string, feeLevel = "MEDIUM"): Promise<TxState> {
  const r = await circleApi<{ id: string; state: string }>("POST", "/developer/transactions/transfer", {
    idempotencyKey: crypto.randomUUID(),
    entitySecretCiphertext: await entityCiphertext(),
    walletId, destinationAddress, tokenId, amounts: [amount], feeLevel,
  });
  return { id: r.id, state: r.state };
}

export async function getTransaction(id: string): Promise<TxState> {
  const r = await circleApi<{ transaction: TxState }>("GET", `/transactions/${id}`);
  return r.transaction;
}

/** Execute an arbitrary contract call FROM a Circle-managed wallet (Circle signs + broadcasts).
 *  `callData` is the abi-encoded function call; `amountUsdc` is the native USDC value to send
 *  (for payable calls like openMarket/dispute). This is how a Circle wallet becomes a load-bearing
 *  agent in the bonded Crucible market — not just a side transfer. */
export async function contractExecution(
  walletId: string, contractAddress: string, callData: string, amountUsdc?: string, feeLevel = "MEDIUM",
): Promise<TxState> {
  const body: Record<string, unknown> = {
    idempotencyKey: crypto.randomUUID(),
    entitySecretCiphertext: await entityCiphertext(),
    walletId, contractAddress, callData, feeLevel,
  };
  if (amountUsdc) body.amount = amountUsdc; // native value sent with the call
  const r = await circleApi<{ id: string; state: string }>("POST", "/developer/transactions/contractExecution", body);
  return { id: r.id, state: r.state };
}

const TERMINAL = ["CONFIRMED", "COMPLETE", "FAILED", "DENIED", "CANCELLED"];
/** Poll a Circle transaction until it reaches a terminal state (or a tx hash + CONFIRMED). */
export async function waitForTx(id: string, onTick?: (t: TxState) => void, tries = 40, gapMs = 4000): Promise<TxState> {
  let t = await getTransaction(id);
  for (let i = 0; i < tries && !TERMINAL.includes(t.state); i++) {
    await new Promise((r) => setTimeout(r, gapMs));
    t = await getTransaction(id);
    onTick?.(t);
  }
  return t;
}
