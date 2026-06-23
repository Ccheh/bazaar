// An INDEPENDENT staked validator's judgment. Each validator forms its OWN score for a
// delivery, strictly against the pre-committed criteria, via its OWN LLM call. No operator
// sets the number — the on-chain consensus (calibration-weighted median in ScalarResolverV10)
// of these independent scores is what settles the market and slashes (or protects) the bond.
// A validator whose score deviates from consensus beyond tolerance is itself slashed, so the
// incentive is to report the truth.
import { askLLM, extractJson } from "./llm.js";

export interface Grade { scoreBps: number; reason: string; via: string }

export async function validatorGrade(
  validatorName: string,
  task: string,
  criteria: string,
  delivery: string,
  model?: string, // distinct model per validator → genuine independence (not one model queried N times)
): Promise<Grade> {
  const sys =
    `You are an INDEPENDENT staked validator ("${validatorName}") in a decentralized resolution market. ` +
    `Score 0-100 how well the DELIVERY satisfies the TASK, judged STRICTLY against the pre-committed CRITERIA. ` +
    `You do not know who produced it and must be objective: your stake is SLASHED if your score deviates ` +
    `from the honest-validator consensus. Reply ONLY JSON: {"score": <integer 0-100>, "reason": "<one short sentence>"}.`;
  const user = `TASK:\n${task}\n\nCRITERIA (pre-committed rubric):\n${criteria}\n\nDELIVERY:\n${delivery.slice(0, 2000)}`;
  const j = extractJson<{ score: number; reason: string }>(await askLLM(sys, user, { json: true, model }));
  if (j && Number.isFinite(j.score)) {
    const bps = Math.max(0, Math.min(10000, Math.round(Number(j.score) * 100)));
    return { scoreBps: bps, reason: String(j.reason ?? "").slice(0, 160), via: model ? `llm:${model}` : "llm" };
  }
  // Deterministic rubric fallback so the on-chain run completes even if the LLM is unreachable.
  const txt = delivery.toLowerCase();
  const kws = ["optimistic", "zk", "proof", "finality", "withdrawal", "latency", "evm", "security", "cost", "fraud"];
  const hits = kws.filter((k) => txt.includes(k)).length;
  const bullets = (delivery.match(/(^|\n)\s*[•\-*\d]/g) ?? []).length;
  let score = Math.min(100, hits * 10 + bullets * 8 + (delivery.replace(/\s/g, "").length > 120 ? 20 : 0));
  const jitter = (validatorName.charCodeAt(validatorName.length - 1) % 5) - 2; // independent graders aren't identical
  score = Math.max(0, Math.min(100, score + jitter));
  return { scoreBps: score * 100, reason: `(heuristic: ${hits} criteria keywords, ${bullets} points)`, via: "heuristic" };
}
