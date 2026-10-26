/** HTTPS cookies are host-bound so a sibling subdomain cannot plant a login. */
export function secureAuthCookies(): boolean {
  return process.env.PUBLIC_URL?.startsWith("https://") === true;
}

export function authCookieName(name: "session" | "oauth_verifier"): string {
  return `${secureAuthCookies() ? "__Host-" : ""}optio_${name}`;
}
