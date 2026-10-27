/** Browser credentials must never authorize requests from an unrelated origin.
 * CORS alone only controls whether a response can be read; it does not protect
 * simple POST requests or WebSocket upgrades. Native clients omit Origin.
 */
export function browserOriginAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) return false;
  const configured = [
    process.env.PUBLIC_URL,
    process.env.PUBLIC_API_URL,
    ...(process.env.OPTIO_ALLOWED_ORIGINS?.split(",") ?? []),
  ].filter((value): value is string => !!value?.trim());
  const allowed = configured.length
    ? configured
    : process.env.NODE_ENV === "production"
      ? []
      : [
          "http://localhost:3000",
          "http://localhost:3001",
          `http://localhost:${process.env.API_PORT ?? 4000}`,
        ];
  return allowed.some((value) => {
    try {
      return new URL(value.trim()).origin === origin;
    } catch {
      return false;
    }
  });
}
