// AES-256-GCM encryption for credentials stored in MongoDB (judge API keys, agent endpoint tokens).
// Format: v1.<iv>.<tag>.<ciphertext> (base64url). Tampering or a wrong key makes decrypt throw.
import crypto from 'node:crypto';

export function createSecretBox(keyBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
    },
    decrypt(token) {
      const [v, iv, tag, ct] = String(token).split('.');
      if (v !== 'v1' || !iv || !tag || !ct) throw new Error('decryption failed');
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        d.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
      } catch { throw new Error('decryption failed'); }
    },
  };
}
