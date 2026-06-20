// A buyer that chooses among MANY sellers each round and keeps per-seller memory.
// Routing/avoidance emerges from the LLM's own reasoning over that memory + price.
import { formatEther, type Address } from "viem";
import { walletFor } from "../config.js";
import { signClaim, encodeClaim } from "../rail/escrow.js";
import { askLLM, extractJson } from "./llm.js";

export interface Persona {
  name: string;
  pk: string;
  budgetUsdc: number;
  task: string;
  style: string;
  qualityBar: number;
}
export interface SellerRef { name: string; url: string }
export interface SellerMem { buys: number; avgScore: number }
export type Memory = Record<string, SellerMem>;

interface Quote { name: string; service: Address; amountWei: string; priceUsdc: number }

export interface RoundResult {
  buyer: string;
  bought: boolean;
  chosen?: string;
  priceUsdc?: number;
  score?: number;
  via: "llm" | "heuristic";
  reason: string;
  gradeReason?: string;
}

async function getQuote(s: SellerRef): Promise<Quote | null> {
  try {
    const r = await fetch(`${s.url}/price`);
    const q = (await r.json()) as { name: string; service: Address; amountWei: string };
    return { name: q.name, service: q.service, amountWei: q.amountWei, priceUsdc: Number(formatEther(BigInt(q.amountWei))) };
  } catch {
    return null;
  }
}

function heuristicPick(p: Persona, quotes: Quote[], mem: Memory) {
  // Avoid sellers whose known avg score is below the bar; among the rest, frugal => cheapest.
  const acceptable = quotes.filter((q) => {
    const m = mem[q.name];
    return !m || m.buys === 0 || m.avgScore >= p.qualityBar;
  });
  const pool = (acceptable.length ? acceptable : quotes).slice().sort((a, b) => a.priceUsdc - b.priceUsdc);
  const pick = pool[0];
  return { action: "buy", service: pick.name, maxPriceUsdc: pick.priceUsdc, reason: "cheapest acceptable seller (heuristic)" };
}

function heuristicGrade(output: unknown) {
  const o = output as { quality?: string; points?: unknown[] };
  const ok = o?.quality === "full" && Array.isArray(o?.points) && o.points.length > 0;
  return { score: ok ? 85 : 10, reason: ok ? "non-empty structured summary" : "empty / degraded output" };
}

export async function buyerRound(
  p: Persona,
  sellers: SellerRef[],
  mem: Memory,
  escrow: Address,
  chainId: number,
  spend: { paid: number },
): Promise<RoundResult> {
  const quotes = (await Promise.all(sellers.map(getQuote))).filter(Boolean) as Quote[];
  if (quotes.length === 0) return { buyer: p.name, bought: false, via: "heuristic", reason: "no sellers reachable" };

  const services = quotes.map((q) => ({
    name: q.name,
    priceUsdc: q.priceUsdc,
    yourHistory: mem[q.name] ?? { buys: 0, avgScore: null },
  }));
  const budgetLeft = (p.budgetUsdc - spend.paid).toFixed(4);
  const sys =
    `You are "${p.name}", an autonomous buyer agent in a live nanopayment market on Arc. ` +
    `Style: ${p.style}. Task: "${p.task}". Budget left: ${budgetLeft} USDC. ` +
    `Choose AT MOST ONE service to buy this round, or skip. This is a new market: if a seller ` +
    `has no history (buys=0), it is worth sampling it once to learn its quality — unless another ` +
    `seller is already clearly excellent and cheaper. Once a seller under-delivers (low score), ` +
    `avoid it going forward. Reply ONLY JSON: ` +
    `{"action":"buy"|"skip","service":"<name or empty>","maxPriceUsdc":number,"reason":"<one sentence>"}.`;
  const parsed = extractJson<{ action: string; service: string; maxPriceUsdc: number; reason: string }>(
    await askLLM(sys, `Services: ${JSON.stringify(services)}`),
  );
  const decision = parsed ?? heuristicPick(p, quotes, mem);
  const via: "llm" | "heuristic" = parsed ? "llm" : "heuristic";

  if (decision.action !== "buy" || !decision.service) {
    return { buyer: p.name, bought: false, via, reason: decision.reason };
  }
  const q = quotes.find((x) => x.name === decision.service);
  if (!q) return { buyer: p.name, bought: false, via, reason: `chose unknown service "${decision.service}"` };
  if (q.priceUsdc > decision.maxPriceUsdc || p.budgetUsdc - spend.paid < q.priceUsdc) {
    return { buyer: p.name, bought: false, chosen: q.name, priceUsdc: q.priceUsdc, via, reason: `${decision.reason} (over max/budget)` };
  }

  // Pay: sign claim, call the chosen seller.
  const seller = sellers.find((s) => s.name === q.name)!;
  const wallet = walletFor(p.pk);
  const claim = await signClaim(wallet, { escrow, chainId, service: q.service, amount: BigInt(q.amountWei) });
  let work: { result?: unknown; queued?: boolean; error?: string };
  try {
    const wr = await fetch(`${seller.url}/work`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bazaar-claim": encodeClaim(claim) },
      body: JSON.stringify({ input: p.task }),
    });
    work = (await wr.json()) as typeof work;
    if (!wr.ok || !work.queued) {
      return { buyer: p.name, bought: false, chosen: q.name, priceUsdc: q.priceUsdc, via, reason: `seller error: ${work.error ?? wr.status}` };
    }
  } catch (e) {
    return { buyer: p.name, bought: false, chosen: q.name, priceUsdc: q.priceUsdc, via, reason: `call failed: ${(e as Error).message}` };
  }
  spend.paid += q.priceUsdc;

  // Grade, then update memory (this is what drives next-round routing).
  const gsys =
    `You are "${p.name}". Grade 0-100 the delivered output for task "${p.task}" (min acceptable ${p.qualityBar}). ` +
    `Reply ONLY JSON: {"score":number,"reason":"<one sentence>"}.`;
  const grade =
    extractJson<{ score: number; reason: string }>(await askLLM(gsys, `Output: ${JSON.stringify(work.result).slice(0, 500)}`)) ??
    heuristicGrade(work.result);

  const m = mem[q.name] ?? { buys: 0, avgScore: 0 };
  const buys = m.buys + 1;
  mem[q.name] = { buys, avgScore: Math.round((m.avgScore * m.buys + grade.score) / buys) };

  return { buyer: p.name, bought: true, chosen: q.name, priceUsdc: q.priceUsdc, score: grade.score, via, reason: decision.reason, gradeReason: grade.reason };
}
