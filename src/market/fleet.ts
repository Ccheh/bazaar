// Shared seller-fleet helpers used by the economy runner and the standalone market runner.
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { parseEther, type Hex } from "viem";
import { walletFor, publicClient } from "../config.js";
import { MOCK_RESOLVER, depositBond, allowResolver, bondAvailable } from "../rail/crucible.js";

export const QUEUE = resolve(process.cwd(), "pending-claims.jsonl");

export interface SellerSpec { name: string; port: number; price: string; degrade: boolean; key: string }

export const SELLER_FLEET: SellerSpec[] = [
  { name: "summarizer-A", port: 7421, price: "0.002", degrade: false, key: "A" },
  { name: "analyst-B", port: 7422, price: "0.003", degrade: false, key: "B" },
  { name: "cheapbot-C", port: 7423, price: "0.001", degrade: true, key: "C" }, // cheapest, but a degrader
];

export const SELLER_BOND = parseEther("0.01"); // quality stake a seller posts
export const SLASH_BOND_LOCK = parseEther("0.003"); // locked (and slashable) per dispute

/** Spawn a child runner as `node --import tsx <script>` (no shell). */
export function spawnRunner(script: string, extraEnv: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** Start one seller process under its own wallet; resolves once it logs SELLER_READY. */
export function startSeller(s: SellerSpec): Promise<ChildProcess> {
  const pk = process.env[`BAZAAR_SELLER_${s.key}_PK`];
  if (!pk) throw new Error(`missing BAZAAR_SELLER_${s.key}_PK in ../.env`);
  const child = spawnRunner("src/runner/seller-proc.ts", {
    BAZAAR_SELLER_NAME: s.name,
    BAZAAR_SELLER_PORT: String(s.port),
    BAZAAR_PRICE: s.price,
    BAZAAR_DEGRADE: s.degrade ? "1" : "0",
    BAZAAR_SELLER_PK: pk,
    BAZAAR_QUEUE: QUEUE,
  });
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${s.name} not ready in 30s`)), 30_000);
    child.stdout!.on("data", (b: Buffer) => {
      if (b.toString().includes("SELLER_READY")) {
        clearTimeout(timer);
        res(child);
      }
    });
    child.on("exit", (c) => {
      clearTimeout(timer);
      rej(new Error(`${s.name} exited early (${c})`));
    });
  });
}

/** Ensure a seller has a bond posted + the resolver whitelisted (idempotent-ish). */
export async function ensureBonded(key: string): Promise<void> {
  const pk = process.env[`BAZAAR_SELLER_${key}_PK`];
  const addr = process.env[`BAZAAR_SELLER_${key}_ADDR`] as Hex;
  if (!pk || !addr) throw new Error(`missing BAZAAR_SELLER_${key}_{PK,ADDR}`);
  const wallet = walletFor(pk);
  if ((await bondAvailable(publicClient, addr)) < SLASH_BOND_LOCK) {
    await depositBond(wallet, publicClient, SELLER_BOND);
  }
  await allowResolver(wallet, publicClient, MOCK_RESOLVER);
}
