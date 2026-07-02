/**
 * auth.ts — controlCode generation and verification.
 *
 * The controlCode is a 4-character letters-only token that the server
 * generates when a room first materializes. It is sent privately to the
 * first assistant connection via __welcome__ and must accompany every
 * privileged command thereafter (see PRIVILEGED_COMMAND_TYPES).
 *
 * Letters only (no digits): activity organizers found '0' vs 'O' hard to
 * tell apart on the projector under time pressure; dropping digits removes
 * the ambiguity entirely.
 *
 * Threat model: low. This guards against "another assistant page in the
 * same browser session accidentally hijacking the room", not against a
 * determined adversary. 26^4 ≈ 457k is enough deterrence for a
 * single-session insurance training game.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALPHABET_LEN = ALPHABET.length;          // 26
// Largest multiple of 26 that fits in a byte (26*9=234); bytes ≥ this are
// biased toward the low letters, so we reject-sample them out.
const REJECTION_CEILING = ALPHABET_LEN * 9;     // 234

export function generateControlCode(length = 4): string {
  // Workers expose `crypto.getRandomValues` globally. Allocate 2× to
  // handle rejection sampling without a refill loop in the common case.
  const bytes = new Uint8Array(length * 2);
  crypto.getRandomValues(bytes);

  let out = '';
  let i = 0;
  while (out.length < length && i < bytes.length) {
    const byte = bytes[i++];
    if (byte === undefined) continue;
    if (byte < REJECTION_CEILING) {
      out += ALPHABET[byte % ALPHABET_LEN];
    }
  }

  // Pad in the unlikely event rejection sampling consumed all 12 bytes.
  while (out.length < length) {
    const buf = new Uint8Array(1);
    crypto.getRandomValues(buf);
    const byte = buf[0];
    if (byte !== undefined && byte < REJECTION_CEILING) {
      out += ALPHABET[byte % ALPHABET_LEN];
    }
  }

  return out;
}

/**
 * Constant-time-ish equality check. Not strictly constant-time because JS
 * strings are compared char-by-char by the runtime; for our threat model
 * (low-stakes session token, not a password) the simple === is acceptable.
 * Wrapping it in this helper keeps the call sites self-documenting.
 */
export function verifyControlCode(provided: string | undefined, stored: string): boolean {
  if (typeof provided !== 'string') return false;
  if (provided.length !== stored.length) return false;
  return provided === stored;
}
