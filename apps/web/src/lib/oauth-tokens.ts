import "server-only";
import { accounts } from "@minuteflow/db";
import { and, eq } from "drizzle-orm";
import { env } from "@/env";
import { decrypt, encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";

type TokenFields = {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: number | null;
  scope?: string | null;
};

/** Encrypts token fields for storage. We never need the id_token, so it isn't kept. */
export function toStoredTokens(account: TokenFields) {
  const key = env().TOKEN_ENCRYPTION_KEY;
  return {
    access_token: account.access_token ? encrypt(account.access_token, key) : undefined,
    refresh_token: account.refresh_token ? encrypt(account.refresh_token, key) : undefined,
    id_token: undefined,
  };
}

export async function saveOAuthTokens(
  account: TokenFields & { provider: string; providerAccountId: string },
) {
  const stored = toStoredTokens(account);
  await db()
    .update(accounts)
    .set({
      access_token: stored.access_token ?? null,
      expires_at: account.expires_at ?? null,
      scope: account.scope ?? null,
      id_token: null,
      // Google omits the refresh token on some sign-ins; keep the one we have.
      ...(stored.refresh_token ? { refresh_token: stored.refresh_token } : {}),
    })
    .where(
      and(eq(accounts.provider, account.provider), eq(accounts.providerAccountId, account.providerAccountId)),
    );
}

export function decryptToken(value: string | null): string | null {
  return value ? decrypt(value, env().TOKEN_ENCRYPTION_KEY) : null;
}
