#!/usr/bin/env node
import process from 'node:process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PublicKey } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddress,
} from '@solana/spl-token';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { createUnsignedEnvelope, attachSignature, signUnsignedEnvelopeHex } from '../src/protocol/signedMessage.js';
import { KIND, ASSET, PAIR, STATE } from '../src/swap/constants.js';
import { PAIR as PRICE_PAIR } from '../src/price/providers.js';
import { validateSwapEnvelope } from '../src/swap/schema.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { createInitialTrade, applySwapEnvelope } from '../src/swap/stateMachine.js';
import { verifySwapPrePayOnchain } from '../src/swap/verify.js';
import { normalizeClnNetwork } from '../src/ln/cln.js';
import { normalizeLndNetwork } from '../src/ln/lnd.js';
import { lnPay } from '../src/ln/client.js';
import { claimEscrowTx, LN_USDT_ESCROW_PROGRAM_ID } from '../src/solana/lnUsdtEscrowClient.js';
import { readSolanaKeypair } from '../src/solana/keypair.js';
import { SolanaRpcPool } from '../src/solana/rpcPool.js';
import { openTradeReceiptsStore } from '../src/receipts/store.js';
import { loadPeerWalletFromFile } from '../src/peer/keypair.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const defaultComposeFile = path.join(repoRoot, 'dev/ln-regtest/docker-compose.yml');

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags.set(key, true);
      else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function requireFlag(flags, name) {
  const v = flags.get(name);
  if (!v || v === true) die(`Missing --${name}`);
  return String(v);
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value === true) return true;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function parseIntFlag(value, label, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) die(`Invalid ${label}`);
  return n;
}

function parseBps(value, label, fallback) {
  const n = parseIntFlag(value, label, fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10_000, n));
}

function stripSignature(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const { sig: _sig, signer: _signer, ...unsigned } = envelope;
  return unsigned;
}

function ensureOk(res, label) {
  if (!res || typeof res !== 'object') throw new Error(`${label} failed (no response)`);
  if (res.type === 'error') throw new Error(`${label} failed: ${res.error}`);
  return res;
}

function signSwapEnvelope(unsignedEnvelope, { pubHex, secHex }) {
  const sigHex = signUnsignedEnvelopeHex(unsignedEnvelope, secHex);
  const signed = attachSignature(unsignedEnvelope, { signerPubKeyHex: pubHex, sigHex });
  const v = validateSwapEnvelope(signed);
  if (!v.ok) throw new Error(`Internal error: signed envelope invalid: ${v.error}`);
  return signed;
}

function asBigIntAmount(value) {
  try {
    const s = String(value ?? '').trim();
    if (!s) return null;
    return BigInt(s);
  } catch (_e) {
    return null;
  }
}

function impliedPriceUsdtPerBtc({ btcSats, usdtAmount, usdtDecimals }) {
  try {
    const sats = BigInt(String(btcSats));
    const amt = BigInt(String(usdtAmount));
    const denom = sats * (10n ** BigInt(String(usdtDecimals)));
    if (sats <= 0n || denom <= 0n) return null;
    // Return a micro-precision float: (amt * 1e8 / (sats * 10^dec)) rounded down to 1e-6.
    const priceMicro = (amt * 100000000n * 1000000n) / denom;
    return Number(priceMicro) / 1_000_000;
  } catch (_e) {
    return null;
  }
}

async function sendAndConfirm(connection, tx) {
  const sig = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction(sig, 'confirmed');
  if (conf?.value?.err) {
    throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
  }
  return sig;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  const url = requireFlag(flags, 'url');
  const token = requireFlag(flags, 'token');
  const peerKeypairPath = requireFlag(flags, 'peer-keypair');
  const rfqChannel = (flags.get('rfq-channel') && String(flags.get('rfq-channel')).trim()) || '0000intercomswapbtcusdt';
  const receiptsDbPath = flags.get('receipts-db') ? String(flags.get('receipts-db')).trim() : '';
  const persistPreimage = parseBool(flags.get('persist-preimage'), receiptsDbPath ? true : false);
  const stopAfterLnPay = parseBool(flags.get('stop-after-ln-pay'), false);

  const tradeId = (flags.get('trade-id') && String(flags.get('trade-id')).trim()) || `swap_${crypto.randomUUID()}`;

  const btcSats = parseIntFlag(flags.get('btc-sats'), 'btc-sats', 50_000);
  const usdtAmount = (flags.get('usdt-amount') && String(flags.get('usdt-amount')).trim()) || '100000000';
  const rfqValidSec = parseIntFlag(flags.get('rfq-valid-sec'), 'rfq-valid-sec', 60);

  const timeoutSec = parseIntFlag(flags.get('timeout-sec'), 'timeout-sec', 30);
  const rfqResendMs = parseIntFlag(flags.get('rfq-resend-ms'), 'rfq-resend-ms', 1200);
  const acceptResendMs = parseIntFlag(flags.get('accept-resend-ms'), 'accept-resend-ms', 1200);

  const onceExitDelayMs = parseIntFlag(flags.get('once-exit-delay-ms'), 'once-exit-delay-ms', 200);
  const once = parseBool(flags.get('once'), false);
  const debug = parseBool(flags.get('debug'), false);

  const priceGuard = parseBool(flags.get('price-guard'), true);
  const priceMaxAgeMs = parseIntFlag(flags.get('price-max-age-ms'), 'price-max-age-ms', 15_000);
  const takerMaxDiscountBps = parseBps(flags.get('taker-max-discount-bps'), 'taker-max-discount-bps', 200);

  const runSwap = parseBool(flags.get('run-swap'), false);
  const swapTimeoutSec = parseIntFlag(flags.get('swap-timeout-sec'), 'swap-timeout-sec', 300);
  const swapResendMs = parseIntFlag(flags.get('swap-resend-ms'), 'swap-resend-ms', 1200);
  // Guardrail: require the Solana refund timelock in TERMS to be far enough in the future
  // to allow recovery (crash/restart/RPC outage) after paying the LN invoice.
  const minSolRefundWindowSec = parseIntFlag(
    flags.get('min-solana-refund-window-sec'),
    'min-solana-refund-window-sec',
    3600
  );
  const maxSolRefundWindowSec = parseIntFlag(
    flags.get('max-solana-refund-window-sec'),
    'max-solana-refund-window-sec',
    7 * 24 * 3600
  );
  const maxPlatformFeeBps = parseBps(flags.get('max-platform-fee-bps'), 'max-platform-fee-bps', 500);
  const maxTradeFeeBps = parseBps(flags.get('max-trade-fee-bps'), 'max-trade-fee-bps', 1000);
  const maxTotalFeeBps = parseBps(flags.get('max-total-fee-bps'), 'max-total-fee-bps', 1500);

  const solRpcUrl = (flags.get('solana-rpc-url') && String(flags.get('solana-rpc-url')).trim()) || 'http://127.0.0.1:8899';
  const solKeypairPath = flags.get('solana-keypair') ? String(flags.get('solana-keypair')).trim() : '';
  const solMintStr = flags.get('solana-mint') ? String(flags.get('solana-mint')).trim() : '';
  const solDecimals = parseIntFlag(flags.get('solana-decimals'), 'solana-decimals', 6);
  const solProgramIdStr = flags.get('solana-program-id') ? String(flags.get('solana-program-id')).trim() : '';
  const solComputeUnitLimit = parseIntFlag(flags.get('solana-cu-limit'), 'solana-cu-limit', null);
  const solComputeUnitPriceMicroLamports = parseIntFlag(flags.get('solana-cu-price'), 'solana-cu-price', null);

  const lnImpl = (flags.get('ln-impl') && String(flags.get('ln-impl')).trim().toLowerCase()) || 'cln';
  if (lnImpl !== 'cln' && lnImpl !== 'lnd') die('Invalid --ln-impl (expected cln|lnd)');
  const lnBackend = (flags.get('ln-backend') && String(flags.get('ln-backend')).trim()) || 'docker';
  const lnComposeFile = (flags.get('ln-compose-file') && String(flags.get('ln-compose-file')).trim()) || defaultComposeFile;
  const lnService = flags.get('ln-service') ? String(flags.get('ln-service')).trim() : '';
  const lnNetworkRaw = (flags.get('ln-network') && String(flags.get('ln-network')).trim()) || 'regtest';
  let lnNetwork;
  try {
    lnNetwork = lnImpl === 'lnd' ? normalizeLndNetwork(lnNetworkRaw) : normalizeClnNetwork(lnNetworkRaw);
  } catch (err) {
    die(err?.message ?? String(err));
  }
  const lnCliBin = flags.get('ln-cli-bin') ? String(flags.get('ln-cli-bin')).trim() : '';
  const lndRpcserver = flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '';
  const lndTlsCert = flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '';
  const lndMacaroon = flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '';
  const lndDir = flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '';

  const receipts = receiptsDbPath ? openTradeReceiptsStore({ dbPath: receiptsDbPath }) : null;

  if (runSwap) {
    if (!solKeypairPath) die('Missing --solana-keypair (required when --run-swap 1)');
    if (!lnService && lnBackend === 'docker') die('Missing --ln-service (required when --ln-backend docker)');
  }

  const ln = {
    impl: lnImpl,
    backend: lnBackend,
    composeFile: lnComposeFile,
    service: lnService,
    network: lnNetwork,
    cliBin: lnCliBin,
    cwd: repoRoot,
    lnd: {
      rpcserver: lndRpcserver,
      tlscertpath: lndTlsCert,
      macaroonpath: lndMacaroon,
      lnddir: lndDir,
    },
  };

  const sc = new ScBridgeClient({ url, token });
  await sc.connect();

  ensureOk(await sc.join(rfqChannel), `join ${rfqChannel}`);
  ensureOk(await sc.subscribe([rfqChannel]), `subscribe ${rfqChannel}`);

  const takerPubkey = String(sc.hello?.peer || '').trim().toLowerCase();
  if (!takerPubkey) die('SC-Bridge hello missing peer pubkey');
  const signing = await loadPeerWalletFromFile(peerKeypairPath);
  if (signing.pubHex !== takerPubkey) {
    die(`peer keypair pubkey mismatch: sc_bridge=${takerPubkey} keypair=${signing.pubHex}`);
  }

  const fetchBtcUsdtMedian = async () => {
    const res = await sc.priceGet();
    if (!res || typeof res !== 'object') return { ok: false, error: 'price_get failed (no response)', median: null };
    if (res.type === 'error') return { ok: false, error: String(res.error || 'price_get error'), median: null };
    if (res.type !== 'price_snapshot') return { ok: false, error: `unexpected price_get response: ${res.type}`, median: null };
    const snap = res;
    if (Number.isFinite(priceMaxAgeMs) && priceMaxAgeMs > 0) {
      const age = Date.now() - Number(snap.ts || 0);
      if (!Number.isFinite(age) || age > priceMaxAgeMs) {
        return { ok: false, error: `price snapshot stale (ageMs=${age})`, median: null };
      }
    }
    const feed = snap?.pairs?.[PRICE_PAIR.BTC_USDT];
    const median = Number(feed?.median);
    if (!feed?.ok || !Number.isFinite(median) || median <= 0) {
      return { ok: false, error: feed?.error || 'btc_usdt median unavailable', median: null };
    }
    return { ok: true, error: null, median };
  };

  const persistTrade = (patch, eventKind = null, eventPayload = null) => {
    if (!receipts) return;
    try {
      receipts.upsertTrade(tradeId, patch);
      if (eventKind) receipts.appendEvent(tradeId, eventKind, eventPayload);
    } catch (err) {
      try {
        receipts.upsertTrade(tradeId, { last_error: err?.message ?? String(err) });
      } catch (_e) {}
      if (debug) process.stderr.write(`[taker] receipts persist error: ${err?.message ?? String(err)}\n`);
    }
  };

  const sol = runSwap
    ? (() => {
        const payer = readSolanaKeypair(solKeypairPath);
        const pool = new SolanaRpcPool({ rpcUrls: solRpcUrl, commitment: 'confirmed' });
        const expectedProgramId = solProgramIdStr ? new PublicKey(solProgramIdStr) : LN_USDT_ESCROW_PROGRAM_ID;
        return {
          payer,
          pool,
          expectedProgramId,
          computeUnitLimit: solComputeUnitLimit,
          computeUnitPriceMicroLamports: solComputeUnitPriceMicroLamports,
        };
      })()
    : null;

  const nowSec = Math.floor(Date.now() / 1000);
  const rfqUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.RFQ,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: btcSats,
      usdt_amount: usdtAmount,
      ...(runSwap ? { sol_recipient: sol.payer.publicKey.toBase58() } : {}),
      ...(runSwap && solMintStr ? { sol_mint: solMintStr } : {}),
      valid_until_unix: nowSec + rfqValidSec,
    },
  });
  const rfqId = hashUnsignedEnvelope(rfqUnsigned);
  const rfqSigned = signSwapEnvelope(rfqUnsigned, signing);
  ensureOk(await sc.send(rfqChannel, rfqSigned), 'send rfq');

  persistTrade(
    {
      role: 'taker',
      rfq_channel: rfqChannel,
      maker_peer: null,
      taker_peer: takerPubkey,
      btc_sats: btcSats,
      usdt_amount: usdtAmount,
      sol_mint: runSwap && solMintStr ? solMintStr : null,
      sol_recipient: runSwap ? sol.payer.publicKey.toBase58() : null,
      state: STATE.INIT,
    },
    'rfq_sent',
    rfqSigned
  );

  process.stdout.write(`${JSON.stringify({ type: 'ready', role: 'taker', rfq_channel: rfqChannel, trade_id: tradeId, rfq_id: rfqId, pubkey: takerPubkey })}\n`);

  let chosen = null; // { rfq_id, quote_id, quote }
  let joined = false;
  let done = false;
  let swapCtx = null; // { swapChannel, invite, trade, waiters, sent }

  const deadlineMs = Date.now() + timeoutSec * 1000;

  const maybeExit = () => {
    if (!once) return;
    if (!done) return;
    const delay = Number.isFinite(onceExitDelayMs) ? Math.max(onceExitDelayMs, 0) : 0;
    setTimeout(() => {
      try {
        receipts?.close();
      } catch (_e) {}
      sc.close();
      process.exit(0);
    }, delay);
  };

  const leaveSidechannel = async (channel) => {
    try {
      await sc.leave(channel);
    } catch (_e) {}
  };

  const resendRfqTimer = setInterval(async () => {
    try {
      if (chosen) return;
      if (Date.now() > deadlineMs) return;
      ensureOk(await sc.send(rfqChannel, rfqSigned), 'resend rfq');
      if (debug) process.stderr.write(`[taker] resend rfq trade_id=${tradeId}\n`);
    } catch (err) {
      if (debug) process.stderr.write(`[taker] resend rfq error: ${err?.message ?? String(err)}\n`);
    }
  }, Math.max(rfqResendMs, 200));

  let quoteAcceptSigned = null;
  const resendAcceptTimer = setInterval(async () => {
    try {
      if (!chosen) return;
      if (joined) return;
      if (Date.now() > deadlineMs) return;
      if (!quoteAcceptSigned) return;
      ensureOk(await sc.send(rfqChannel, quoteAcceptSigned), 'resend quote_accept');
      if (debug) process.stderr.write(`[taker] resend quote_accept trade_id=${tradeId} quote_id=${chosen.quote_id}\n`);
    } catch (err) {
      if (debug) process.stderr.write(`[taker] resend quote_accept error: ${err?.message ?? String(err)}\n`);
    }
  }, Math.max(acceptResendMs, 200));

  const stopTimers = () => {
    clearInterval(resendRfqTimer);
    clearInterval(resendAcceptTimer);
  };

  const enforceTimeout = setInterval(() => {
    if (Date.now() <= deadlineMs) return;
    stopTimers();
    die(`Timeout waiting for RFQ handshake (timeout-sec=${timeoutSec})`);
  }, 200);

  const waitForSwapMessage = (match, { timeoutMs, label }) =>
    new Promise((resolve, reject) => {
      if (!swapCtx) return reject(new Error('swapCtx not initialized'));
      const timer = setTimeout(() => {
        swapCtx.waiters.delete(waiter);
        reject(new Error(`Timeout waiting for ${label}`));
      }, timeoutMs);
      const waiter = (msg) => {
        try {
          if (!match(msg)) return;
          clearTimeout(timer);
          swapCtx.waiters.delete(waiter);
          resolve(msg);
        } catch (err) {
          clearTimeout(timer);
          swapCtx.waiters.delete(waiter);
          reject(err);
        }
      };
      swapCtx.waiters.add(waiter);
    });

  const ensureAta = async ({ connection, payer, mint, owner }) => {
    const ata = await getAssociatedTokenAddress(mint, owner);
    try {
      await getAccount(connection, ata, 'confirmed');
      return ata;
    } catch (_e) {
      return createAssociatedTokenAccount(connection, payer, mint, owner);
    }
  };

  const startSwap = async ({ swapChannel, invite }) => {
    ensureOk(await sc.subscribe([swapChannel]), `subscribe ${swapChannel}`);

    swapCtx = {
      swapChannel,
      invite,
      trade: createInitialTrade(tradeId),
      waiters: new Set(),
      sent: {},
      done: false,
      deadlineMs: Date.now() + swapTimeoutSec * 1000,
      timers: new Set(),
    };

    persistTrade(
      {
        swap_channel: swapChannel,
        state: swapCtx.trade.state,
      },
      'swap_started',
      { swap_channel: swapChannel }
    );

    const clearTimers = () => {
      for (const tmr of swapCtx.timers) clearInterval(tmr);
      swapCtx.timers.clear();
    };

    const checkSwapDeadline = () => {
      if (Date.now() <= swapCtx.deadlineMs) return;
      clearTimers();
      die(`Timeout waiting for swap completion (swap-timeout-sec=${swapTimeoutSec})`);
    };

    // Send ready status with invite attached to accelerate authorization.
  const readyUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.STATUS,
    tradeId,
    body: { state: STATE.INIT, note: 'ready' },
  });
  const readySigned = signSwapEnvelope(readyUnsigned, signing);
  swapCtx.sent.ready = readySigned;
  await sc.send(swapChannel, readySigned, { invite });
    process.stdout.write(`${JSON.stringify({ type: 'swap_ready_sent', trade_id: tradeId, swap_channel: swapChannel })}\n`);
    persistTrade({ state: swapCtx.trade.state }, 'swap_ready_sent', readySigned);

    const readyTimer = setInterval(async () => {
      try {
        checkSwapDeadline();
        if (swapCtx.done) return;
        if (swapCtx.trade.state !== STATE.INIT) return;
        await sc.send(swapChannel, readySigned, { invite });
      } catch (_e) {}
    }, Math.max(swapResendMs, 200));
    swapCtx.timers.add(readyTimer);

    // Wait for terms.
    const termsMsg = await waitForSwapMessage((m) => m?.kind === KIND.TERMS && m?.trade_id === tradeId, {
      timeoutMs: swapTimeoutSec * 1000,
      label: 'TERMS',
    });

    // Guardrail: bind swap counterparty identity to the quote we accepted.
    const quoteMaker = String(chosen?.quote?.signer || '').trim().toLowerCase();
    const gotTermsSigner = String(termsMsg.signer || '').trim().toLowerCase();
    if (quoteMaker && gotTermsSigner && quoteMaker !== gotTermsSigner) {
      throw new Error(`terms signer mismatch vs quote signer (terms=${gotTermsSigner} quote=${quoteMaker})`);
    }
    const termsReceiver = String(termsMsg.body?.ln_receiver_peer || '').trim().toLowerCase();
    if (quoteMaker && termsReceiver && quoteMaker !== termsReceiver) {
      throw new Error(`terms.ln_receiver_peer mismatch vs quote signer (terms=${termsReceiver} quote=${quoteMaker})`);
    }
    const termsPayer = String(termsMsg.body?.ln_payer_peer || '').trim().toLowerCase();
    if (termsPayer && termsPayer !== takerPubkey) {
      throw new Error(`terms.ln_payer_peer mismatch vs our pubkey (terms=${termsPayer} want=${takerPubkey})`);
    }

    // Verify Solana recipient matches our keypair before proceeding.
    const wantRecipient = sol.payer.publicKey.toBase58();
    const gotRecipient = String(termsMsg.body?.sol_recipient || '');
    if (gotRecipient !== wantRecipient) {
      throw new Error(`terms.sol_recipient mismatch (got=${gotRecipient} want=${wantRecipient})`);
    }
    if (solMintStr) {
      const gotMint = String(termsMsg.body?.sol_mint || '');
      if (gotMint !== solMintStr) throw new Error(`terms.sol_mint mismatch (got=${gotMint} want=${solMintStr})`);
    }

    if (minSolRefundWindowSec !== null) {
      const nowSec = Math.floor(Date.now() / 1000);
      const refundAfterUnix = Number(termsMsg.body?.sol_refund_after_unix);
      if (!Number.isFinite(refundAfterUnix) || refundAfterUnix <= 0) {
        throw new Error('terms.sol_refund_after_unix missing/invalid');
      }
      const windowSec = refundAfterUnix - nowSec;
      if (windowSec < minSolRefundWindowSec) {
        throw new Error(
          `terms.sol_refund_after_unix too soon (window_sec=${windowSec} min=${minSolRefundWindowSec})`
        );
      }
      if (maxSolRefundWindowSec !== null && Number.isFinite(maxSolRefundWindowSec) && windowSec > maxSolRefundWindowSec) {
        throw new Error(
          `terms.sol_refund_after_unix too far (window_sec=${windowSec} max=${maxSolRefundWindowSec})`
        );
      }
    }

    // Guardrail: terms must match the quote we accepted (prevents bait-and-switch between RFQ and swap channel).
    if (chosen?.quote?.body) {
      if (Number(termsMsg.body?.btc_sats) !== Number(chosen.quote.body?.btc_sats)) {
        throw new Error(
          `terms.btc_sats mismatch vs quote (terms=${termsMsg.body?.btc_sats} quote=${chosen.quote.body?.btc_sats})`
        );
      }
      if (String(termsMsg.body?.usdt_amount) !== String(chosen.quote.body?.usdt_amount)) {
        throw new Error(
          `terms.usdt_amount mismatch vs quote (terms=${termsMsg.body?.usdt_amount} quote=${chosen.quote.body?.usdt_amount})`
        );
      }
      if (chosen.quote.body?.sol_mint) {
        if (String(termsMsg.body?.sol_mint) !== String(chosen.quote.body?.sol_mint)) {
          throw new Error(
            `terms.sol_mint mismatch vs quote (terms=${termsMsg.body?.sol_mint} quote=${chosen.quote.body?.sol_mint})`
          );
        }
      }
    }

    // Guardrail: fee ceilings (local policy; on-chain also enforces hard caps).
    const platformFeeBps = Number(termsMsg.body?.platform_fee_bps || 0);
    const tradeFeeBps = Number(termsMsg.body?.trade_fee_bps || 0);
    if (!Number.isFinite(platformFeeBps) || platformFeeBps < 0) throw new Error('terms.platform_fee_bps invalid');
    if (!Number.isFinite(tradeFeeBps) || tradeFeeBps < 0) throw new Error('terms.trade_fee_bps invalid');
    if (platformFeeBps > maxPlatformFeeBps) {
      throw new Error(`terms.platform_fee_bps too high (got=${platformFeeBps} max=${maxPlatformFeeBps})`);
    }
    if (tradeFeeBps > maxTradeFeeBps) {
      throw new Error(`terms.trade_fee_bps too high (got=${tradeFeeBps} max=${maxTradeFeeBps})`);
    }
    if (platformFeeBps + tradeFeeBps > maxTotalFeeBps) {
      throw new Error(
        `terms total fee too high (got=${platformFeeBps + tradeFeeBps} max=${maxTotalFeeBps})`
      );
    }

    const termsHash = hashUnsignedEnvelope(stripSignature(termsMsg));
  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: termsHash },
  });
  const acceptSigned = signSwapEnvelope(acceptUnsigned, signing);
  {
    const r = applySwapEnvelope(swapCtx.trade, acceptSigned);
    if (!r.ok) throw new Error(r.error);
    swapCtx.trade = r.trade;
  }
    swapCtx.sent.accept = acceptSigned;
    await sc.send(swapChannel, acceptSigned);
    process.stdout.write(`${JSON.stringify({ type: 'accept_sent', trade_id: tradeId, swap_channel: swapChannel })}\n`);
    persistTrade({ state: swapCtx.trade.state }, 'accept_sent', acceptSigned);

    const acceptTimer = setInterval(async () => {
      try {
        checkSwapDeadline();
        if (swapCtx.done) return;
        if (swapCtx.trade.state !== STATE.ACCEPTED && swapCtx.trade.state !== STATE.INIT && swapCtx.trade.state !== STATE.TERMS) return;
        if (swapCtx.trade.invoice) return;
        await sc.send(swapChannel, acceptSigned);
      } catch (_e) {}
    }, Math.max(swapResendMs, 200));
    swapCtx.timers.add(acceptTimer);

    // Wait for invoice + escrow proof.
    await waitForSwapMessage((m) => m?.kind === KIND.LN_INVOICE && m?.trade_id === tradeId, {
      timeoutMs: swapTimeoutSec * 1000,
      label: 'LN_INVOICE',
    });
    await waitForSwapMessage((m) => m?.kind === KIND.SOL_ESCROW_CREATED && m?.trade_id === tradeId, {
      timeoutMs: swapTimeoutSec * 1000,
      label: 'SOL_ESCROW_CREATED',
    });

    if (swapCtx.trade.invoice) {
      persistTrade(
        {
          ln_invoice_bolt11: swapCtx.trade.invoice.bolt11,
          ln_payment_hash_hex: swapCtx.trade.invoice.payment_hash_hex,
          state: swapCtx.trade.state,
        },
        'ln_invoice_recv',
        swapCtx.trade.invoice
      );
    }
    if (swapCtx.trade.escrow) {
      if (sol?.expectedProgramId) {
        const gotProgram = String(swapCtx.trade.escrow.program_id || '').trim();
        const wantProgram = sol.expectedProgramId.toBase58();
        if (!gotProgram) throw new Error('escrow.program_id missing');
        if (gotProgram !== wantProgram) {
          throw new Error(`escrow.program_id mismatch (got=${gotProgram} want=${wantProgram})`);
        }
      }
      persistTrade(
        {
          sol_program_id: swapCtx.trade.escrow.program_id,
          sol_mint: swapCtx.trade.escrow.mint,
          sol_recipient: swapCtx.trade.escrow.recipient,
          sol_refund: swapCtx.trade.escrow.refund,
          sol_escrow_pda: swapCtx.trade.escrow.escrow_pda,
          sol_vault_ata: swapCtx.trade.escrow.vault_ata,
          sol_refund_after_unix: swapCtx.trade.escrow.refund_after_unix,
          state: swapCtx.trade.state,
        },
        'sol_escrow_recv',
        swapCtx.trade.escrow
      );
    }

    // Hard rule: verify escrow on-chain before paying.
    const prepay = await sol.pool.call(
      (connection) =>
        verifySwapPrePayOnchain({
          terms: swapCtx.trade.terms,
          invoiceBody: swapCtx.trade.invoice,
          escrowBody: swapCtx.trade.escrow,
          connection,
          now_unix: Math.floor(Date.now() / 1000),
        }),
      { label: 'taker:verify-prepay' }
    );
    if (!prepay.ok) throw new Error(`verify-prepay failed: ${prepay.error}`);
    // Defense-in-depth: ensure the on-chain escrow fee receiver settings match the negotiated TERMS, otherwise
    // claim could fail (wrong trade fee vault PDA) or fees could be misrepresented.
    if (prepay?.onchain?.state?.v === 3) {
      const st = prepay.onchain.state;
      const wantTradeFeeCollector = String(swapCtx.trade.terms?.trade_fee_collector || '').trim();
      if (wantTradeFeeCollector && st.tradeFeeCollector?.toBase58?.() !== wantTradeFeeCollector) {
        throw new Error(
          `onchain tradeFeeCollector mismatch vs terms (state=${st.tradeFeeCollector.toBase58()} terms=${wantTradeFeeCollector})`
        );
      }
      const wantTradeFeeBps = Number(swapCtx.trade.terms?.trade_fee_bps || 0);
      if (Number.isFinite(wantTradeFeeBps) && Number(st.tradeFeeBps) !== wantTradeFeeBps) {
        throw new Error(`onchain tradeFeeBps mismatch vs terms (state=${st.tradeFeeBps} terms=${wantTradeFeeBps})`);
      }
      const wantPlatformFeeCollector = String(swapCtx.trade.terms?.platform_fee_collector || '').trim();
      if (wantPlatformFeeCollector && st.platformFeeCollector?.toBase58?.() !== wantPlatformFeeCollector) {
        throw new Error(
          `onchain platformFeeCollector mismatch vs terms (state=${st.platformFeeCollector.toBase58()} terms=${wantPlatformFeeCollector})`
        );
      }
      const wantPlatformFeeBps = Number(swapCtx.trade.terms?.platform_fee_bps || 0);
      if (Number.isFinite(wantPlatformFeeBps) && Number(st.platformFeeBps) !== wantPlatformFeeBps) {
        throw new Error(`onchain platformFeeBps mismatch vs terms (state=${st.platformFeeBps} terms=${wantPlatformFeeBps})`);
      }
    }

    if (priceGuard) {
      const px = await fetchBtcUsdtMedian();
      if (!px.ok) throw new Error(`price guard failed: ${px.error}`);
      const implied = impliedPriceUsdtPerBtc({
        btcSats: swapCtx.trade.terms.btc_sats,
        usdtAmount: swapCtx.trade.terms.usdt_amount,
        usdtDecimals: solDecimals,
      });
      if (implied === null || !Number.isFinite(implied) || implied <= 0) {
        throw new Error('price guard failed: implied price unavailable');
      }
      const discountBps = ((1 - (implied / px.median)) * 10_000);
      if (Number.isFinite(discountBps) && discountBps > takerMaxDiscountBps) {
        throw new Error(`price guard failed: discount_bps=${discountBps.toFixed(1)} max=${takerMaxDiscountBps}`);
      }
    }

    // Pay LN invoice and obtain preimage.
    const payRes = await lnPay(ln, { bolt11: swapCtx.trade.invoice.bolt11 });
    const preimageHex = String(payRes?.payment_preimage || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(preimageHex)) throw new Error('LN pay missing payment_preimage');

    const paymentHashHex = String(swapCtx.trade.invoice.payment_hash_hex || '').trim().toLowerCase();

  const lnPaidUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.LN_PAID,
    tradeId,
    body: { payment_hash_hex: paymentHashHex },
  });
  const lnPaidSigned = signSwapEnvelope(lnPaidUnsigned, signing);
  {
    const r = applySwapEnvelope(swapCtx.trade, lnPaidSigned);
    if (!r.ok) throw new Error(r.error);
    swapCtx.trade = r.trade;
  }
    swapCtx.sent.ln_paid = lnPaidSigned;
    await sc.send(swapChannel, lnPaidSigned);
    process.stdout.write(`${JSON.stringify({ type: 'ln_paid_sent', trade_id: tradeId, swap_channel: swapChannel })}\n`);

    persistTrade(
      {
        ln_payment_hash_hex: paymentHashHex,
        ln_preimage_hex: persistPreimage ? preimageHex : null,
        state: swapCtx.trade.state,
      },
      'ln_paid',
      { payment_hash_hex: paymentHashHex }
    );

    if (stopAfterLnPay) {
      // Recovery path: operator can claim via `scripts/swaprecover.mjs claim ...`.
      swapCtx.done = true;
      done = true;
      clearTimers();
      process.stdout.write(`${JSON.stringify({ type: 'stopped_after_ln_pay', trade_id: tradeId, swap_channel: swapChannel })}\n`);
      await leaveSidechannel(swapChannel);
      try {
        receipts?.close();
      } catch (_e) {}
      sc.close();
      process.exit(0);
    }

    // Claim escrow on Solana.
    const mint = new PublicKey(swapCtx.trade.terms.sol_mint);
    const recipientToken = await sol.pool.call(
      (connection) =>
        ensureAta({
          connection,
          payer: sol.payer,
          mint,
          owner: sol.payer.publicKey,
        }),
      { label: 'taker:ensure-ata' }
    );
    const programId = swapCtx.trade.escrow?.program_id ? new PublicKey(swapCtx.trade.escrow.program_id) : undefined;
    const tradeFeeCollectorStr = swapCtx.trade.terms?.trade_fee_collector;
    if (!tradeFeeCollectorStr) throw new Error('Missing terms.trade_fee_collector');
    const { tx: claimTx } = await sol.pool.call(
      (connection) =>
        claimEscrowTx({
          connection,
          recipient: sol.payer,
          recipientTokenAccount: recipientToken,
          mint,
          paymentHashHex,
          preimageHex,
          tradeFeeCollector: new PublicKey(String(tradeFeeCollectorStr)),
          computeUnitLimit: sol.computeUnitLimit,
          computeUnitPriceMicroLamports: sol.computeUnitPriceMicroLamports,
          ...(programId ? { programId } : {}),
        }),
      { label: 'taker:build-claim-tx' }
    );
    const claimSig = await sol.pool.call((connection) => sendAndConfirm(connection, claimTx), { label: 'taker:send-claim-tx' });

  const solClaimedUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SOL_CLAIMED,
    tradeId,
    body: {
      payment_hash_hex: paymentHashHex,
      escrow_pda: swapCtx.trade.escrow.escrow_pda,
      tx_sig: claimSig,
    },
  });
  const solClaimedSigned = signSwapEnvelope(solClaimedUnsigned, signing);
  swapCtx.sent.sol_claimed = solClaimedSigned;
  await sc.send(swapChannel, solClaimedSigned);
    process.stdout.write(`${JSON.stringify({ type: 'sol_claimed_sent', trade_id: tradeId, swap_channel: swapChannel, tx_sig: claimSig })}\n`);
    persistTrade({ state: swapCtx.trade.state }, 'sol_claimed', solClaimedSigned);

    // Best-effort: resend final proofs a few times to reduce "sent but peer exited" flakiness.
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        await sc.send(swapChannel, solClaimedSigned);
      } catch (_e) {}
    }

    swapCtx.done = true;
    done = true;
    clearTimers();
    process.stdout.write(`${JSON.stringify({ type: 'swap_done', trade_id: tradeId, swap_channel: swapChannel })}\n`);
    persistTrade({ state: STATE.CLAIMED }, 'swap_done', { trade_id: tradeId, swap_channel: swapChannel });
    await leaveSidechannel(swapChannel);
    maybeExit();
  };

  sc.on('sidechannel_message', async (evt) => {
    try {
      if (swapCtx && evt?.channel === swapCtx.swapChannel) {
        const msg = evt?.message;
        if (!msg || typeof msg !== 'object') return;
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const r = applySwapEnvelope(swapCtx.trade, msg);
        if (r.ok) swapCtx.trade = r.trade;
        for (const waiter of swapCtx.waiters) {
          try {
            waiter(msg);
          } catch (_e) {}
        }
        return;
      }

      if (evt?.channel !== rfqChannel) return;
      const msg = evt?.message;
      if (!msg || typeof msg !== 'object') return;

      if (msg.kind === KIND.QUOTE) {
        if (String(msg.trade_id) !== tradeId) return;
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const quoteUnsigned = stripSignature(msg);
        const quoteId = hashUnsignedEnvelope(quoteUnsigned);
        const rfqIdGot = String(msg.body?.rfq_id || '').trim().toLowerCase();
        if (rfqIdGot !== rfqId) return;

        const validUntil = Number(msg.body?.valid_until_unix);
        const now = Math.floor(Date.now() / 1000);
        if (Number.isFinite(validUntil) && validUntil <= now) {
          if (debug) process.stderr.write(`[taker] ignore expired quote quote_id=${quoteId}\n`);
          return;
        }

        if (!chosen) {
          // Guardrail: only accept quotes for the exact requested size.
          if (Number(msg.body?.btc_sats) !== Number(btcSats)) return;

          const quoteAmountStr = String(msg.body?.usdt_amount || '').trim();
          const quoteAmount = asBigIntAmount(quoteAmountStr);
          if (quoteAmount === null) return;

          // Guardrail: treat RFQ usdt_amount as a minimum when set (>0).
          const rfqMin = asBigIntAmount(usdtAmount) ?? 0n;
          if (rfqMin > 0n && quoteAmount < rfqMin) return;

          // Guardrail: if enabled, require oracle health + acceptable discount vs oracle price.
          if (priceGuard) {
            const px = await fetchBtcUsdtMedian();
            if (!px.ok) return;
            const implied = impliedPriceUsdtPerBtc({
              btcSats: msg.body.btc_sats,
              usdtAmount: quoteAmountStr,
              usdtDecimals: solDecimals,
            });
            if (implied === null || !Number.isFinite(implied) || implied <= 0) return;
            const discountBps = ((1 - (implied / px.median)) * 10_000);
            if (Number.isFinite(discountBps) && discountBps > takerMaxDiscountBps) {
              if (debug) {
                process.stderr.write(`[taker] reject quote (discount_bps=${discountBps.toFixed(1)} > max=${takerMaxDiscountBps}) quote_id=${quoteId}\n`);
              }
              return;
            }
          }

          chosen = { rfq_id: rfqId, quote_id: quoteId, quote: msg };
          const quoteAcceptUnsigned = createUnsignedEnvelope({
            v: 1,
            kind: KIND.QUOTE_ACCEPT,
            tradeId,
            body: {
              rfq_id: rfqId,
              quote_id: quoteId,
            },
          });
          quoteAcceptSigned = signSwapEnvelope(quoteAcceptUnsigned, signing);
          ensureOk(await sc.send(rfqChannel, quoteAcceptSigned), 'send quote_accept');
          if (debug) process.stderr.write(`[taker] accepted quote trade_id=${tradeId} quote_id=${quoteId}\n`);
          process.stdout.write(`${JSON.stringify({ type: 'quote_accepted', trade_id: tradeId, rfq_id: rfqId, quote_id: quoteId })}\n`);

          persistTrade({ state: STATE.INIT }, 'quote_accepted', quoteAcceptSigned);
        }
        return;
      }

      if (msg.kind === KIND.SWAP_INVITE) {
        if (String(msg.trade_id) !== tradeId) return;
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        if (!chosen) return;
        if (String(msg.body?.rfq_id || '').trim().toLowerCase() !== chosen.rfq_id) return;
        if (String(msg.body?.quote_id || '').trim().toLowerCase() !== chosen.quote_id) return;

        // Guardrail: only accept swap invites from the same maker that authored the quote we accepted.
        const quoteMaker = String(chosen?.quote?.signer || '').trim().toLowerCase();
        const ownerPubkey = String(msg.body?.owner_pubkey || '').trim().toLowerCase();
        const inviterPubkey = String(msg.body?.invite?.payload?.inviterPubKey || '').trim().toLowerCase();
        const inviteMaker = ownerPubkey || inviterPubkey;
        if (quoteMaker && inviteMaker && inviteMaker !== quoteMaker) return;

        const swapChannel = String(msg.body?.swap_channel || '').trim();
        if (!swapChannel) return;

        const invite = msg.body?.invite || null;
        const welcome = msg.body?.welcome || null;

        // Best-effort: ensure the invite is for us (defense-in-depth).
        const invitee = String(invite?.payload?.inviteePubKey || '').trim().toLowerCase();
        if (invitee && invitee !== takerPubkey) return;

        ensureOk(await sc.join(swapChannel, { invite, welcome }), `join ${swapChannel}`);
        joined = true;
        stopTimers();
        clearInterval(enforceTimeout);
        process.stdout.write(`${JSON.stringify({ type: 'swap_joined', trade_id: tradeId, swap_channel: swapChannel })}\n`);

        persistTrade(
          {
            swap_channel: swapChannel,
            maker_peer: msg.body?.owner_pubkey ? String(msg.body.owner_pubkey).trim().toLowerCase() : null,
          },
          'swap_joined',
          { swap_channel: swapChannel }
        );

        if (!runSwap) {
          if (once) await leaveSidechannel(swapChannel);
          done = true;
          maybeExit();
          return;
        }

        // Swap state machine is run asynchronously; the process stays alive.
        startSwap({ swapChannel, invite }).catch(async (err) => {
          await leaveSidechannel(swapChannel);
          die(err?.stack || err?.message || String(err));
        });
      }
    } catch (err) {
      if (debug) process.stderr.write(`[taker] error: ${err?.message ?? String(err)}\n`);
    }
  });

  // Keep process alive.
  await new Promise(() => {});
}

main().catch((err) => die(err?.stack || err?.message || String(err)));
