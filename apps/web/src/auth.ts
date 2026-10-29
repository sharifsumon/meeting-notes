import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { accounts, sessions, users, verificationTokens } from "@minuteflow/db";
import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import type { Adapter } from "next-auth/adapters";
import Google from "next-auth/providers/google";
import { env, microsoftEnabled } from "@/env";
import { db } from "@/lib/db";
import { CALENDAR_SCOPES } from "@/lib/google/client";
import { MICROSOFT_PROVIDER, MICROSOFT_SCOPES } from "@/lib/microsoft/client";
import { saveOAuthTokens, toStoredTokens } from "@/lib/oauth-tokens";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  ...CALENDAR_SCOPES,
];

// Config is built lazily so `next build` doesn't need secrets or a database.
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const base = DrizzleAdapter(db(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  });

  const adapter: Adapter = {
    ...base,
    // Store OAuth tokens encrypted instead of in plain text.
    linkAccount: (account) => base.linkAccount!({ ...account, ...toStoredTokens(account) }),
  };

  return {
    adapter,
    secret: env().AUTH_SECRET,
    session: { strategy: "database" },
    providers: [
      Google({
        clientId: env().AUTH_GOOGLE_ID,
        clientSecret: env().AUTH_GOOGLE_SECRET,
        authorization: {
          params: {
            scope: GOOGLE_SCOPES.join(" "),
            // Offline access + consent so Google always returns a refresh token,
            // which we need to sync calendars while the user is away.
            access_type: "offline",
            prompt: "consent",
            // No include_granted_scopes: it would add back calendar.readonly from older sign-ins, a scope
            // Google never verified for us, and the consent screen would warn that the app is unverified.
          },
        },
      }),
      ...(microsoftEnabled() ? [microsoft()] : []),
    ],
    pages: { signIn: "/", error: "/" },
    callbacks: {
      session({ session, user }) {
        session.user.id = user.id;
        return session;
      },
    },
    events: {
      // Auth.js only writes tokens when an account is first linked; refresh them on every sign-in.
      async signIn({ account }) {
        if (account?.provider === "google" || account?.provider === MICROSOFT_PROVIDER) await saveOAuthTokens(account);
      },
    },
  };
});

type GraphMe = { id: string; displayName?: string; mail?: string | null; userPrincipalName?: string };

/**
 * Microsoft work, school and personal accounts. A plain OAuth provider against the "common" endpoint:
 * the profile comes from Graph /me, so multi-tenant ID-token issuer checks don't apply.
 */
function microsoft(): Provider {
  return {
    id: MICROSOFT_PROVIDER,
    name: "Microsoft",
    type: "oauth",
    clientId: env().AUTH_MICROSOFT_ENTRA_ID_ID,
    clientSecret: env().AUTH_MICROSOFT_ENTRA_ID_SECRET,
    authorization: {
      url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      params: { scope: MICROSOFT_SCOPES.join(" "), prompt: "select_account" },
    },
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userinfo: "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",
    client: { token_endpoint_auth_method: "client_secret_post" },
    checks: ["pkce", "state"],
    profile(me: GraphMe) {
      return { id: me.id, name: me.displayName ?? null, email: (me.mail ?? me.userPrincipalName ?? "").toLowerCase() || null, image: null };
    },
  };
}
