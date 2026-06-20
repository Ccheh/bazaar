// Bazaar's client for the reused Crucible v0 market (USDC-bond, slash-on-underdelivery).
// Market:  0x61996d505d6510a339f39c9923519b2f5350f61c  (EIP-712 "Crucible" v1)
// Resolver: MockResolver 0x76696e3c541eb32c81cfc1cbfb3e5e5ef1c4d35f (score from calldata, canResolve=true)
//
// This is the EXCEPTION path: optimistic per-call payment happens on the Cadence rail; when a
// buyer judges a delivery as under-par, it disputes here and the seller's USDC bond is slashed.
// (The fast mock resolver gives a real on-chain slash for the demo; the decentralised
// ScalarResolverV10 commit-reveal path is the production resolver — same market interface.)
import {
  encodeAbiParameters,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { CHAIN_ID } from "../config.js";

export const CRUCIBLE_MARKET = "0x61996d505d6510a339f39c9923519b2f5350f61c" as Address;
export const MOCK_RESOLVER = "0x76696e3c541eb32c81cfc1cbfb3e5e5ef1c4d35f" as Address;

export const CRUCIBLE_ABI = [
  { type: "function", name: "depositBond", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "setResolverAllowed", stateMutability: "nonpayable", inputs: [{ name: "resolver", type: "address" }, { name: "allowed", type: "bool" }], outputs: [] },
  { type: "function", name: "bondAvailable", stateMutability: "view", inputs: [{ name: "service", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "dispute", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "resolveDisputed", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }, { name: "resolverData", type: "bytes" }], outputs: [] },
  {
    type: "function", name: "openMarket", stateMutability: "payable",
    inputs: [
      {
        name: "auth", type: "tuple",
        components: [
          { name: "service", type: "address" },
          { name: "agent", type: "address" },
          { name: "resolver", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "bondLockAmount", type: "uint256" },
          { name: "commitmentHash", type: "bytes32" },
          { name: "disputeWindow", type: "uint64" },
          { name: "nonce", type: "uint256" },
          { name: "authExpiry", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "event", name: "MarketOpened",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "service", type: "address", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "resolver", type: "address", indexed: false },
      { name: "agentEscrow", type: "uint256", indexed: false },
      { name: "bondLocked", type: "uint256", indexed: false },
      { name: "commitmentHash", type: "bytes32", indexed: false },
      { name: "disputeDeadline", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event", name: "MarketResolved",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "scoreBps", type: "uint16", indexed: false },
      { name: "paidToService", type: "uint256", indexed: false },
      { name: "paidToAgent", type: "uint256", indexed: false },
      { name: "bondSlashed", type: "uint256", indexed: false },
    ],
  },
] as const;

export interface OpenAuth {
  service: Address;
  agent: Address;
  resolver: Address;
  amount: bigint;
  bondLockAmount: bigint;
  commitmentHash: Hex;
  disputeWindow: bigint;
  nonce: bigint;
  authExpiry: bigint;
}

const OPEN_AUTH_TYPES = {
  OpenAuth: [
    { name: "service", type: "address" },
    { name: "agent", type: "address" },
    { name: "resolver", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "bondLockAmount", type: "uint256" },
    { name: "commitmentHash", type: "bytes32" },
    { name: "disputeWindow", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "authExpiry", type: "uint256" },
  ],
} as const;

function domain() {
  return { name: "Crucible", version: "1", chainId: CHAIN_ID, verifyingContract: CRUCIBLE_MARKET } as const;
}

async function send(wallet: WalletClient, pub: PublicClient, functionName: string, args: unknown[], value?: bigint) {
  const params = {
    account: wallet.account!,
    chain: wallet.chain,
    address: CRUCIBLE_MARKET,
    abi: CRUCIBLE_ABI,
    functionName,
    args,
    ...(value !== undefined ? { value } : {}),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- glue: viem's write overloads are over-strict here
  const hash = await wallet.writeContract(params as any);
  return pub.waitForTransactionReceipt({ hash });
}

/** Service posts a USDC bond into its pool. */
export async function depositBond(service: WalletClient, pub: PublicClient, amount: bigint): Promise<Hex> {
  return (await send(service, pub, "depositBond", [], amount)).transactionHash;
}

/** Service whitelists a resolver it will accept (required before openMarket). */
export async function allowResolver(service: WalletClient, pub: PublicClient, resolver: Address): Promise<Hex> {
  return (await send(service, pub, "setResolverAllowed", [resolver, true])).transactionHash;
}

export async function bondAvailable(pub: PublicClient, service: Address): Promise<bigint> {
  return (await pub.readContract({ address: CRUCIBLE_MARKET, abi: CRUCIBLE_ABI, functionName: "bondAvailable", args: [service] })) as bigint;
}

/** Service signs the EIP-712 OpenAuth authorizing a market against its bond. */
export async function signOpenAuth(service: WalletClient, auth: OpenAuth): Promise<Hex> {
  return service.signTypedData({
    account: service.account!,
    domain: domain(),
    types: OPEN_AUTH_TYPES,
    primaryType: "OpenAuth",
    message: auth,
  });
}

/** Agent opens the market (pays escrow as msg.value); returns the marketId from the event. */
export async function openMarket(agent: WalletClient, pub: PublicClient, auth: OpenAuth, signature: Hex): Promise<Hex> {
  const receipt = await send(agent, pub, "openMarket", [auth, signature], auth.amount);
  const opened = parseEventLogs({ abi: CRUCIBLE_ABI, logs: receipt.logs, eventName: "MarketOpened" });
  const ev = opened[0];
  if (!ev) throw new Error("MarketOpened event not found");
  return (ev.args as { marketId: Hex }).marketId;
}

/** Agent disputes the delivery (within the window). */
export async function dispute(agent: WalletClient, pub: PublicClient, marketId: Hex): Promise<Hex> {
  return (await send(agent, pub, "dispute", [marketId])).transactionHash;
}

export interface SlashOutcome {
  txHash: Hex;
  scoreBps: number;
  paidToService: bigint;
  paidToAgent: bigint;
  bondSlashed: bigint;
}

/** Resolve a disputed market with a score (mock resolver reads it from calldata) → settles + slashes. */
export async function resolveDisputed(caller: WalletClient, pub: PublicClient, marketId: Hex, scoreBps: number): Promise<SlashOutcome> {
  const resolverData = encodeAbiParameters([{ type: "uint256" }], [BigInt(scoreBps)]);
  const receipt = await send(caller, pub, "resolveDisputed", [marketId, resolverData]);
  const resolved = parseEventLogs({ abi: CRUCIBLE_ABI, logs: receipt.logs, eventName: "MarketResolved" });
  const ev = resolved[0];
  if (!ev) throw new Error("MarketResolved event not found");
  const a = ev.args as { scoreBps: number; paidToService: bigint; paidToAgent: bigint; bondSlashed: bigint };
  return {
    txHash: receipt.transactionHash,
    scoreBps: Number(a.scoreBps),
    paidToService: a.paidToService,
    paidToAgent: a.paidToAgent,
    bondSlashed: a.bondSlashed,
  };
}
