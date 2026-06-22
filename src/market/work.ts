// The actual service an AI seller delivers — REAL LLM work (not a canned mock).
// A "good" seller does the task properly; a "lazy" seller deliberately under-delivers.
// Buyers grade the real output; bad output → the seller's bond is slashed on-chain.
import { askLLM } from "../agents/llm.js";

export interface Delivery {
  quality: "full" | "low-effort" | "degraded";
  service: string;
  output?: string;
  // fallback fields when no LLM key is configured (keeps the loop runnable):
  summary?: string;
  points?: string[];
}

export async function doWork(name: string, task: string, lazy: boolean): Promise<Delivery> {
  const system = lazy
    ? `You are a lazy, low-effort service. Reply with ONE short, vague sentence and do NOT actually complete the task.`
    : `You are "${name}", a careful expert service. Complete the user's task accurately and concisely as 3 short bullet points. No preamble.`;
  const out = await askLLM(system, task, { maxTokens: lazy ? 80 : 500 });
  if (out !== null) {
    return { quality: lazy ? "low-effort" : "full", service: name, output: out.trim() };
  }
  // No LLM key available — deterministic stand-ins so the on-chain loop still runs.
  return lazy
    ? { quality: "degraded", service: name, summary: "", points: [] }
    : { quality: "full", service: name, summary: `(${name}) ${task.slice(0, 80)}`, points: ["point A", "point B", "point C"] };
}
