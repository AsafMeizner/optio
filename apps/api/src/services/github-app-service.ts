import type { Signer } from "./crypto/signer.js";
import { Rs256Signer, MlDsa65Signer } from "./crypto/signer.js";
import { logger } from "../logger.js";

// A per-instance cache of the installation token (an hour long; GitHub
// mints as many as are asked for and rotates nothing), so every API
// instance fetching its own is correct — the lock only folds concurrent
// callers within this process onto one fetch. Not shared state.
let cachedToken: { token: string; expiresAt: number } | null = null;
let installationTokenLock: Promise<string> | null = null;

const TOKEN_CACHE_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

export function isGitHubAppConfigured(): boolean {
  return !!(
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_INSTALLATION_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY
  );
}

// Cache the signer instance so the private key is only parsed once
let _appSigner: Signer | null = null;

export function loadAppSigner(): Signer {
  if (_appSigner) return _appSigner;

  const alg = process.env.GITHUB_APP_JWT_ALG ?? "RS256";
  switch (alg) {
    case "RS256":
      _appSigner = new Rs256Signer(process.env.GITHUB_APP_PRIVATE_KEY!);
      break;
    // Future: case "ML-DSA-65": _appSigner = new MlDsa65Signer(); break;
    default:
      throw new Error(`Unsupported GitHub App JWT algorithm: ${alg}`);
  }

  logger.info(
    { githubAppJwtKty: _appSigner.kty, githubAppJwtAlg: _appSigner.jwtAlg },
    "Signer configuration",
  );

  return _appSigner;
}

export async function generateJwt(): Promise<string> {
  const appId = process.env.GITHUB_APP_ID!;
  const signer = loadAppSigner();

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: signer.jwtAlg ?? "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: appId,
      iat: now - 60, // Clock skew tolerance
      exp: now + 600, // 10 minutes
    }),
  ).toString("base64url");

  const sigBuf = await signer.sign(Buffer.from(`${header}.${payload}`));
  const signature = sigBuf.toString("base64url");

  return `${header}.${payload}.${signature}`;
}

export async function getInstallationToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_CACHE_BUFFER_MS) {
    return cachedToken.token;
  }

  // Dedup concurrent requests: if a fetch is already in-flight, reuse it
  if (installationTokenLock) return installationTokenLock;

  const fetchPromise = fetchInstallationToken();
  installationTokenLock = fetchPromise;
  try {
    return await fetchPromise;
  } finally {
    installationTokenLock = null;
  }
}

async function fetchInstallationToken(): Promise<string> {
  // Re-check cache after acquiring the lock (another caller may have populated it)
  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_CACHE_BUFFER_MS) {
    return cachedToken.token;
  }

  const installationId = process.env.GITHUB_APP_INSTALLATION_ID!;
  const jwt = await generateJwt();

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Optio",
      },
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to get installation token: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  cachedToken = { token: data.token, expiresAt: new Date(data.expires_at).getTime() };
  return data.token;
}

export function resetTokenCache(): void {
  cachedToken = null;
  installationTokenLock = null;
  _appSigner = null;
}
