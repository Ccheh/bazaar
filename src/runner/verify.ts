// Bazaar — one-command, read-only evidence verifier (no keys, no 60-min wait).
// Loads every committed evidence artifact, extracts the on-chain tx hashes, and confirms each one
// on Arc Testnet via a read-only RPC receipt check. Turns "trust the README" into "verify it yourself".
// Run: NODE_USE_ENV_PROXY=1 npm run verify
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { txUrl } from "../config.js";
import { evidenceRpcUrls, fetchReceipt, loadEvidence } from "../evidence/artifacts.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../.."); // bazaar/

async function main() {
  console.log("=== Bazaar · on-chain evidence verifier (read-only) ===\n");
  console.log(`RPC failover: ${evidenceRpcUrls().length} endpoints; 8s timeout per endpoint\n`);

  let ok = 0;
  let missing = 0;
  let unavailable = 0;
  let reverted = 0;
  for (const group of loadEvidence(repo)) {
    console.log(`▸ ${group.file} — ${group.proves}`);
    if (group.txs.length === 0) {
      console.log("   (artifact or transaction hash not present)\n");
      continue;
    }

    const results = await Promise.all(group.txs.map((tx) => fetchReceipt(tx)));
    for (const result of results) {
      if (result.state === "success") ok++;
      else if (result.state === "reverted") reverted++;
      else if (result.state === "not-found") missing++;
      else unavailable++;

      const block = result.blockNumber === undefined ? "" : ` block ${result.blockNumber}`;
      const marker = result.state === "success" ? "✓" : result.state === "reverted" ? "✗" : "?";
      console.log(`   ${marker} ${result.state}${block}  ${txUrl(result.hash)}`);
    }
    console.log("");
  }
  console.log(
    `=== ${ok} confirmed, ${reverted} reverted, ${missing} absent, ${unavailable} RPC-unavailable ===`,
  );
  console.log("Each link opens the tx on Arcscan — independently verifiable, no trust required.");
}

main().catch((e) => { console.error(e?.shortMessage ?? e?.message ?? e); process.exitCode = 1; });
