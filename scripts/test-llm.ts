// 测评: confirm the configured LLM (DeepSeek v4-pro) returns parseable JSON for a
// buyer decision + a quality grade, and report latency. No on-chain activity.
import "../src/config.js"; // loads ../.env -> process.env (DEEPSEEK_API_KEY, BAZAAR_MODEL)
import { askLLM, extractJson, llmLabel } from "../src/agents/llm.js";

console.log("brain:", llmLabel());

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const r = await fn();
  console.log(`${label}: ${Date.now() - t0} ms`);
  return r;
}

// 1) buy/no-buy decision
const decideRaw = await timed("decision call", () =>
  askLLM(
    `You are "Frugal", a frugal autonomous buyer agent on Arc. Budget 0.5 USDC. ` +
      `Decide if ONE call to "summarizer-A" at 0.005 USDC is worth it. ` +
      `Reply ONLY JSON: {"buy": boolean, "maxPriceUsdc": number, "reason": "<one sentence>"}.`,
    `Quote: 0.005 USDC from "summarizer-A". Worth it?`,
  ),
);
console.log("decision raw:", decideRaw);
console.log("decision parsed:", extractJson(decideRaw));

// 2) quality grade
const gradeRaw = await timed("grade call", () =>
  askLLM(
    `You are "Frugal". Grade a delivered summary 0-100 for the task "summarize Arc in 3 bullets" ` +
      `(min acceptable 60). Reply ONLY JSON: {"score": number, "reason": "<one sentence>"}.`,
    `Output: {"quality":"full","points":["Arc is Circle's USDC-native L1","sub-second finality","pay per call"]}`,
  ),
);
console.log("grade raw:", gradeRaw);
console.log("grade parsed:", extractJson(gradeRaw));
