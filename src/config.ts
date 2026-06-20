import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));

// Load the shared root .env (D:\桌面\arc\.env) without a dotenv dependency.
// Keys already present in the ambient environment win.
function loadRootEnv(): void {
  const envPath = resolve(here, "../../.env");
  try {
    const text = readFileSync(envPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // No root .env — rely on ambient environment.
  }
}
loadRootEnv();

export const RPC = process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.network";
export const CHAIN_ID = Number(process.env.ARC_TESTNET_CHAIN_ID ?? 5042002);
export const EXPLORER = process.env.ARC_TESTNET_EXPLORER ?? "https://testnet.arcscan.app";
export const ESCROW = (process.env.ESCROW_V2_ADDRESS ??
  "0xc95b1b20f91901206ba3ea94bbc7313e7cd82f8d") as Hex;

export const arc = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "Arcscan", url: EXPLORER } },
});

// Shared HTTP transport. Extra retries/timeout harden against flaky RPC/proxy hops
// (e.g. sandbox egress proxies, Arc Testnet mempool pressure noted in the plan).
const transport = http(RPC, { retryCount: 6, retryDelay: 700, timeout: 30_000 });

export const publicClient = createPublicClient({ chain: arc, transport });

export function account(pk: string | undefined) {
  if (!pk) throw new Error("missing private key (set PRIVATE_KEY / SERVICE_PRIVATE_KEY in ../.env)");
  return privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
}

export function walletFor(pk: string | undefined) {
  return createWalletClient({ account: account(pk), chain: arc, transport });
}

export const BUYER_PK = process.env.PRIVATE_KEY;           // MAIN — funded buyer (escrow)
export const SELLER_PK = process.env.SERVICE_PRIVATE_KEY;  // legacy single-seller (slice1)

// Distinct per-agent seller wallets (from root .env: BAZAAR_SELLER_{A,B,C}_{ADDR,PK}).
export interface AgentWallet { name: string; address: Hex; pk: string }
export const SELLER_KEYS: AgentWallet[] = (["A", "B", "C"] as const)
  .map((n) => ({
    name: n,
    address: process.env[`BAZAAR_SELLER_${n}_ADDR`] as Hex,
    pk: process.env[`BAZAAR_SELLER_${n}_PK`] as string,
  }))
  .filter((w) => Boolean(w.address) && Boolean(w.pk));

/** Find the private key that controls a given service address (so the settler can settle as it). */
export function keyForService(serviceAddress: string): string | undefined {
  const hit = SELLER_KEYS.find((w) => w.address.toLowerCase() === serviceAddress.toLowerCase());
  return hit?.pk ?? SELLER_PK; // fall back to the legacy single seller (slice1)
}

export function txUrl(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}
