import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import { stableStringify } from '../util/stableStringify.js';

export function createUnsignedEnvelope({ kind, tradeId, body, ts = Date.now(), nonce = null, v = 1 }) {
  if (!kind || typeof kind !== 'string') throw new Error('kind is required');
  if (!tradeId || typeof tradeId !== 'string') throw new Error('tradeId is required');
  if (body === undefined) throw new Error('body is required');

  return {
    v,
    kind,
    trade_id: tradeId,
    ts,
    nonce: nonce || Math.random().toString(36).slice(2, 12),
    body,
  };
}

export function encodeEnvelopeForSigning(unsignedEnvelope) {
  // Deterministic encoding so signatures are reproducible across runtimes.
  return stableStringify(unsignedEnvelope);
}

export function signUnsignedEnvelopeHex(unsignedEnvelope, secretKeyHexOrBuf) {
  const message = encodeEnvelopeForSigning(unsignedEnvelope);
  let msgBuf;
  let secretBuf;
  try {
    msgBuf = b4a.from(message, 'utf8');
    secretBuf = b4a.isBuffer(secretKeyHexOrBuf)
      ? secretKeyHexOrBuf
      : b4a.from(String(secretKeyHexOrBuf || '').trim().toLowerCase(), 'hex');
  } catch (_e) {
    throw new Error('Invalid signing material');
  }
  const sigBuf = PeerWallet.sign(msgBuf, secretBuf);
  return b4a.toString(sigBuf, 'hex');
}

export function attachSignature(unsignedEnvelope, { signerPubKeyHex, sigHex }) {
  if (!signerPubKeyHex || typeof signerPubKeyHex !== 'string') throw new Error('signerPubKeyHex is required');
  if (!sigHex || typeof sigHex !== 'string') throw new Error('sigHex is required');
  return {
    ...unsignedEnvelope,
    signer: signerPubKeyHex.trim().toLowerCase(),
    sig: sigHex.trim().toLowerCase(),
  };
}

export function verifySignedEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return { ok: false, error: 'Invalid envelope' };
  const { sig, signer, ...unsigned } = envelope;
  if (!sig || typeof sig !== 'string') return { ok: false, error: 'Missing sig' };
  if (!signer || typeof signer !== 'string') return { ok: false, error: 'Missing signer' };
  const message = encodeEnvelopeForSigning(unsigned);
  let sigBuf;
  let msgBuf;
  let pubBuf;
  try {
    sigBuf = b4a.from(sig.trim().toLowerCase(), 'hex');
    msgBuf = b4a.from(message, 'utf8');
    pubBuf = b4a.from(signer.trim().toLowerCase(), 'hex');
  } catch (_e) {
    return { ok: false, error: 'Invalid signature encoding' };
  }
  const ok = PeerWallet.verify(sigBuf, msgBuf, pubBuf);
  return ok ? { ok: true, error: null } : { ok: false, error: 'Invalid signature' };
}
