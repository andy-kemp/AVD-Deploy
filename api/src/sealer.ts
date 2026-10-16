// Envelope encryption for operators' Microsoft refresh tokens (ADR 0018). Each value gets its own random AES-256-GCM
// key; that key is wrapped by an RSA key in Key Vault that the API can use but never export.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CryptographyClient } from '@azure/keyvault-keys';
import type { TokenCredential } from '@azure/identity';

export interface Sealer {
  seal(plaintext: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

interface Envelope {
  v: 1;
  kid: string;
  key: string;
  iv: string;
  tag: string;
  data: string;
}

function encrypt(plaintext: string, dataKey: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(envelope: Envelope, dataKey: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
}

export class KeyVaultSealer implements Sealer {
  private credential: TokenCredential;
  private keyId: string;
  private clients = new Map<string, CryptographyClient>();

  constructor(keyId: string, credential: TokenCredential) {
    this.keyId = keyId;
    this.credential = credential;
  }

  private client(keyId: string) {
    if (!this.clients.has(keyId)) this.clients.set(keyId, new CryptographyClient(keyId, this.credential));
    return this.clients.get(keyId)!;
  }

  async seal(plaintext: string) {
    const dataKey = randomBytes(32);
    const wrapped = await this.client(this.keyId).wrapKey('RSA-OAEP-256', dataKey);
    // The versioned key ID is stored, so values sealed before a key rotation can still be opened.
    const envelope: Envelope = { v: 1, kid: wrapped.keyID ?? this.keyId, key: Buffer.from(wrapped.result).toString('base64'), ...encrypt(plaintext, dataKey) };
    dataKey.fill(0);
    return JSON.stringify(envelope);
  }

  async open(sealed: string) {
    const envelope = JSON.parse(sealed) as Envelope;
    const unwrapped = await this.client(envelope.kid).unwrapKey('RSA-OAEP-256', Buffer.from(envelope.key, 'base64'));
    const dataKey = Buffer.from(unwrapped.result);
    try {
      return decrypt(envelope, dataKey);
    } finally {
      dataKey.fill(0);
    }
  }
}

/** Local runs and tests: a process-lifetime key, so nothing sealed survives a restart. */
export class MemorySealer implements Sealer {
  private key = randomBytes(32);

  async seal(plaintext: string) {
    const envelope: Envelope = { v: 1, kid: 'memory', key: '', ...encrypt(plaintext, this.key) };
    return JSON.stringify(envelope);
  }

  async open(sealed: string) {
    return decrypt(JSON.parse(sealed) as Envelope, this.key);
  }
}
