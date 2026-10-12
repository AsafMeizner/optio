import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? "http://localhost:4000";
const SESSION_COOKIE_NAME = "optio_session";

/**
 * BFF (Backend for Frontend) proxy route.
 *
 * All client-side `/api/*` requests are routed here. The handler:
 * 1. Reads the HttpOnly session cookie (invisible to client-side JS)
 * 2. Forwards the request to the real API with an Authorization header
 * 3. Returns the API response transparently
 *
 * This keeps the session token out of client-side JavaScript entirely,
 * eliminating XSS-based session hijacking.
 */
async function proxyRequest(request: NextRequest) {
  const url = new URL(request.url);
  const targetUrl = `${INTERNAL_API_URL}${url.pathname}${url.search}`;
  const isMcp = url.pathname === "/api/mcp";

  const headers = new Headers();

  // Forward safe request headers
  const forwardHeaders = ["content-type", "accept", "x-workspace-id"];
  for (const name of forwardHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (isMcp) {
    // MCP is a bearer-authenticated integration, not a cookie-authenticated
    // UI request. Preserve its Origin and Host for the controller's checks.
    for (const name of ["authorization", "origin", "host", "mcp-protocol-version"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
  }

  // Inject session token as Bearer header (from HttpOnly cookie)
  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (sessionToken && !isMcp) {
    headers.set("Authorization", `Bearer ${sessionToken}`);
  }

  try {
    // OAuth login routes return 302 redirects that the browser must follow
    // directly (to GitHub, Google, etc.). Don't let fetch() silently follow
    // them — pass the redirect through to the browser instead.
    const isAuthRedirect = url.pathname.match(/^\/api\/auth\/[^/]+\/(login|callback)$/);

    const fetchInit: RequestInit = {
      method: request.method,
      headers,
      redirect: isAuthRedirect || isMcp ? "manual" : "follow",
    };

    // Forward request body for non-GET/HEAD methods
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (isMcp) {
        // Undici may replay a body on an authentication challenge. A raw
        // stream has no replayable source and turns a legitimate 401 into a
        // fetch failure. MCP RPCs are small: buffer within the API's limit.
        const reader = request.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 256 * 1024) {
            await reader.cancel();
            return NextResponse.json({ error: "MCP request too large" }, { status: 413 });
          }
          chunks.push(value);
        }
        const body = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) {
          body.set(chunk, at);
          at += chunk.byteLength;
        }
        fetchInit.body = body.buffer;
      } else {
        fetchInit.body = request.body;
        // @ts-expect-error duplex is required for streaming request bodies in Node
        fetchInit.duplex = "half";
      }
    }

    const apiRes = await fetch(targetUrl, fetchInit);

    // For auth redirects, pass the Location header through to the browser
    if (isAuthRedirect && apiRes.status >= 300 && apiRes.status < 400) {
      const location = apiRes.headers.get("location");
      if (location) {
        return NextResponse.redirect(location, apiRes.status);
      }
    }

    // Build a clean response — don't forward Set-Cookie or other sensitive
    // headers from the API that could conflict with the web origin.
    const responseHeaders = new Headers();
    const safeResponseHeaders = ["content-type", "content-length", "cache-control", "etag"];
    if (isMcp) safeResponseHeaders.push("www-authenticate", "allow", "mcp-protocol-version");
    for (const name of safeResponseHeaders) {
      const value = apiRes.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    return new NextResponse(apiRes.body, {
      status: apiRes.status,
      statusText: apiRes.statusText,
      headers: responseHeaders,
    });
  } catch {
    return NextResponse.json({ error: "API proxy error" }, { status: 502 });
  }
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const PATCH = proxyRequest;
export const DELETE = proxyRequest;
