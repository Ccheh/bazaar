import "../src/config.js"; // loads root .env (DEEPSEEK_API_KEY)
import { doWork } from "../src/market/work.js";
import { llmLabel } from "../src/agents/llm.js";

console.log("brain:", llmLabel());
const good = await doWork("tester", "Explain the main trade-offs between optimistic and ZK rollups in 3 concise bullet points.", false);
console.log("GOOD ->", JSON.stringify(good).slice(0, 400));
const lazy = await doWork("lazybot", "Explain the main trade-offs between optimistic and ZK rollups in 3 concise bullet points.", true);
console.log("LAZY ->", JSON.stringify(lazy).slice(0, 400));
