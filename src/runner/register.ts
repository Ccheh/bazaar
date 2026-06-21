// Register each seller as an ERC-8004 agent on-chain, advertising its service endpoint
// as the agentURI. Idempotent: if an agentId is already stored, update the URI instead.
// Stores new agentIds back into the root .env (BAZAAR_SELLER_<K>_AGENTID).
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { walletFor, publicClient, account } from "../config.js";
import { SELLER_FLEET } from "../market/fleet.js";
import { registerAgent, setAgentURI, readAgentURI } from "../rail/identity.js";

// src/runner/register.ts -> three levels up to the shared root .env (arc/.env)
const ROOT_ENV = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");

async function main(): Promise<void> {
  for (const s of SELLER_FLEET) {
    const pk = process.env[`BAZAAR_SELLER_${s.key}_PK`];
    if (!pk) throw new Error(`missing BAZAAR_SELLER_${s.key}_PK`);
    const wallet = walletFor(pk);
    const owner = account(pk).address;
    // Endpoint a buyer connects to. Override per seller with BAZAAR_SELLER_<K>_ENDPOINT
    // (e.g. a cloudflared tunnel URL for remote reachability); defaults to localhost.
    const endpoint = process.env[`BAZAAR_SELLER_${s.key}_ENDPOINT`] ?? `http://127.0.0.1:${s.port}`;
    const existing = process.env[`BAZAAR_SELLER_${s.key}_AGENTID`];

    if (existing) {
      await setAgentURI(wallet, publicClient, BigInt(existing), endpoint);
      console.log(`${s.name}: updated agent #${existing} -> ${endpoint}`);
    } else {
      const { agentId, txHash } = await registerAgent(wallet, publicClient, endpoint);
      appendFileSync(ROOT_ENV, `BAZAAR_SELLER_${s.key}_AGENTID=${agentId}\n`);
      const readBack = await readAgentURI(publicClient, agentId);
      console.log(`${s.name}: registered as agent #${agentId} (owner ${owner})`);
      console.log(`   endpoint on-chain: "${readBack}"  tx ${txHash}`);
    }
  }
  console.log("\ndone — sellers are discoverable on the ERC-8004 IdentityRegistry.");
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
