import assert from "node:assert/strict";
import test from "node:test";
import type { Hex } from "viem";
import { fetchReceipt, txsIn } from "./artifacts.js";

const HASH_A = `0x${"a".repeat(64)}` as Hex;
const HASH_B = `0x${"b".repeat(64)}` as Hex;

test("txsIn collects transaction fields and ignores other 32-byte values", () => {
  const result = txsIn({
    marketId: HASH_A,
    salt: HASH_B,
    outcome: { txHash: HASH_A },
    settleTx: HASH_B,
    duplicate: { txHash: HASH_A },
  });
  assert.deepEqual(new Set(result), new Set([HASH_A, HASH_B]));
});

test("fetchReceipt falls back and reports a successful receipt", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url).includes("first")) throw new Error("offline");
    return new Response(
      JSON.stringify({ result: { status: "0x1", blockNumber: "0x2a" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await fetchReceipt(HASH_A, ["https://first", "https://second"], fakeFetch, 100);
  assert.equal(result.state, "success");
  assert.equal(result.blockNumber, 42n);
  assert.equal(result.rpc, "https://second");
  assert.deepEqual(calls, ["https://first", "https://second"]);
});

test("fetchReceipt distinguishes an absent transaction from an RPC outage", async () => {
  const responsive = (async () =>
    new Response(JSON.stringify({ result: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const offline = (async () => {
    throw new Error("offline");
  }) as typeof fetch;

  assert.equal((await fetchReceipt(HASH_A, ["https://rpc"], responsive, 100)).state, "not-found");
  assert.equal((await fetchReceipt(HASH_A, ["https://rpc"], offline, 100)).state, "rpc-unavailable");
});
