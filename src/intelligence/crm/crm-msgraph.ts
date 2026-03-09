import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import {
  ConfidentialClientApplication,
  type AuthorizationCodeRequest,
  type AuthorizationUrlRequest,
} from "@azure/msal-node";
import type { DraftOptions, EmailMessage, EmailProvider, EmailThread } from "./crm-provider.js";

// ============================================================================
// MSAL configuration
// ============================================================================

type TokenCache = {
  accessToken: string;
  expiresOn: number; // unix ms
  refreshToken?: string;
};

function defaultTokenPath(): string {
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "crm", "ms365-token.json");
}

function buildMsalApp(): ConfidentialClientApplication {
  const clientId = process.env.CRM_MS365_CLIENT_ID?.trim();
  const clientSecret = process.env.CRM_MS365_CLIENT_SECRET?.trim();
  const tenantId = process.env.CRM_MS365_TENANT_ID?.trim() ?? "common";

  if (!clientId || !clientSecret) {
    throw new Error(
      "MS365 integration requires CRM_MS365_CLIENT_ID and CRM_MS365_CLIENT_SECRET to be set.",
    );
  }

  return new ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  });
}

const MS365_SCOPES = [
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Calendars.Read",
  "https://graph.microsoft.com/User.Read",
  "offline_access",
];

// ============================================================================
// Auth flow
// ============================================================================

/** Run the interactive MS365 OAuth flow. Prints the URL and saves the token.
 *  Use `openclaw crm auth-ms365` to trigger this. */
export async function runMs365AuthFlow(tokenPath = defaultTokenPath()): Promise<void> {
  const msalApp = buildMsalApp();
  const redirectPort = 54321;
  const redirectUri = `http://localhost:${redirectPort}/`;

  const urlRequest: AuthorizationUrlRequest = {
    scopes: MS365_SCOPES,
    redirectUri,
  };

  const authUrl = await msalApp.getAuthCodeUrl(urlRequest);
  console.log("\n[crm-ms365] Open this URL in your browser to authorize MS365 access:\n");
  console.log(authUrl);
  console.log();

  // Start a one-shot local server to catch the redirect
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlObj = new URL(req.url ?? "/", `http://localhost:${redirectPort}`);
      const code = urlObj.searchParams.get("code");
      if (code) {
        res.end("Authorization successful. You may close this tab.");
        server.close();
        resolve(code);
      } else {
        const error = urlObj.searchParams.get("error_description") ?? "no code";
        res.end(`Error: ${error}`);
        server.close();
        reject(new Error(error));
      }
    });
    server.listen(redirectPort, "localhost");
    server.on("error", reject);
  });

  const tokenRequest: AuthorizationCodeRequest = {
    code,
    scopes: MS365_SCOPES,
    redirectUri,
  };

  const result = await msalApp.acquireTokenByCode(tokenRequest);
  if (!result?.accessToken) {
    throw new Error("MS365 auth: no access token returned");
  }

  const tokenCache: TokenCache = {
    accessToken: result.accessToken,
    expiresOn: result.expiresOn?.getTime() ?? Date.now() + 3600_000,
  };

  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(tokenCache, null, 2));
  console.log(`[crm-ms365] Token saved to ${tokenPath}`);
}

// ============================================================================
// Token loading + refresh
// ============================================================================

function loadCachedToken(tokenPath: string): TokenCache | null {
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(tokenPath, "utf8")) as TokenCache;
  } catch {
    return null;
  }
}

async function getValidAccessToken(tokenPath: string): Promise<string | null> {
  const cached = loadCachedToken(tokenPath);
  if (!cached) {
    return null;
  }

  // If token is still valid with 5-minute buffer, return it
  if (cached.expiresOn > Date.now() + 5 * 60_000) {
    return cached.accessToken;
  }

  // Token expired — attempt silent refresh via MSAL
  try {
    const msalApp = buildMsalApp();
    const accounts = await msalApp.getTokenCache().getAllAccounts();
    if (accounts.length > 0) {
      const result = await msalApp.acquireTokenSilent({
        account: accounts[0],
        scopes: MS365_SCOPES,
      });
      if (result?.accessToken) {
        const updated: TokenCache = {
          accessToken: result.accessToken,
          expiresOn: result.expiresOn?.getTime() ?? Date.now() + 3600_000,
        };
        fs.writeFileSync(tokenPath, JSON.stringify(updated, null, 2));
        return updated.accessToken;
      }
    }
  } catch {
    // Silent refresh failed — token is stale, user must re-auth
  }

  return null;
}

// ============================================================================
// Graph API helpers
// ============================================================================

async function graphRequest<T>(
  accessToken: string,
  path: string,
  method: "GET" | "POST" | "PATCH" = "GET",
  body?: object,
): Promise<T> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph API ${method} ${path} failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<T>;
}

// ============================================================================
// MS365 EmailProvider implementation
// ============================================================================

class Ms365EmailProvider implements EmailProvider {
  constructor(private tokenPath: string) {}

  private async token(): Promise<string> {
    const t = await getValidAccessToken(this.tokenPath);
    if (!t) {
      throw new Error("MS365 token unavailable — run `openclaw crm auth-ms365`");
    }
    return t;
  }

  async fetchRecentMessages(since: Date, limit = 200): Promise<EmailMessage[]> {
    const token = await this.token();
    const filter = `receivedDateTime ge ${since.toISOString()}`;
    const select =
      "id,conversationId,from,toRecipients,subject,bodyPreview,receivedDateTime,internetMessageHeaders";
    const top = Math.min(limit, 1000);

    type GraphMessage = {
      id: string;
      conversationId?: string;
      from?: { emailAddress?: { name?: string; address?: string } };
      toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
      subject?: string;
      bodyPreview?: string;
      receivedDateTime?: string;
      internetMessageHeaders?: Array<{ name: string; value: string }>;
    };

    const data = await graphRequest<{ value: GraphMessage[] }>(
      token,
      `/me/messages?$filter=${encodeURIComponent(filter)}&$select=${select}&$top=${top}`,
    );

    return (data.value ?? []).map((m) => {
      const listUnsub = (m.internetMessageHeaders ?? []).some(
        (h) => h.name.toLowerCase() === "list-unsubscribe",
      );
      return {
        messageId: m.id,
        threadId: m.conversationId,
        from: {
          name: m.from?.emailAddress?.name,
          email: (m.from?.emailAddress?.address ?? "").toLowerCase(),
        },
        to: (m.toRecipients ?? []).map((r) => ({
          name: r.emailAddress?.name,
          email: (r.emailAddress?.address ?? "").toLowerCase(),
        })),
        subject: m.subject ?? "",
        snippet: m.bodyPreview ?? "",
        date: m.receivedDateTime ? new Date(m.receivedDateTime) : new Date(),
        listUnsubscribe: listUnsub,
      };
    });
  }

  async fetchThread(threadId: string): Promise<EmailThread> {
    const token = await this.token();
    const filter = `conversationId eq '${threadId}'`;
    const select = "from,body,receivedDateTime";

    type GraphMessage = {
      from?: { emailAddress?: { name?: string; address?: string } };
      body?: { content?: string };
      receivedDateTime?: string;
    };

    const data = await graphRequest<{ value: GraphMessage[] }>(
      token,
      `/me/messages?$filter=${encodeURIComponent(filter)}&$select=${select}&$orderby=receivedDateTime`,
    );

    return {
      threadId,
      messages: (data.value ?? []).map((m) => ({
        from: m.from?.emailAddress?.address ?? "",
        body: (m.body?.content ?? "").replace(/<[^>]+>/g, "").slice(0, 2000),
        date: m.receivedDateTime ? new Date(m.receivedDateTime) : new Date(),
      })),
    };
  }

  async createDraft(opts: DraftOptions): Promise<string> {
    const token = await this.token();

    type GraphDraft = { id: string };
    const draft = await graphRequest<GraphDraft>(token, "/me/mailFolders/drafts/messages", "POST", {
      subject: opts.subject,
      body: { contentType: "Text", content: opts.body },
      toRecipients: [{ emailAddress: { address: opts.to } }],
      ...(opts.threadId ? { conversationId: opts.threadId } : {}),
    });

    return draft.id;
  }
}

/** Create an MS365 EmailProvider. Loads the token from disk automatically.
 *  Returns null if no token is available (user hasn't run auth-ms365 yet). */
export function createMs365Provider(tokenPath = defaultTokenPath()): EmailProvider | null {
  const cached = loadCachedToken(tokenPath);
  if (!cached) {
    return null;
  }
  return new Ms365EmailProvider(tokenPath);
}

/** Check whether a valid MS365 token exists on disk. */
export function hasMs365Token(tokenPath = defaultTokenPath()): boolean {
  return loadCachedToken(tokenPath) !== null;
}
