/**
 * libsodium's sealed box (`crypto_box_seal`), which GitHub's REST API wants
 * secrets encrypted with ("Encrypting secrets for the REST API"): an
 * ephemeral X25519 key pair, the nonce BLAKE2b-192(ephemeral pk ‖ recipient
 * pk), and NaCl's crypto_box — `ephemeral pk ‖ tag ‖ ciphertext`.
 *
 * The primitives are tweetnacl's (audited by Cure53) and the sealed-box
 * layout tweetnacl-sealedbox-js's (tweetnacl's box with a blakejs nonce);
 * this file only adapts their bytes. Node's crypto has X25519 but neither
 * XSalsa20 nor Poly1305 nor a variable-length BLAKE2b.
 */
import nacl from "tweetnacl";
import sealedBoxLib from "tweetnacl-sealedbox-js";

/** crypto_box_seal: what GitHub's `encrypted_value` is (base64 of it). */
export function sealedBox(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  if (recipientPublicKey.length !== nacl.box.publicKeyLength) {
    throw new RangeError("An X25519 public key is 32 bytes");
  }
  return sealedBoxLib.seal(message, recipientPublicKey);
}

/** crypto_box_seal_open, for the tests (and nothing else): null when it doesn't open. */
export function openSealedBox(
  sealed: Uint8Array,
  recipientPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array,
): Uint8Array | null {
  if (sealed.length < sealedBoxLib.overheadLength) return null;
  return sealedBoxLib.open(sealed, recipientPublicKey, recipientSecretKey) ?? null;
}

/** The X25519 public key of a 32-byte secret key. */
export function x25519Public(secretKey: Uint8Array): Uint8Array {
  return nacl.box.keyPair.fromSecretKey(secretKey).publicKey;
}
