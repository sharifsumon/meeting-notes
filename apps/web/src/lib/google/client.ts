import "server-only";
import { accounts } from "@minuteflow/db";
import { and, eq } from "drizzle-orm";
import { env } from "@/env";
import { db } from "@/lib/db";
import { decryptToken, saveOAuthTokens } from "@/lib/oauth-tokens";

/** The user must sign in with Google again (token revoked, expired, or missing). */
export class GoogleReconnectRequired extends Error {
  constructor(message = "Google account needs to be reconnected") {
    super(message);
    this.name = "GoogleReconnectRequired";
  }
}

const EXPIRY_MARGIN_S = 60;

async function getAccessToken(userId: string): Promise<string> {
  const [account] = await db()
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, "google")))
    .limit(1);
  if (!account) throw new GoogleReconnectRequired("No Google account linked");

  const accessToken = decryptToken(account.access_token);
  const nowS = Math.floor(Date.now() / 1000);
  if (accessToken && account.expires_at && account.expires_at - EXPIRY_MARGIN_S > nowS) {
    return accessToken;
  }

  const refreshToken = decryptToken(account.refresh_token);
  if (!refreshToken) throw new GoogleReconnectRequired("No refresh token stored");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env().AUTH_GOOGLE_ID,
      client_secret: env().AUTH_GOOGLE_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    refresh_token?: string;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    if (body.error === "invalid_grant") throw new GoogleReconnectRequired();
    throw new Error(`Google token refresh failed: ${res.status} ${body.error ?? ""}`.trim());
  }

  await saveOAuthTokens({
    provider: "google",
    providerAccountId: account.providerAccountId,
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? null,
    expires_at: nowS + (body.expires_in ?? 3600),
    scope: body.scope ?? account.scope,
  });
  return body.access_token;
}

/** GET a Google API URL as the user, refreshing the access token when needed. */
export async function googleGet<T>(userId: string, url: string, params: Record<string, string> = {}): Promise<T> {
  const token = await getAccessToken(userId);
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(qs ? `${url}?${qs}` : url, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401) throw new GoogleReconnectRequired();
  if (!res.ok) {
    const body = await res.text();
    // The user unticked the calendar permission on the consent screen. Other 403s (rate limits,
    // a calendar they can only see free/busy for) aren't fixed by signing in again.
    if (res.status === 403 && missingScope(body)) throw new GoogleReconnectRequired("Calendar access was not granted");
    throw new GoogleApiError(res.status, `Google API ${res.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

/** Whether a 403 body says the token lacks the scope, as opposed to any other refusal. */
export function missingScope(body: string) {
  return /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|insufficient authentication scopes/i.test(body);
}
