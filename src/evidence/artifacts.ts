import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Hex } from "viem";

export interface EvidenceArtifact {
  file: string;
  proves: string;
}

export interface EvidenceGroup extends EvidenceArtifact {
  txs: Hex[];
}

export interface ReceiptResult {
  hash: Hex;
  state: "success" | "reverted" | "not-found" | "rpc-unavailable";
  blockNumber?: bigint;
  rpc?: string;
}

export const ARTIFACTS: EvidenceArtifact[] = [
  {
    file: ".trustless-state.json",
    proves: "trustless slash: bad work slashed, good work protected, outlier validator slashed",
  },
  { file: "circle-pay.json", proves: "Circle DCW sub-cent USDC nanopayment" },
  {
    file: ".circle-trustless-state.json",
    proves: "Circle wallet opens, disputes, and receives a bonded-market refund",
  },
  { file: "byoa-external.json", proves: "independently keyed buyer pays a seller" },
  { file: "beginner-agent.json", proves: "new buyer wallet chooses and pays for a service" },
];

const DEFAULT_RPCS = [
  "https://rpc.drpc.testnet.arc.network",
  "https://rpc.quicknode.testnet.arc.network",
  "https://rpc.testnet.arc.network",
];

export function evidenceRpcUrls(env = process.env): string[] {
  const configured = [env.ARC_TESTNET_RPC, env.ARC_CANTEEN_RPC].filter(
    (url): url is string => Boolean(url),
  );
  return [...new Set([...configured, ...DEFAULT_RPCS])];
}

// Only fields named as transactions are accepted. This avoids treating salts,
// market IDs, and commitment hashes as transaction evidence.
export function txsIn(obj: unknown, out: Set<Hex> = new Set()): Hex[] {
  if (!obj || typeof obj !== "object") return [...out];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (
      typeof value === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(value) &&
      /tx|settle/i.test(key)
    ) {
      out.add(value as Hex);
    } else if (value && typeof value === "object") {
      txsIn(value, out);
    }
  }
  return [...out];
}

export function loadEvidence(repo: string): EvidenceGroup[] {
  return ARTIFACTS.map((artifact) => {
    const path = resolve(repo, artifact.file);
    if (!existsSync(path)) return { ...artifact, txs: [] };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return { ...artifact, txs: txsIn(parsed) };
  });
}

type FetchLike = typeof fetch;

interface RpcReceipt {
  blockNumber?: string;
  status?: string;
}

export async function fetchReceipt(
  hash: Hex,
  rpcUrls = evidenceRpcUrls(),
  fetchFn: FetchLike = fetch,
  timeoutMs = 8_000,
): Promise<ReceiptResult> {
  let responsiveRpc: string | undefined;

  for (const rpc of rpcUrls) {
    try {
      const response = await fetchFn(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [hash],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as { result?: RpcReceipt | null; error?: unknown };
      if (payload.error) continue;
      responsiveRpc = responsiveRpc ?? rpc;
      if (!payload.result) continue;

      return {
        hash,
        state: payload.result.status === "0x1" ? "success" : "reverted",
        blockNumber: payload.result.blockNumber ? BigInt(payload.result.blockNumber) : undefined,
        rpc,
      };
    } catch {
      // Try the next official/public Arc endpoint.
    }
  }

  return {
    hash,
    state: responsiveRpc ? "not-found" : "rpc-unavailable",
    rpc: responsiveRpc,
  };
}
