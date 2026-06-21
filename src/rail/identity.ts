// Bazaar's client for the canonical ERC-8004 registries on Arc Testnet (Circle's agent-identity
// standard). Sellers REGISTER on-chain with their service endpoint as the agentURI; buyers
// DISCOVER sellers from the Registered event logs — permissionless, no central market.
//   IdentityRegistry  0x8004A818BFB912233c491871b3d84c89A494BD9e (ERC-1967 proxy -> canonical impl)
//   ReputationRegistry 0x8004B663056A597Dffe9eCcC1965A193B7388713
import { type Address, type Hex, type PublicClient, type WalletClient, parseAbiItem, parseEventLogs } from "viem";

export const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;
export const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address;

export const IDENTITY_ABI = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setAgentURI", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "newURI", type: "string" }], outputs: [] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ type: "string" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ type: "address" }] },
  {
    type: "event", name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

export const REPUTATION_ABI = [
  {
    type: "function", name: "giveFeedback", stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const REGISTERED_EVENT = parseAbiItem("event Registered(uint256 indexed agentId, string agentURI, address indexed owner)");

/** Register the caller as an ERC-8004 agent, advertising `agentURI` (its service endpoint). */
export async function registerAgent(wallet: WalletClient, pub: PublicClient, agentURI: string): Promise<{ agentId: bigint; txHash: Hex }> {
  const hash = await wallet.writeContract({
    account: wallet.account!,
    chain: wallet.chain,
    address: IDENTITY_REGISTRY,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: [agentURI],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const evs = parseEventLogs({ abi: IDENTITY_ABI, logs: receipt.logs, eventName: "Registered" });
  const ev = evs[0];
  if (!ev) throw new Error("Registered event not found (register() may have a different signature)");
  return { agentId: (ev.args as { agentId: bigint }).agentId, txHash: hash };
}

export async function setAgentURI(wallet: WalletClient, pub: PublicClient, agentId: bigint, uri: string): Promise<Hex> {
  const hash = await wallet.writeContract({
    account: wallet.account!, chain: wallet.chain, address: IDENTITY_REGISTRY, abi: IDENTITY_ABI,
    functionName: "setAgentURI", args: [agentId, uri],
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function readAgentURI(pub: PublicClient, agentId: bigint): Promise<string> {
  return (await pub.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "tokenURI", args: [agentId] })) as string;
}

export interface DiscoveredAgent { agentId: bigint; uri: string; owner: Address }

/**
 * Discover agents from on-chain Registered events over the recent `lookbackBlocks`
 * (the RPC caps eth_getLogs at 10k blocks, so we page). Returns freshest URI per agentId.
 */
export async function discoverAgents(pub: PublicClient, lookbackBlocks = 30000n): Promise<DiscoveredAgent[]> {
  const latest = await pub.getBlockNumber();
  const from = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;
  const CHUNK = 9000n;
  const byId = new Map<string, DiscoveredAgent>();
  for (let start = from; start <= latest; start += CHUNK + 1n) {
    const end = start + CHUNK > latest ? latest : start + CHUNK;
    const logs = await pub.getLogs({ address: IDENTITY_REGISTRY, event: REGISTERED_EVENT, fromBlock: start, toBlock: end });
    for (const l of logs) {
      const a = l.args;
      if (a.agentId === undefined || a.owner === undefined) continue;
      byId.set(a.agentId.toString(), { agentId: a.agentId, uri: a.agentURI ?? "", owner: a.owner });
    }
  }
  return [...byId.values()];
}

/** Write the buyer's grade as on-chain ERC-8004 reputation for a seller agent (optional tie-in). */
export async function postFeedback(wallet: WalletClient, pub: PublicClient, agentId: bigint, score0to100: number, endpoint: string): Promise<Hex> {
  const hash = await wallet.writeContract({
    account: wallet.account!, chain: wallet.chain, address: REPUTATION_REGISTRY, abi: REPUTATION_ABI,
    functionName: "giveFeedback",
    args: [agentId, BigInt(Math.round(score0to100)), 0, "quality", "", endpoint, "", "0x0000000000000000000000000000000000000000000000000000000000000000"],
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
