// Permissionless seller discovery off the ERC-8004 registry. The registry is high-volume, so a
// blind "scan all events" needs an indexer; instead we resolve a PUBLISHED set of Bazaar agentIds
// (a public directory — knowing the ids is like knowing a contract address) by reading each agent's
// CURRENT endpoint on-chain (tokenURI) + reputation, then probe. Still trustless: the buyer reads
// endpoints from the chain and verifies sellers respond — no central market server.
// Also best-effort-scans recent Registered events so brand-new external sellers are picked up too.
import { type PublicClient } from "viem";
import { discoverAgents, readAgentURI } from "../rail/identity.js";
import { type SellerRef } from "../agents/economyBuyer.js";

export interface DiscoverOpts { lookbackBlocks?: bigint; maxProbe?: number; timeoutMs?: number }

export async function discoverBazaarSellers(pub: PublicClient, opts: DiscoverOpts = {}): Promise<SellerRef[]> {
  const ids = new Set<string>();

  // 1) Published Bazaar agentId directory (env): BAZAAR_AGENT_IDS="839386,839387,..." or the per-seller ids.
  const idEnv = process.env.BAZAAR_AGENT_IDS;
  if (idEnv) for (const s of idEnv.split(",")) { const t = s.trim(); if (/^\d+$/.test(t)) ids.add(t); }
  for (const k of ["A", "B", "C"]) {
    const v = process.env[`BAZAAR_SELLER_${k}_AGENTID`];
    if (v && /^\d+$/.test(v)) ids.add(v);
  }

  // 2) Best-effort: most-recent registrations (catches new external sellers on a quiet registry).
  try {
    const agents = await discoverAgents(pub, opts.lookbackBlocks ?? 30000n);
    agents.sort((a, b) => (a.agentId < b.agentId ? 1 : -1));
    for (const a of agents.slice(0, opts.maxProbe ?? 100)) ids.add(a.agentId.toString());
  } catch {
    /* event scan is best-effort */
  }

  // Resolve each agent's CURRENT endpoint from chain (reflects setAgentURI).
  const resolved = await Promise.all(
    [...ids].map(async (id) => {
      try {
        return (await readAgentURI(pub, BigInt(id))) || "";
      } catch {
        return "";
      }
    }),
  );
  const bases = [...new Set(resolved.filter((u) => /^https?:\/\//i.test(u)).map((u) => u.replace(/\/$/, "")))];

  // Probe each endpoint; keep the ones that are live Bazaar sellers.
  const sellers: SellerRef[] = [];
  await Promise.all(
    bases.map(async (base) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 3000);
        const res = await fetch(`${base}/price`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return;
        const q = (await res.json()) as { name?: string; amountWei?: string; service?: string };
        if (q?.name && q?.amountWei && q?.service) sellers.push({ name: q.name, url: base });
      } catch {
        /* not a reachable Bazaar seller — skip */
      }
    }),
  );
  return sellers;
}
