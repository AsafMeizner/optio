import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authCookieName, secureAuthCookies } from "../../../lib/auth-cookies.js";

const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? "http://localhost:4000";
const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:3000";

/**
 * OAuth callback handler for the BFF (Backend for Frontend) pattern.
 *
 * After the API's OAuth callback generates a short-lived auth code,
 * it redirects the browser here. This server-side route handler:
 * 1. Exchanges the code for a session token (server-to-server)
 * 2. Sets the token as an HttpOnly cookie on the web app's origin
 * 3. Redirects the user to the app
 *
 * The session token never touches client-side JS.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const browserVerifier = request.cookies.get(authCookieName("oauth_verifier"))?.value;

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", PUBLIC_URL));
  }
  if (!browserVerifier) {
    return NextResponse.redirect(new URL("/login?error=invalid_state", PUBLIC_URL));
  }

  try {
    const res = await fetch(`${INTERNAL_API_URL}/api/auth/exchange-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, browserVerifier }),
    });

    if (!res.ok) {
      return NextResponse.redirect(new URL("/login?error=exchange_failed", PUBLIC_URL));
    }

    const { token } = (await res.json()) as { token: string };

    const response = NextResponse.redirect(new URL("/", PUBLIC_URL));
    response.cookies.set(authCookieName("oauth_verifier"), "", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: secureAuthCookies(),
      maxAge: 0,
    });
    response.cookies.set(authCookieName("session"), token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: secureAuthCookies(),
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });

    return response;
  } catch {
    return NextResponse.redirect(new URL("/login?error=exchange_failed", PUBLIC_URL));
  }
}
