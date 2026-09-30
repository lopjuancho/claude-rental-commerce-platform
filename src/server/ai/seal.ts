/**
 * Sealing secrets to the customer's own session (ADR 0017 §11, N2).
 *
 * A quote link token must survive a lost response (the replay must show a working link) but may
 * never be stored in clear. It is encrypted (AES-256-GCM) with a key derived (HKDF-SHA-256) from
 * the assistant session token — the HttpOnly cookie value, of which the database only stores a
 * SHA-256. So a sealed token can be opened only while serving a request of the SAME browser
 * session: a database reader cannot, and another session or tenant cannot.
 */

export interface Sealer {
  seal(plain: string): Promise<string>;
  /** null when the value was not sealed for this session (or was tampered with). */
  open(sealed: string): Promise<string | null>;
}

const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function sessionSealer(sessionToken: string, organizationId: string): Sealer {
  const enc = new TextEncoder();
  let key: Promise<CryptoKey> | null = null;
  const keyOf = () =>
    (key ??= crypto.subtle
      .importKey("raw", enc.encode(sessionToken), "HKDF", false, ["deriveKey"])
      .then((ikm) =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: enc.encode("rental-commerce:ai-seal:v1"),
            info: enc.encode(organizationId),
          },
          ikm,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      ));
  return {
    async seal(plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyOf(), enc.encode(plain)),
      );
      const out = new Uint8Array(iv.length + ct.length);
      out.set(iv);
      out.set(ct, iv.length);
      return `s1.${b64u(out)}`;
    },
    async open(sealed) {
      if (!sealed.startsWith("s1.")) return null;
      try {
        const raw = unb64u(sealed.slice(3));
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: raw.slice(0, 12) },
          await keyOf(),
          raw.slice(12),
        );
        return new TextDecoder().decode(plain);
      } catch {
        return null;
      }
    },
  };
}
