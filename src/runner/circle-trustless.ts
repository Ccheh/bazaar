// Bazaar — Circle wallet wired THROUGH the bonded slash rail (answers "Circle is a parallel proof").
// The Circle Developer-Controlled wallet is the AGENT: it opens AND disputes a CrucibleMarketV7 market
// via Circle's contract-execution API (Circle signs/broadcasts; we never hold the key). Independent
// staked validators (distinct models) then resolve it on-chain. A bad delivery → seller bond slashed,
// and the slashed bond + escrow refund flow back to the CIRCLE wallet — so Circle funds are load-bearing
// in the accountability mechanism, not a side transfer. ~60 min (protocol windows). Resumable via state file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeFunctionData, formatEther, keccak256, parseEther, toBytes, type Address, type Hex } from "viem";
import { account, BUYER_PK, publicClient, SELLER_KEYS, txUrl, walletFor } from "../config.js";
import { validatorGrade } from "../agents/validator.js";
import {
  MARKET_V7, MARKET_V7_ABI, RESOLVER_V10, allowResolverV7, bondAvailableV7, canResolve, chainNow, commitVote,
  computeVoteHash, depositBondV7, hasCommitted, hasRevealedVote, isAlreadyDone, minStake, randomSalt, requiredDisputeBond,
  resolveDisputedV7, resolverMarket, revealVote, signOpenAuthV7, stakeValidator, validatorStake, marketStatus,
  type OpenAuthV7,
} from "../rail/crucible-v7.js";
import { circleEnabled, circleWallets, contractExecution, waitForTx } from "../rail/circle.js";

const here = dirname(fileURLToPath(import.meta.url));
const STATE = resolve(here, "../../.circle-trustless-state.json");
const TASK = "Explain the main trade-offs between optimistic and ZK rollups in 3 concise bullet points.";
const CRITERIA = "High score ONLY if it covers BOTH rollup types with >=3 distinct concrete trade-offs and is accurate; a one-line non-answer scores near 0.";
const DELIVERY = "Rollups are good. Use them."; // a deliberately bad delivery → consensus low → seller bond slashed
const ESCROW = parseEther("0.01");
const BOND_LOCK = parseEther("0.02");
const DISPUTE_BPS = 1000;
const MODELS = (process.env.BAZAAR_VALIDATOR_MODELS ?? "deepseek-v4-pro,deepseek-v4-flash,deepseek-chat").split(",").map((s) => s.trim());

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (w: bigint) => Number(formatEther(w)).toFixed(5);
type St = { marketId?: Hex; nonce?: string; opened?: boolean; openTx?: string; disputed?: boolean; disputeTx?: string; votes: Record<string, { scoreBps: number; salt: Hex; committed: boolean; revealed: boolean }>; outcome?: Record<string, string> };
const loadSt = (): St => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { votes: {} });
const saveSt = (s: St) => writeFileSync(STATE, JSON.stringify(s, null, 2));

function marketIdOf(service: Address, agent: Address, nonce: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [service, agent, nonce]));
}
async function waitWindow(ts: number, label: string) {
  for (;;) { const now = await chainNow(publicClient); if (now > ts) return; log(`${label}: ~${Math.ceil((ts - now) / 60)} min left`); await sleep(Math.min(ts - now + 5, 60) * 1000); }
}

async function main() {
  if (!circleEnabled()) throw new Error("CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET required");
  if (!BUYER_PK) throw new Error("PRIVATE_KEY (MAIN, resolver caller) required");
  const circle = circleWallets()[0];
  const agentAddr = circle.address as Address;
  const service = SELLER_KEYS[0];
  const st = loadSt();

  console.log("=== Bazaar · Circle wallet THROUGH the bonded slash rail ===");
  log(`agent = Circle DCW ${agentAddr}  |  service = seller ${service.address}`);

  // validators (already staked from prior runs; stake if not)
  const vals = MODELS.map((model, i) => {
    const pk = process.env[`BAZAAR_VALIDATOR_${i + 1}_PK`];
    if (!pk) throw new Error(`missing BAZAAR_VALIDATOR_${i + 1}_PK (run npm run trustless once to create validators)`);
    return { name: `V${i + 1}`, pk, address: account(pk).address, model };
  });
  const min = await minStake(publicClient);
  for (const v of vals) if ((await validatorStake(publicClient, v.address)) < min) { log(`${v.name} staking…`); await stakeValidator(walletFor(v.pk), publicClient, min); }

  // service: bond + allow resolver
  const sw = walletFor(service.pk);
  await allowResolverV7(sw, publicClient);
  if ((await bondAvailableV7(publicClient, service.address)) < BOND_LOCK) { log("service depositing bond…"); await depositBondV7(sw, publicClient, BOND_LOCK + parseEther("0.005")); }

  // 1. OPEN the market — Circle wallet is the agent (Circle signs + broadcasts the payable openMarket)
  if (!st.opened) {
    const nonce = BigInt(Date.now());
    const auth: OpenAuthV7 = {
      service: service.address, agent: agentAddr, resolver: RESOLVER_V10, amount: ESCROW, bondLockAmount: BOND_LOCK,
      disputeBondBps: DISPUTE_BPS, commitmentHash: keccak256(toBytes(DELIVERY)), criteriaHash: keccak256(toBytes(CRITERIA)),
      disputeWindow: BigInt(3600), nonce, authExpiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };
    const sig = await signOpenAuthV7(sw, auth);
    const callData = encodeFunctionData({ abi: MARKET_V7_ABI, functionName: "openMarket", args: [auth, sig] });
    log(`Circle wallet opening bonded market (escrow ${fmt(ESCROW)}, via Circle contractExecution)…`);
    const tx = await contractExecution(circle.id, MARKET_V7, callData, formatEther(ESCROW));
    const done = await waitForTx(tx.id, (s) => log(`   open ${s.state}${s.txHash ? ` ${s.txHash}` : ""}`));
    if (!done.txHash) throw new Error(`Circle open did not confirm: ${JSON.stringify(done)}`);
    st.marketId = marketIdOf(service.address, agentAddr, nonce); st.nonce = nonce.toString(); st.opened = true; st.openTx = done.txHash; saveSt(st);
    log(`market ${st.marketId} opened by Circle — ${txUrl(done.txHash)}`);
  }
  const marketId = st.marketId!;

  // 2. DISPUTE — Circle wallet disputes (Circle signs + broadcasts the payable dispute)
  if (!st.disputed) {
    if ((await marketStatus(publicClient, marketId)) >= 2) { st.disputed = true; saveSt(st); }
    else {
      const bond = await requiredDisputeBond(publicClient, marketId);
      const callData = encodeFunctionData({ abi: MARKET_V7_ABI, functionName: "dispute", args: [marketId, 2] });
      log(`Circle wallet disputing (bond ${fmt(bond)}, via Circle)…`);
      const tx = await contractExecution(circle.id, MARKET_V7, callData, formatEther(bond));
      const done = await waitForTx(tx.id, (s) => log(`   dispute ${s.state}${s.txHash ? ` ${s.txHash}` : ""}`));
      if (!done.txHash) throw new Error(`Circle dispute did not confirm: ${JSON.stringify(done)}`);
      st.disputed = true; st.disputeTx = done.txHash; saveSt(st);
      log(`disputed by Circle — ${txUrl(done.txHash)}`);
    }
  }
  const rm = await resolverMarket(publicClient, marketId);
  if (!rm.commitDeadline) throw new Error("voting window did not open");

  // 3. validators independently grade the bad delivery + commit (distinct models)
  const now0 = await chainNow(publicClient);
  if (now0 < rm.commitDeadline) for (const v of vals) {
    if (st.votes[v.address]?.committed || (st.votes[v.address] && await hasCommitted(publicClient, marketId, v.address))) continue;
    const g = await validatorGrade(v.name, TASK, CRITERIA, DELIVERY, v.model);
    const salt = randomSalt();
    st.votes[v.address] = { scoreBps: g.scoreBps, salt, committed: false, revealed: false }; saveSt(st);
    try { const h = await commitVote(walletFor(v.pk), publicClient, marketId, computeVoteHash(g.scoreBps, salt, marketId, v.address)); log(`${v.name} committed ${(g.scoreBps / 100).toFixed(0)}/100 via ${g.via} ${txUrl(h)}`); }
    catch (e) { if (!isAlreadyDone(e)) throw e; }
    st.votes[v.address].committed = true; saveSt(st);
  }

  // 4. reveal after commit window
  await waitWindow(rm.commitDeadline, "commit window");
  for (const v of vals) {
    const vt = st.votes[v.address]; if (!vt || vt.revealed) continue;
    if (await hasRevealedVote(publicClient, marketId, v.address)) { vt.revealed = true; saveSt(st); continue; }
    try { const h = await revealVote(walletFor(v.pk), publicClient, marketId, vt.scoreBps, vt.salt); log(`${v.name} revealed ${(vt.scoreBps / 100).toFixed(0)}/100 ${txUrl(h)}`); }
    catch (e) { if (!isAlreadyDone(e)) throw e; }
    vt.revealed = true; saveSt(st);
  }

  // 5. resolve after reveal window (anyone can call) → bond slashed, refund flows to the Circle agent
  await waitWindow(rm.revealDeadline, "reveal window");
  if ((await marketStatus(publicClient, marketId)) !== 3 && await canResolve(publicClient, marketId)) {
    log("resolving via consensus…");
    const o = await resolveDisputedV7(walletFor(BUYER_PK), publicClient, marketId);
    st.outcome = { scoreBps: String(o.scoreBps), bondSlashed: o.bondSlashed.toString(), paidToAgent: o.paidToAgent.toString(), txHash: o.txHash };
    saveSt(st);
    console.log("\n===================== RESULT =====================");
    console.log(`consensus score: ${(o.scoreBps / 100).toFixed(0)}/100`);
    console.log(`seller bond slashed: ${fmt(o.bondSlashed)} USDC`);
    console.log(`refunded to the CIRCLE wallet (escrow refund + slashed bond): ${fmt(o.paidToAgent)} USDC`);
    console.log(`proof: ${txUrl(o.txHash)}`);
    console.log(`\nThe Circle Developer-Controlled wallet OPENED + DISPUTED a bonded market and received the`);
    console.log(`slash refund — Circle funds flowed through the trustless accountability rail, not a side transfer.`);
  } else log("already resolved or resolver not ready");
}

main().catch((e) => { console.error(e?.shortMessage ?? e?.message ?? e); process.exitCode = 1; });
