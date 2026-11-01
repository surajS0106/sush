// Password hashes for the Worker. better-auth's default (scrypt in JavaScript)
// takes more CPU than a free Worker gets per request, so the relay uses
// PBKDF2-SHA256 from Web Crypto, which runs natively. Each hash records its
// iteration count, so the count can change without breaking older ones.

/** As many as Workers' Web Crypto allows. */
const ITERATIONS = 100_000;

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(await derive(password, salt, ITERATIONS))}`;
}

export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const [scheme, iterations, salt, expected] = hash.split("$");
  const count = Number(iterations);
  if (scheme !== "pbkdf2-sha256" || !Number.isInteger(count) || count < 1 || count > ITERATIONS || !salt || !expected) return false;
  const actual = await derive(password, unb64(salt), count);
  const want = unb64(expected);
  return actual.length === want.length && crypto.subtle.timingSafeEqual(actual, want);
}
