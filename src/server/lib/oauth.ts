import type { Env } from "./env";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const VALID_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/** Only long enough to bounce through Google and come back. */
const HANDSHAKE_TTL_SECONDS = 10 * 60;
export const OAUTH_COOKIE = "ffs_oauth";

export class OAuthError extends Error {}

export interface GoogleIdentity {
  /** Stable for the life of the Google account, unlike the address. */
  sub: string;
  email: string;
  name: string;
}

export function googleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Where Google sends the browser back. Must match a redirect URI registered on the OAuth
 * client exactly, including scheme and any trailing path. */
export function redirectUri(appOrigin: string): string {
  return `${appOrigin}/api/auth/google/callback`;
}

export interface Handshake {
  state: string;
  verifier: string;
}

/**
 * Builds the URL to send the browser to, plus the handshake values the callback needs back.
 *
 * `state` defends the callback against CSRF, and the PKCE `code_verifier` against an
 * intercepted authorization code being redeemed by anyone but us. Both are held in an
 * httpOnly cookie: the callback only proceeds when the state in the query matches the one in
 * the cookie, which an attacker can't set on someone else's browser.
 */
export async function startGoogleAuth(
  env: Env,
  appOrigin: string,
): Promise<{ url: string; handshake: Handshake }> {
  const handshake: Handshake = { state: randomToken(), verifier: randomToken() };

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri(appOrigin),
    response_type: "code",
    scope: "openid email profile",
    state: handshake.state,
    code_challenge: await s256(handshake.verifier),
    code_challenge_method: "S256",
    // Google only returns a verified email on an account it has verified; asking for consent
    // every time would be noise, so the default (no prompt) is right for a sign-in button.
    access_type: "online",
  });

  return { url: `${AUTH_ENDPOINT}?${params}`, handshake };
}

export function handshakeCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${OAUTH_COOKIE}=${value}`,
    "Path=/api/auth/google",
    "HttpOnly",
    "Secure",
    // Lax, not Strict: the callback arrives as a top-level navigation from accounts.google.com,
    // and Strict would withhold the cookie on that cross-site hop and break every sign-in.
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function encodeHandshake(handshake: Handshake): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(handshake)));
}

export function decodeHandshake(value: string | undefined): Handshake | null {
  if (!value) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64(padded))) as Handshake;
    return typeof parsed.state === "string" && typeof parsed.verifier === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export { HANDSHAKE_TTL_SECONDS };

/**
 * Trades the authorization code for an ID token and reads the identity out of it.
 *
 * The ID token's signature isn't checked against Google's JWKS, and doesn't need to be: it
 * came back over a TLS connection we opened directly to Google's token endpoint, which is
 * the case Google's own documentation exempts. The claims inside it still get validated —
 * an unvalidated `aud` would let a token minted for a different OAuth client be replayed at
 * ours.
 */
export async function exchangeGoogleCode(
  env: Env,
  appOrigin: string,
  code: string,
  verifier: string,
): Promise<GoogleIdentity> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri(appOrigin),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    throw new OAuthError(`Google token exchange failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  }

  const { id_token: idToken } = (await response.json()) as { id_token?: string };
  if (!idToken) throw new OAuthError("Google did not return an ID token");

  const segments = idToken.split(".");
  if (segments.length !== 3) throw new OAuthError("Malformed ID token");

  let claims: Record<string, unknown>;
  try {
    const padded = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    claims = JSON.parse(new TextDecoder().decode(fromBase64(padded))) as Record<string, unknown>;
  } catch {
    throw new OAuthError("Could not read the ID token");
  }

  if (!VALID_ISSUERS.has(String(claims.iss))) throw new OAuthError("ID token has the wrong issuer");
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new OAuthError("ID token was issued for a different client");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) throw new OAuthError("ID token has expired");

  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!sub || !email) throw new OAuthError("ID token is missing an account id or email");

  // The whole point of this flow is that Google vouches for the address. An unverified one
  // vouches for nothing, and linking on it would let someone claim an address they don't own.
  if (claims.email_verified !== true) throw new OAuthError("That Google account's email address isn't verified");

  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : email.split("@")[0];
  return { sub, email, name };
}
