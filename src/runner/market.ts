// Bazaar — run the LIVE market: keep the seller fleet up so external agents can join.
// Sellers accept claims optimistically (enqueue); the operator settles with `npm run settle`.
import type { ChildProcess } from "node:child_process";
import { QUEUE, SELLER_FLEET, startSeller, ensureBonded } from "../market/fleet.js";

async function main(): Promise<void> {
  const children: ChildProcess[] = [];
  for (const s of SELLER_FLEET) children.push(await startSeller(s));
  console.log("posting seller quality bonds...");
  for (const s of SELLER_FLEET) await ensureBonded(s.key);

  console.log("\n=== Bazaar market is LIVE (Ctrl+C to stop) ===");
  for (const s of SELLER_FLEET) {
    console.log(`  ${s.name.padEnd(14)} http://127.0.0.1:${s.port}  ${s.price} USDC/call${s.degrade ? "  (degrader)" : ""}`);
  }
  console.log(`\nqueue:   ${QUEUE}`);
  console.log("join:    npm run byoa     (external buyer — set BYOA_PK to your own testnet wallet)");
  console.log("settle:  npm run settle   (operator batches accepted claims on-chain)");

  const stop = () => {
    for (const c of children) c.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<void>(() => {}); // keep alive until killed
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
