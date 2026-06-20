import { formatEther, type Address } from "viem";
import { walletFor, txUrl } from "../config.js";
import { signClaim, encodeClaim, type Claim } from "../rail/escrow.js";
import { askLLM, extractJson } from "./llm.js";

export interface BuyerPersona {
  name: string;
  pk: string;
  budgetUsdc: number;
  task: string;
  style: string;     // e.g. "frugal, cost-sensitive" vs "quality-maximizing"
  qualityBar: number; // 0-100 minimum acceptable grade
}

export interface BuyDecision {
  buy: boolean;
  maxPriceUsdc: number;
  reason: string;
  via: "llm" | "heuristic";
}

export interface BuyTrace {
  agent: Address;
  seller: string;
  priceUsdc: number;
  decision: BuyDecision;
  bought: boolean;
  settleTx?: string;
  settleUrl?: string;
  grade?: { score: number; reason: string; via: "llm" | "heuristic" };
  output?: unknown;
}

function heuristicDecide(p: BuyerPersona, priceUsdc: number): BuyDecision {
  const ceiling = p.style.includes("frugal") ? 0.008 : 0.03;
  const buy = priceUsdc <= ceiling && priceUsdc <= p.budgetUsdc;
  return {
    buy,
    maxPriceUsdc: ceiling,
    reason: buy
      ? `price ${priceUsdc} <= my ceiling ${ceiling} and within budget`
      : `price ${priceUsdc} exceeds my ceiling ${ceiling}`,
    via: "heuristic",
  };
}

function heuristicGrade(output: unknown): { score: number; reason: string; via: "heuristic" } {
  const o = output as { quality?: string; points?: unknown[] };
  const ok = o?.quality === "full" && Array.isArray(o?.points) && o.points.length > 0;
  return {
    score: ok ? 80 : 15,
    reason: ok ? "non-empty structured summary delivered" : "empty / degraded output",
    via: "heuristic",
  };
}

/** One autonomous purchase cycle: discover price -> decide -> pay -> grade. */
export async function buyerCycle(
  p: BuyerPersona,
  sellerUrl: string,
  escrow: Address,
  chainId: number,
): Promise<BuyTrace> {
  const wallet = walletFor(p.pk);
  const agent = wallet.account!.address as Address;

  // 1. Discover the price (HTTP-402 quote).
  const quoteRes = await fetch(`${sellerUrl}/price`);
  const quote = (await quoteRes.json()) as { name: string; service: Address; amountWei: string };
  const priceUsdc = Number(formatEther(BigInt(quote.amountWei)));

  // 2. Decide — real LLM reasoning if a key is present, else a labeled heuristic.
  const system =
    `You are "${p.name}", an autonomous buyer agent in a live nanopayment market on Arc. ` +
    `Your style: ${p.style}. Your task: "${p.task}". Remaining budget: ${p.budgetUsdc} USDC. ` +
    `Decide whether ONE call to service "${quote.name}" priced at ${priceUsdc} USDC is worth buying. ` +
    `Reply with ONLY JSON: {"buy": boolean, "maxPriceUsdc": number, "reason": "<one short sentence>"}.`;
  const raw = await askLLM(system, `Quote: ${priceUsdc} USDC from "${quote.name}". Worth it?`);
  const parsed = extractJson<{ buy: boolean; maxPriceUsdc: number; reason: string }>(raw);
  const decision: BuyDecision = parsed
    ? { ...parsed, via: "llm" }
    : heuristicDecide(p, priceUsdc);

  const trace: BuyTrace = { agent, seller: quote.name, priceUsdc, decision, bought: false };

  if (!decision.buy || priceUsdc > decision.maxPriceUsdc || priceUsdc > p.budgetUsdc) {
    return trace; // walked away — a real autonomous "no-buy".
  }

  // 3. Pay: sign an off-chain claim, send it with the request.
  const claim: Claim = await signClaim(wallet, {
    escrow,
    chainId,
    service: quote.service,
    amount: BigInt(quote.amountWei),
  });
  const workRes = await fetch(`${sellerUrl}/work`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bazaar-claim": encodeClaim(claim) },
    body: JSON.stringify({ input: p.task }),
  });
  const work = (await workRes.json()) as { result?: unknown; queued?: boolean; settleTx?: string; error?: string };
  if (!workRes.ok || !(work.queued || work.settleTx)) {
    trace.decision = { ...decision, reason: `${decision.reason} | seller error: ${work.error ?? workRes.status}` };
    return trace;
  }

  // Payment is authorized + accepted; on-chain settlement is batched by the settler.
  trace.bought = true;
  if (work.settleTx) {
    trace.settleTx = work.settleTx;
    trace.settleUrl = txUrl(work.settleTx);
  }
  trace.output = work.result;

  // 4. Grade the delivery (feeds the agent's memory of this seller next round).
  const gradeSystem =
    `You are "${p.name}". Grade the delivered output 0-100 for your task "${p.task}" ` +
    `(your minimum acceptable quality is ${p.qualityBar}). ` +
    `Reply with ONLY JSON: {"score": number, "reason": "<one short sentence>"}.`;
  const gradeRaw = await askLLM(gradeSystem, `Output: ${JSON.stringify(work.result).slice(0, 600)}`);
  const gradeParsed = extractJson<{ score: number; reason: string }>(gradeRaw);
  trace.grade = gradeParsed ? { ...gradeParsed, via: "llm" } : heuristicGrade(work.result);

  return trace;
}
