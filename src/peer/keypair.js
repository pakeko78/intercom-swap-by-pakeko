import b4a from 'b4a';
import PeerWallet from 'trac-wallet';

export async function loadPeerWalletFromFile(keypairPath, { password = b4a.alloc(0) } = {}) {
  const p = String(keypairPath || '').trim();
  if (!p) throw new Error('keypairPath is required');

  const wallet = new PeerWallet();
  await wallet.ready;
  await wallet.importFromFile(p, password);

  const pubHex = wallet.publicKey ? b4a.toString(wallet.publicKey, 'hex').toLowerCase() : '';
  const secHex = wallet.secretKey ? b4a.toString(wallet.secretKey, 'hex').toLowerCase() : '';
  if (!pubHex || !secHex) throw new Error('Peer keypair file did not contain keys');

  return { wallet, pubHex, secHex };
}

