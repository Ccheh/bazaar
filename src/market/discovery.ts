// Permissionless seller discovery: read agents off the ERC-8004 registry (on-chain), then
// probe each advertised endpoint and keep the ones that are live Bazaar sellers. No central list.
import { type PublicClient } from "viem";
import { discoverAgents } from "../rail/identity.js";
import { type SellerRef } from "../agents/economyBuyer.js";

export interface DiscoverOpts { lookbackBlocks?: bigint; maxProbe?: number; timeoutMs?: number }

export async function discoverBazaarSellers(pub: PublicClient, opts: DiscoverOpts = {}): Promise<SellerRef[]> {
  const agents = await discoverAgents(pub, opts.lookbackBlocks ?? 20000n);
  // Newest first (agentId increments on registration); cap how many endpoints we probe.
  agents.sort((a, b) => (a.agentId < b.agentId ? 1 : -1));
  const candidates = agents
    .filter((a) => /^https?:\/\//i.test(a.uri))
    .slice(0, opts.maxProbe ?? 40);

  const sellers: SellerRef[] = [];
  await Promise.all(
    candidates.map(async (a) => {
      const base = a.uri.replace(/\/$/, "");
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2500);
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
