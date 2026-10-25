// End-to-end encryption, exactly as the desktop app does it
// (`crates/sush-core/src/share/crypto.rs`; keep the two in step):
//
// - a body is `e2e1.<generation>.<nonce>.<ciphertext>`, XChaCha20-Poly1305 with
//   the share's key, bound to `sush-share|<share>|<generation>|<h2g or g2h>`;
// - everything a guest sends is `{ m, s }`: the message and its Ed25519
//   signature by this join's device key, then sealed;
// - a new key after someone is removed comes sealed for this device's X25519
//   key: `<ephemeral public>.<nonce>.<ciphertext>`, with a wrapping key from
//   HKDF-SHA256 over the shared secret, info `sush-share-rekey|<share>|<generation>`.
//
// Base64 is base64url without padding throughout.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const PREFIX = "e2e1.";
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const aad = (shareId: string, generation: number, dir: "h2g" | "g2h") => enc.encode(`sush-share|${shareId}|${generation}|${dir}`);

export interface ShareKey {
  generation: number;
  key: Uint8Array;
}

export const isSealed = (body: string) => body.startsWith(PREFIX);

/** Seal what this guest sends to the host. */
export function seal(key: ShareKey, shareId: string, plain: string): string {
  const nonce = random(24);
  const ct = xchacha20poly1305(key.key, nonce, aad(shareId, key.generation, "g2h")).encrypt(enc.encode(plain));
  return `${PREFIX}${key.generation}.${b64(nonce)}.${b64(ct)}`;
}

/** Open what the host sent, or null (wrong key, tampered, or not sealed). */
export function open(keys: ShareKey[], shareId: string, body: string): string | null {
  if (!isSealed(body)) return null;
  const [gen, nonce, ct] = body.slice(PREFIX.length).split(".");
  const generation = Number(gen);
  const key = keys.find((k) => k.generation === generation);
  if (!key || !nonce || !ct) return null;
  try {
    return dec.decode(xchacha20poly1305(key.key, unb64(nonce), aad(shareId, generation, "h2g")).decrypt(unb64(ct)));
  } catch {
    return null;
  }
}

/** The generation a sealed body names. */
export const generationOf = (body: string) => (isSealed(body) ? Number(body.slice(PREFIX.length).split(".")[0]) : null);

/** This join's keys: made fresh, kept in memory only. */
export class Device {
  private sign = ed25519.utils.randomSecretKey();
  private kx = x25519.utils.randomSecretKey();

  keys() {
    return { signPub: b64(ed25519.getPublicKey(this.sign)), kxPub: b64(x25519.getPublicKey(this.kx)) };
  }

  /** `{ m, s }` as JSON text, for sealing. */
  signed(message: string): string {
    return JSON.stringify({ m: message, s: b64(ed25519.sign(enc.encode(message), this.sign)) });
  }

  /** A key the host sealed for this device, or null. */
  openSealed(shareId: string, generation: number, sealed: string): ShareKey | null {
    const [eph, nonce, ct] = sealed.split(".");
    if (!eph || !nonce || !ct) return null;
    try {
      const shared = x25519.getSharedSecret(this.kx, unb64(eph));
      const info = enc.encode(`sush-share-rekey|${shareId}|${generation}`);
      const wrap = hkdf(sha256, shared, undefined, info, 32);
      const key = xchacha20poly1305(wrap, unb64(nonce), info).decrypt(unb64(ct));
      return key.length === 32 ? { generation, key } : null;
    } catch {
      return null;
    }
  }
}

/** An invite link's fragment: `t=<token>&k=<key>`, or just the token for a share that isn't encrypted. */
export function parseFragment(fragment: string): { token: string; key: string | null } {
  const f = fragment.replace(/^#/, "");
  if (!f.includes("=")) return { token: f, key: null };
  const params = new URLSearchParams(f);
  return { token: params.get("t") ?? "", key: params.get("k") || null };
}
