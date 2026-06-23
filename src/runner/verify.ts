// Bazaar — one-command, read-only evidence verifier (no keys, no 60-min wait).
// Loads every committed evidence artifact, extracts the on-chain tx hashes, and confirms each one
// on Arc Testnet via a read-only RPC receipt check. Turns "trust the README" into "verify it yourself".
// Run: NODE_USE_ENV_PROXY=1 npm run verify
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicClient, txUrl } from "../config.js";
import type { Hex } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../.."); // bazaar/

const ARTIFACTS: { file: string; proves: string }[] = [
  { file: ".trustless-state.json", proves: "TRUSTLESS slash: bad→bond slashed, good→protected + lying-buyer forfeit, V3 outlier slashed" },
  { file: "circle-pay.json", proves: "Circle DCW sub-cent USDC nanopayment (COMPLETE)" },
  { file: ".circle-trustless-state.json", proves: "Circle wallet OPENS+DISPUTES the bonded market (+ resolve when windows close)" },
  { file: "byoa-external.json", proves: "external independently-keyed agent pays a seller on the public rail" },
  { file: "beginner-agent.json", proves: "Claude-powered beginner agent (own wallet) pays on-chain" },
];

// Collect ONLY real tx-hash fields (txHash / settleTx / openTx / disputeTx) — not salts/marketIds/commitmentHashes.
function txsIn(obj: unknown, out: Set<Hex> = new Set()): Hex[] {
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) && /tx|settle/i.test(k)) out.add(v as Hex);
      else if (v && typeof v === "object") txsIn(v, out);
    }
  }
  return [...out];
}

async function main() {
  console.log("=== Bazaar · on-chain evidence verifier (read-only) ===\n");
  let ok = 0, miss = 0, bad = 0;
  for (const a of ARTIFACTS) {
    const p = resolve(repo, a.file);
    if (!existsSync(p)) { console.log(`• ${a.file} — (not present; run the matching script)\n`); continue; }
    const txs = txsIn(JSON.parse(readFileSync(p, "utf8")));
    console.log(`▸ ${a.file} — ${a.proves}`);
    if (txs.length === 0) { console.log("   (no tx hash yet — run in flight)\n"); continue; }
    for (const tx of txs) {
      try {
        const r = await publicClient.getTransactionReceipt({ hash: tx });
        const good = r.status === "success";
        good ? ok++ : bad++;
        console.log(`   ${good ? "✓" : "✗"} ${r.status.padEnd(7)} block ${r.blockNumber}  ${txUrl(tx)}`);
      } catch {
        miss++;
        console.log(`   ? not-found  ${txUrl(tx)}  (RPC couldn't fetch — check ARC_TESTNET_RPC / proxy)`);
      }
    }
    console.log("");
  }
  console.log(`=== ${ok} confirmed on-chain, ${bad} failed, ${miss} unfetchable ===`);
  console.log("Each link opens the tx on Arcscan — independently verifiable, no trust required.");
}

main().catch((e) => { console.error(e?.shortMessage ?? e?.message ?? e); process.exitCode = 1; });
