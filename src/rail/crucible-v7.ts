// Bazaar — TRUSTLESS slash stack: CrucibleMarketV7 + ScalarResolverV10 (staked validators,
// commit-reveal, calibration-weighted-median consensus, outlier slashing). The score that slashes
// a seller's bond comes from INDEPENDENT staked validators — not from the operator.
//   CrucibleMarketV7   0x9934bAF33bcF0dfD14040f8ddd5DdF18eCfEFb59  (EIP-712 "Crucible" v"7")
//   ScalarResolverV10  0xb377b32a65166bcA3d9b14B8C5c1B636817F4c01  (MIN_STAKE 0.1, 30m commit + 30m reveal)
import { randomBytes } from "node:crypto";
import {
  encodeAbiParameters, getAddress, keccak256, parseEventLogs, toHex,
  type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { CHAIN_ID } from "../config.js";

// getAddress normalizes to EIP-55 checksum so a mistyped case can never trip viem's validation.
export const MARKET_V7 = getAddress("0x9934bAF33bcF0dfD14040f8ddd5DdF18eCfEFb59");
export const RESOLVER_V10 = getAddress("0xb377B32A65166bcA3d9b14b8C5C1b636817F4c01");
export const COMMIT_WINDOW_S = 30 * 60;
export const REVEAL_WINDOW_S = 30 * 60;

export const MARKET_V7_ABI = [
  { type: "function", name: "depositBond", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "setResolverAllowed", stateMutability: "nonpayable", inputs: [{ name: "resolver", type: "address" }, { name: "allowed", type: "bool" }], outputs: [] },
  { type: "function", name: "bondAvailable", stateMutability: "view", inputs: [{ name: "service", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "dispute", stateMutability: "payable", inputs: [{ name: "marketId", type: "bytes32" }, { name: "kind", type: "uint8" }], outputs: [] },
  { type: "function", name: "resolveDisputed", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }, { name: "resolverData", type: "bytes" }], outputs: [] },
  {
    type: "function", name: "openMarket", stateMutability: "payable",
    inputs: [
      {
        name: "auth", type: "tuple",
        components: [
          { name: "service", type: "address" }, { name: "agent", type: "address" }, { name: "resolver", type: "address" },
          { name: "amount", type: "uint256" }, { name: "bondLockAmount", type: "uint256" }, { name: "disputeBondBps", type: "uint16" },
          { name: "commitmentHash", type: "bytes32" }, { name: "criteriaHash", type: "bytes32" }, { name: "disputeWindow", type: "uint64" },
          { name: "nonce", type: "uint256" }, { name: "authExpiry", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  { type: "function", name: "requiredDisputeBond", stateMutability: "view", inputs: [{ name: "marketId", type: "bytes32" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "markets", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "service", type: "address" }, { name: "agent", type: "address" }, { name: "resolver", type: "address" },
      { name: "agentEscrow", type: "uint256" }, { name: "bondLocked", type: "uint256" }, { name: "disputeBond", type: "uint256" },
      { name: "disputeBondBps", type: "uint16" }, { name: "commitmentHash", type: "bytes32" }, { name: "criteriaHash", type: "bytes32" },
      { name: "disputeDeadline", type: "uint64" }, { name: "disputedAt", type: "uint64" }, { name: "scoreBps", type: "uint16" },
      { name: "status", type: "uint8" }, { name: "disputeKind", type: "uint8" }, { name: "decouplingActive", type: "bool" },
    ],
  },
  // Events carry ALL fields (indexed + not) so parseEventLogs computes the correct topic0 and decodes args.
  { type: "event", name: "MarketOpened", inputs: [
    { name: "marketId", type: "bytes32", indexed: true }, { name: "service", type: "address", indexed: true }, { name: "agent", type: "address", indexed: true },
    { name: "resolver", type: "address", indexed: false }, { name: "agentEscrow", type: "uint256", indexed: false }, { name: "bondLocked", type: "uint256", indexed: false },
    { name: "disputeBondBps", type: "uint16", indexed: false }, { name: "commitmentHash", type: "bytes32", indexed: false }, { name: "criteriaHash", type: "bytes32", indexed: false },
    { name: "disputeDeadline", type: "uint64", indexed: false } ] },
  { type: "event", name: "MarketResolved", inputs: [
    { name: "marketId", type: "bytes32", indexed: true }, { name: "scoreBps", type: "uint16", indexed: false }, { name: "paidToService", type: "uint256", indexed: false },
    { name: "paidToAgent", type: "uint256", indexed: false }, { name: "bondSlashed", type: "uint256", indexed: false }, { name: "resolverFee", type: "uint256", indexed: false },
    { name: "disputeBondToService", type: "uint256", indexed: false }, { name: "validatorSubscription", type: "uint256", indexed: false } ] },
] as const;

export const RESOLVER_V10_ABI = [
  { type: "function", name: "stake", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "commitVote", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }, { name: "voteHash", type: "bytes32" }], outputs: [] },
  { type: "function", name: "revealVote", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }, { name: "scoreBps", type: "uint16" }, { name: "salt", type: "bytes32" }], outputs: [] },
  { type: "function", name: "canResolve", stateMutability: "view", inputs: [{ name: "marketId", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "validatorStake", stateMutability: "view", inputs: [{ name: "v", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "calibration", stateMutability: "view", inputs: [{ name: "v", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "voteCommit", stateMutability: "view", inputs: [{ name: "marketId", type: "bytes32" }, { name: "voter", type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "hasRevealed", stateMutability: "view", inputs: [{ name: "marketId", type: "bytes32" }, { name: "voter", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "MIN_STAKE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "getMarket", stateMutability: "view", inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      { name: "commitDeadline", type: "uint64" }, { name: "revealDeadline", type: "uint64" }, { name: "finalScoreBps", type: "uint16" },
      { name: "resolved", type: "bool" }, { name: "voterCount", type: "uint256" }, { name: "feePool", type: "uint256" },
    ],
  },
  { type: "function", name: "getVoters", stateMutability: "view", inputs: [{ name: "marketId", type: "bytes32" }], outputs: [{ type: "address[]" }] },
  { type: "event", name: "ValidatorSlashed", inputs: [{ name: "marketId", type: "bytes32", indexed: true }, { name: "validator", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }, { name: "distance", type: "uint256", indexed: false }] },
] as const;

export interface ResolverMarket { commitDeadline: number; revealDeadline: number; finalScoreBps: number; resolved: boolean; voterCount: number; feePool: bigint }

export interface OpenAuthV7 {
  service: Address; agent: Address; resolver: Address;
  amount: bigint; bondLockAmount: bigint; disputeBondBps: number;
  commitmentHash: Hex; criteriaHash: Hex; disputeWindow: bigint; nonce: bigint; authExpiry: bigint;
}

const OPEN_AUTH_TYPES = {
  OpenAuth: [
    { name: "service", type: "address" }, { name: "agent", type: "address" }, { name: "resolver", type: "address" },
    { name: "amount", type: "uint256" }, { name: "bondLockAmount", type: "uint256" }, { name: "disputeBondBps", type: "uint16" },
    { name: "commitmentHash", type: "bytes32" }, { name: "criteriaHash", type: "bytes32" }, { name: "disputeWindow", type: "uint64" },
    { name: "nonce", type: "uint256" }, { name: "authExpiry", type: "uint256" },
  ],
} as const;

function domainV7() {
  return { name: "Crucible", version: "7", chainId: CHAIN_ID, verifyingContract: MARKET_V7 } as const;
}

function send(wallet: WalletClient, address: Address, abi: unknown, fn: string, args: unknown[], value?: bigint) {
  const params = { account: wallet.account!, chain: wallet.chain, address, abi, functionName: fn, args, ...(value !== undefined ? { value } : {}) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return wallet.writeContract(params as any) as Promise<Hex>;
}

export function randomSalt(): Hex { return toHex(randomBytes(32)); }

export function computeVoteHash(scoreBps: number, salt: Hex, marketId: Hex, voter: Address): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint16" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
    [scoreBps, salt, marketId, voter],
  ));
}

// ---- market (V7) ----
export async function depositBondV7(service: WalletClient, pub: PublicClient, amount: bigint): Promise<Hex> {
  const h = await send(service, MARKET_V7, MARKET_V7_ABI, "depositBond", [], amount);
  await pub.waitForTransactionReceipt({ hash: h }); return h;
}
export async function allowResolverV7(service: WalletClient, pub: PublicClient): Promise<Hex> {
  const h = await send(service, MARKET_V7, MARKET_V7_ABI, "setResolverAllowed", [RESOLVER_V10, true]);
  await pub.waitForTransactionReceipt({ hash: h }); return h;
}
export async function signOpenAuthV7(service: WalletClient, auth: OpenAuthV7): Promise<Hex> {
  return service.signTypedData({ account: service.account!, domain: domainV7(), types: OPEN_AUTH_TYPES, primaryType: "OpenAuth", message: auth });
}
export async function openMarketV7(agent: WalletClient, pub: PublicClient, auth: OpenAuthV7, sig: Hex): Promise<Hex> {
  const h = await send(agent, MARKET_V7, MARKET_V7_ABI, "openMarket", [auth, sig], auth.amount);
  const r = await pub.waitForTransactionReceipt({ hash: h });
  const ev = parseEventLogs({ abi: MARKET_V7_ABI, logs: r.logs, eventName: "MarketOpened" })[0];
  if (!ev) throw new Error("MarketOpened not found");
  return (ev.args as { marketId: Hex }).marketId;
}
export async function disputeV7(agent: WalletClient, pub: PublicClient, marketId: Hex, disputeBond: bigint, kind = 2): Promise<Hex> {
  const h = await send(agent, MARKET_V7, MARKET_V7_ABI, "dispute", [marketId, kind], disputeBond);
  await pub.waitForTransactionReceipt({ hash: h }); return h;
}
export interface SlashedValidator { validator: Address; amount: bigint; distance: bigint }
export interface ResolveOutcome {
  txHash: Hex; scoreBps: number; paidToService: bigint; paidToAgent: bigint;
  bondSlashed: bigint; resolverFee: bigint; disputeBondToService: bigint; validatorSubscription: bigint;
  slashedValidators: SlashedValidator[];
}
export async function resolveDisputedV7(caller: WalletClient, pub: PublicClient, marketId: Hex): Promise<ResolveOutcome> {
  const h = await send(caller, MARKET_V7, MARKET_V7_ABI, "resolveDisputed", [marketId, "0x"]);
  const r = await pub.waitForTransactionReceipt({ hash: h });
  const ev = parseEventLogs({ abi: MARKET_V7_ABI, logs: r.logs, eventName: "MarketResolved" })[0];
  if (!ev) throw new Error("MarketResolved not found");
  const a = ev.args as { scoreBps: number; paidToService: bigint; paidToAgent: bigint; bondSlashed: bigint; resolverFee: bigint; disputeBondToService: bigint; validatorSubscription: bigint };
  // The resolve tx also triggers the resolver's ValidatorSlashed events (outlier validators) — same receipt.
  const slashes = parseEventLogs({ abi: RESOLVER_V10_ABI, logs: r.logs, eventName: "ValidatorSlashed" });
  const slashedValidators = slashes.map((s) => {
    const sa = s.args as { validator: Address; amount: bigint; distance: bigint };
    return { validator: sa.validator, amount: sa.amount, distance: sa.distance };
  });
  return {
    txHash: h, scoreBps: Number(a.scoreBps), paidToService: a.paidToService, paidToAgent: a.paidToAgent,
    bondSlashed: a.bondSlashed, resolverFee: a.resolverFee, disputeBondToService: a.disputeBondToService,
    validatorSubscription: a.validatorSubscription, slashedValidators,
  };
}

// ---- resolver / validators (V10) ----
export async function minStake(pub: PublicClient): Promise<bigint> {
  return (await pub.readContract({ address: RESOLVER_V10, abi: RESOLVER_V10_ABI, functionName: "MIN_STAKE" })) as bigint;
}
export async function validatorStake(pub: PublicClient, v: Address): Promise<bigint> {
  return (await pub.readContract({ address: RESOLVER_V10, abi: RESOLVER_V10_ABI, functionName: "validatorStake", args: [v] })) as bigint;
}
export async function stakeValidator(v: WalletClient, pub: PublicClient, amount: bigint): Promise<Hex> {
  const h = await send(v, RESOLVER_V10, RESOLVER_V10_ABI, "stake", [], amount);
  await pub.waitForTransactionReceipt({ hash: h }); return h;
}
export async function commitVote(v: WalletClient, pub: PublicClient, marketId: Hex, voteHash: Hex): Promise<Hex> {
  const h = await send(v, RESOLVER_V10, RESOLVER_V10_ABI, "commitVote", [marketId, voteHash]);
  await pub.waitForTransactionReceipt({ hash: h }); return h;
}
export async function revealVote(v: WalletClient, pub: PublicClient, marketId: Hex, scoreBps: number, salt: Hex): Promise<Hex> {
  const h = await send(v, RESOLVER_V10, RESOLVER_V10_ABI, "revealVote", [marketId, scoreBps, salt]);
  await pub.waitForTransactionReceipt({ hash: h }); return h;
}
export async function canResolve(pub: PublicClient, marketId: Hex): Promise<boolean> {
  return (await pub.readContract({ address: RESOLVER_V10, abi: RESOLVER_V10_ABI, functionName: "canResolve", args: [marketId] })) as boolean;
}
/** True if `voter` already has a commit recorded for this market (on-chain source of truth for resume). */
export async function hasCommitted(pub: PublicClient, marketId: Hex, voter: Address): Promise<boolean> {
  const c = (await pub.readContract({ address: RESOLVER_V10, abi: RESOLVER_V10_ABI, functionName: "voteCommit", args: [marketId, voter] })) as Hex;
  return c !== "0x0000000000000000000000000000000000000000000000000000000000000000";
}
/** True if `voter` already revealed for this market (on-chain source of truth for resume). */
export async function hasRevealedVote(pub: PublicClient, marketId: Hex, voter: Address): Promise<boolean> {
  return (await pub.readContract({ address: RESOLVER_V10, abi: RESOLVER_V10_ABI, functionName: "hasRevealed", args: [marketId, voter] })) as boolean;
}
/** True if a revert was an idempotent "already done" (safe to treat as success on resume). */
export function isAlreadyDone(err: unknown): boolean {
  const s = String((err as { shortMessage?: string; message?: string })?.shortMessage ?? (err as Error)?.message ?? err);
  return /AlreadyCommitted|AlreadyRevealed|AlreadyResolved/.test(s);
}
export async function resolverMarket(pub: PublicClient, marketId: Hex): Promise<ResolverMarket> {
  const r = (await pub.readContract({ address: RESOLVER_V10, abi: RESOLVER_V10_ABI, functionName: "getMarket", args: [marketId] })) as readonly [bigint, bigint, number, boolean, bigint, bigint];
  return { commitDeadline: Number(r[0]), revealDeadline: Number(r[1]), finalScoreBps: r[2], resolved: r[3], voterCount: Number(r[4]), feePool: r[5] };
}
export async function requiredDisputeBond(pub: PublicClient, marketId: Hex): Promise<bigint> {
  return (await pub.readContract({ address: MARKET_V7, abi: MARKET_V7_ABI, functionName: "requiredDisputeBond", args: [marketId] })) as bigint;
}
/** Market status: 0 None, 1 Open, 2 Disputed, 3 Resolved. */
export async function marketStatus(pub: PublicClient, marketId: Hex): Promise<number> {
  const m = (await pub.readContract({ address: MARKET_V7, abi: MARKET_V7_ABI, functionName: "markets", args: [marketId] })) as readonly unknown[];
  return Number(m[12]);
}
export async function bondAvailableV7(pub: PublicClient, service: Address): Promise<bigint> {
  return (await pub.readContract({ address: MARKET_V7, abi: MARKET_V7_ABI, functionName: "bondAvailable", args: [service] })) as bigint;
}
export async function chainNow(pub: PublicClient): Promise<number> {
  const b = await pub.getBlock();
  return Number(b.timestamp);
}
