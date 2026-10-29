import "server-only";
import { accounts } from "@minuteflow/db";
import { and, eq } from "drizzle-orm";
import { env } from "@/env";
import { db } from "@/lib/db";
import { decryptToken, saveOAuthTokens } from "@/lib/oauth-tokens";

/** Auth.js provider id for Microsoft sign-in (work, school and personal accounts). */
export const MICROSOFT_PROVIDER = "microsoft-entra-id";

/** Delegated Graph permissions: who the user is, and reading their calendars. offline_access gives a refresh token. */
export const MICROSOFT_SCOPES = ["offline_access", "User.Read", "Calendars.Read"];

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const EXPIRY_MARGIN_S = 60;

/** The user must sign in with Microsoft again (token revoked, expired, or missing). */
export class MicrosoftReconnectRequired extends Error {
  constructor(message = "Microsoft account needs to be reconnected") {
    super(message);
    this.name = "MicrosoftReconnectRequired";
  }
}

export class MicrosoftApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MicrosoftApiError";
  }
}

async function getAccessToken(userId: string): Promise<string> {
  const [account] = await db()
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, MICROSOFT_PROVIDER)))
    .limit(1);
  if (!account) throw new MicrosoftReconnectRequired("No Microsoft account linked");

  const accessToken = decryptToken(account.access_token);
  const nowS = Math.floor(Date.now() / 1000);
  if (accessToken && account.expires_at && account.expires_at - EXPIRY_MARGIN_S > nowS) return accessToken;

  const refreshToken = decryptToken(account.refresh_token);
  const { AUTH_MICROSOFT_ENTRA_ID_ID: clientId, AUTH_MICROSOFT_ENTRA_ID_SECRET: clientSecret } = env();
  if (!refreshToken || !clientId || !clientSecret) throw new MicrosoftReconnectRequired("No refresh token stored");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: MICROSOFT_SCOPES.join(" "),
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
    if (body.error === "invalid_grant" || body.error === "interaction_required") throw new MicrosoftReconnectRequired();
    throw new Error(`Microsoft token refresh failed: ${res.status} ${body.error ?? ""}`.trim());
  }

  // Microsoft rotates refresh tokens, so the new one replaces the old.
  await saveOAuthTokens({
    provider: MICROSOFT_PROVIDER,
    providerAccountId: account.providerAccountId,
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? null,
    expires_at: nowS + (body.expires_in ?? 3600),
    scope: body.scope ?? account.scope,
  });
  return body.access_token;
}

/** GET a Microsoft Graph URL as the user, refreshing the access token when needed. */
export async function graphGet<T>(userId: string, url: string): Promise<T> {
  const token = await getAccessToken(userId);
  const res = await fetch(url, {
    // Event times come back in UTC instead of the calendar's own zone.
    headers: { authorization: `Bearer ${token}`, prefer: 'outlook.timezone="UTC"' },
    cache: "no-store",
  });
  if (res.status === 401) throw new MicrosoftReconnectRequired();
  if (!res.ok) {
    const body = await res.text();
    throw new MicrosoftApiError(res.status, `Microsoft Graph ${res.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}
