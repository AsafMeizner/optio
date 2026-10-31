// tweetnacl-sealedbox-js ships no types: its seal / open (libsodium's
// crypto_box_seal layout over tweetnacl's box).
declare module "tweetnacl-sealedbox-js" {
  const sealedBox: {
    /** ephemeral pk ‖ tag ‖ ciphertext: publicKeyLength + overheadLength bytes more than the message. */
    readonly overheadLength: number;
    seal(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array;
    /** Null when it doesn't open. */
    open(
      sealed: Uint8Array,
      recipientPublicKey: Uint8Array,
      recipientSecretKey: Uint8Array,
    ): Uint8Array | null;
  };
  export default sealedBox;
}
