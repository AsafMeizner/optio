/**
 * Fastify's `trustProxy` from OPTIO_TRUST_PROXY: whose X-Forwarded-For the
 * API believes, so `req.ip` — what the rate limits count, and the sign-in
 * limits most of all — is the person's address, not the ingress
 * controller's. Behind an ingress every request arrives from the
 * controller, and counting by its address put the whole organization in one
 * bucket (600 requests and 10 sign-ins a minute, for everyone).
 *
 *   ""  / unset   → false: believe nobody (the API is reached directly)
 *   "1", "2", …   → false: Fastify rejects hop-only trust
 *                    (configure explicit proxy addresses / CIDRs instead)
 *   "true"        → false: unrestricted proxy trust allows spoofed loopback IPs
 *   anything else → addresses / CIDRs, comma-separated
 */
export function trustProxyFromEnv(
  raw: string | undefined = process.env.OPTIO_TRUST_PROXY,
): boolean | string[] {
  const value = (raw ?? "").trim();
  if (!value || value === "false" || value === "0") return false;
  if (value === "true") return false;
  if (/^\d+$/.test(value)) return false;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Why OPTIO_TRUST_PROXY was ignored, for a startup warning: "true" and hop
 * counts read as "trust nobody", so without it every client is recorded (and
 * rate limited) as the ingress controller's address with no sign of why.
 * Null when the value is honoured or unset.
 */
export function ignoredTrustProxyReason(
  raw: string | undefined = process.env.OPTIO_TRUST_PROXY,
): string | null {
  const value = (raw ?? "").trim();
  if (value === "true") {
    return 'OPTIO_TRUST_PROXY="true" is ignored (it would let any client spoof its address); set the ingress controller\'s IPs or CIDRs instead';
  }
  if (/^\d+$/.test(value) && value !== "0") {
    return `OPTIO_TRUST_PROXY="${value}" is ignored (hop counts are not supported); set the ingress controller's IPs or CIDRs instead`;
  }
  return null;
}
