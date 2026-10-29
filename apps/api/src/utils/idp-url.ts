/** Identity-provider credentials require TLS; only literal local development may use HTTP. */
export function secureIdentityProviderUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return (
      url.protocol === "https:" ||
      (process.env.NODE_ENV !== "production" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}
export const insecureIdentityProviderTlsAllowed = () =>
  process.env.OPTIO_IDP_ALLOW_INSECURE_TLS === "true";
