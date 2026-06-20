// Bazaar's thin client for the reused Cadence/Arc402 PaymentEscrowV2 rail.
// Native USDC (18 decimals) per-call payment via EIP-712 signed claims.
// Contract (Arc Testnet): 0xc95b1b20f91901206ba3ea94bbc7313e7cd82f8d
import { randomBytes } from "node:crypto";
import {
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

export const ESCROW_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "agent", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isNonceUsed", stateMutability: "view", inputs: [{ name: "agent", type: "address" }, { name: "service", type: "address" }, { name: "nonce", type: "uint256" }], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "claim", stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "claimBatch", stateMutability: "nonpayable",
    inputs: [{
      name: "claims", type: "tuple[]",
      components: [
        { name: "agent", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint256" },
        { name: "signature", type: "bytes" },
      ],
    }],
    outputs: [],
  },
] as const;

export interface Claim {
  agent: Address;
  service: Address;
  amount: bigint;
  nonce: bigint;
  expiry: bigint;
  signature: Hex;
}

const CLAIM_TYPES = {
  Claim: [
    { name: "agent", type: "address" },
    { name: "service", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

function domain(escrow: Address, chainId: number) {
  // Must match PaymentEscrowV2's EIP-712 domain exactly ("Arc402", version "2").
  return { name: "Arc402", version: "2", chainId, verifyingContract: escrow } as const;
}

export function randomNonce(): bigint {
  return BigInt("0x" + randomBytes(32).toString("hex"));
}

/** Buyer (agent) signs an off-chain authorization for `service` to pull `amount`. */
export async function signClaim(
  wallet: WalletClient,
  opts: { escrow: Address; chainId: number; service: Address; amount: bigint; expirySeconds?: number },
): Promise<Claim> {
  const agent = wallet.account!.address;
  const nonce = randomNonce();
  const expiry = BigInt(Math.floor(Date.now() / 1000) + (opts.expirySeconds ?? 3600));
  const message = { agent, service: opts.service, amount: opts.amount, nonce, expiry };
  const signature = await wallet.signTypedData({
    account: wallet.account!,
    domain: domain(opts.escrow, opts.chainId),
    types: CLAIM_TYPES,
    primaryType: "Claim",
    message,
  });
  return { ...message, signature };
}

/** Seller verifies a claim's signer locally before doing work (avoids wasted compute + a reverting settle). */
export async function recoverClaimSigner(claim: Claim, escrow: Address, chainId: number): Promise<Address> {
  return recoverTypedDataAddress({
    domain: domain(escrow, chainId),
    types: CLAIM_TYPES,
    primaryType: "Claim",
    message: {
      agent: claim.agent,
      service: claim.service,
      amount: claim.amount,
      nonce: claim.nonce,
      expiry: claim.expiry,
    },
    signature: claim.signature,
  });
}

/** Seller (service = msg.sender) settles a single claim on-chain; pulls native USDC from the agent's escrow balance. */
export async function settle(
  wallet: WalletClient,
  pub: PublicClient,
  escrow: Address,
  claim: Claim,
): Promise<Hex> {
  const hash = await wallet.writeContract({
    account: wallet.account!,
    chain: wallet.chain,
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "claim",
    args: [claim.agent, claim.amount, claim.nonce, claim.expiry, claim.signature],
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

/** Settle many claims in ONE tx (service = msg.sender). The production batched-settlement path. */
export async function settleBatch(
  wallet: WalletClient,
  pub: PublicClient,
  escrow: Address,
  claims: Claim[],
): Promise<Hex> {
  if (claims.length === 0) throw new Error("no claims to settle");
  const tuples = claims.map((c) => ({
    agent: c.agent,
    amount: c.amount,
    nonce: c.nonce,
    expiry: c.expiry,
    signature: c.signature,
  }));
  const hash = await wallet.writeContract({
    account: wallet.account!,
    chain: wallet.chain,
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "claimBatch",
    args: [tuples],
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function escrowBalance(pub: PublicClient, escrow: Address, agent: Address): Promise<bigint> {
  return (await pub.readContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "balanceOf",
    args: [agent],
  })) as bigint;
}

// ---- HTTP transport for a claim (base64 JSON header) ----
export function encodeClaim(c: Claim): string {
  const wire = {
    agent: c.agent,
    service: c.service,
    amount: c.amount.toString(),
    nonce: c.nonce.toString(),
    expiry: c.expiry.toString(),
    signature: c.signature,
  };
  return Buffer.from(JSON.stringify(wire)).toString("base64");
}

export function decodeClaim(header: string): Claim {
  const w = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  return {
    agent: w.agent,
    service: w.service,
    amount: BigInt(w.amount),
    nonce: BigInt(w.nonce),
    expiry: BigInt(w.expiry),
    signature: w.signature,
  };
}
