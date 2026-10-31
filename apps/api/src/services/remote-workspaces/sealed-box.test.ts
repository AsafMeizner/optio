import { describe, expect, it } from "vitest";
import { openSealedBox, sealedBox, x25519Public } from "./sealed-box.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

describe("sealedBox (crypto_box_seal)", () => {
  const rsk = new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff);
  const rpk = bytes("c25e8b84378b21071d603dfce3f947b162b6e715240344db0a18d99259a6de23");
  const message = new TextEncoder().encode("export OPTIO_TOKEN='optio_pat_x'\n");

  it("derives the X25519 public key", () => {
    expect(hex(x25519Public(rsk))).toBe(hex(rpk));
  });

  it("opens a box sealed elsewhere: libsodium's layout byte for byte", () => {
    // Made independently (tweetnacl's nacl.box with Python's BLAKE2b-192
    // nonce over ephemeral pk ‖ recipient pk), the box GitHub's libsodium opens.
    const reference = bytes(
      "c8feca81be196cdf2cadeabf13c4903d7632dce4955aa68b6e5d9adef54e2616" +
        "f96a0acd0abffdc1ca35fa76599c5a2172cc7b89321a255790078a7d8f5928df" +
        "1005cb397b2ba10f9802670dd96cb12bc1",
    );
    expect(new TextDecoder().decode(openSealedBox(reference, rpk, rsk)!)).toBe(
      "export OPTIO_TOKEN='optio_pat_x'\n",
    );
  });

  it("opens with the recipient's key, with a fresh ephemeral key each time", () => {
    const a = sealedBox(message, rpk);
    const b = sealedBox(message, rpk);
    expect(a).toHaveLength(32 + 16 + message.length);
    expect(hex(a)).not.toBe(hex(b));
    expect(new TextDecoder().decode(openSealedBox(a, rpk, rsk)!)).toBe(
      "export OPTIO_TOKEN='optio_pat_x'\n",
    );
    const tampered = new Uint8Array(a);
    tampered[60] ^= 1;
    expect(openSealedBox(tampered, rpk, rsk)).toBeNull();
    expect(openSealedBox(a.subarray(0, 40), rpk, rsk)).toBeNull();
  });

  it("refuses a key that isn't 32 bytes", () => {
    expect(() => sealedBox(message, rpk.subarray(0, 31))).toThrow(RangeError);
  });
});
