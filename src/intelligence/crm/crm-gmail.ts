import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { gmail_v1 } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";
import type { CalendarProvider, EmailMessage, EmailProvider, EmailThread } from "./crm-provider.js";

// ============================================================================
// Token paths
// ============================================================================

function defaultCredentialsPath(): string {
  const env = process.env.CRM_GMAIL_CREDENTIALS?.trim();
  if (env) {
    return path.resolve(env);
  }
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "crm", "gmail-credentials.json");
}

function defaultTokenPath(): string {
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "crm", "gmail-token.json");
}

// ============================================================================
// OAuth2 client
// ============================================================================

type CredentialsFile = {
  installed?: { client_id: string; client_secret: string; redirect_uris: string[] };
  web?: { client_id: string; client_secret: string; redirect_uris: string[] };
};

function loadOAuth2Client(credentialsPath: string): OAuth2Client {
  const raw = fs.readFileSync(credentialsPath, "utf8");
  const creds = JSON.parse(raw) as CredentialsFile;
  const { client_id, client_secret, redirect_uris } = creds.installed ?? creds.web ?? {};
  if (!client_id || !client_secret) {
    throw new Error(`Invalid Gmail credentials file at ${credentialsPath}`);
  }
  const redirectUri = redirect_uris?.[0] ?? "urn:ietf:wg:oauth:2.0:oob";
  return new OAuth2Client(client_id, client_secret, redirectUri);
}

/** Load an existing token from disk into the OAuth2Client, or return null if absent. */
export function loadGmailOAuthClient(
  credentialsPath = defaultCredentialsPath(),
  tokenPath = defaultTokenPath(),
): OAuth2Client | null {
  if (!fs.existsSync(credentialsPath)) {
    return null;
  }
  if (!fs.existsSync(tokenPath)) {
    return null;
  }

  const client = loadOAuth2Client(credentialsPath);
  const token = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as object;
  client.setCredentials(token);
  return client;
}

/** Run the interactive OAuth2 flow. Prints the URL and waits for the redirect code.
 *  Saves the token to disk. Use `openclaw crm auth-gmail` to trigger this. */
export async function runGmailAuthFlow(
  credentialsPath = defaultCredentialsPath(),
  tokenPath = defaultTokenPath(),
): Promise<OAuth2Client> {
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(
      `Gmail credentials file not found at ${credentialsPath}.\n` +
        `Download it from the Google Cloud Console and save it there,\n` +
        `or set CRM_GMAIL_CREDENTIALS to its path.`,
    );
  }

  const client = loadOAuth2Client(credentialsPath);
  const scopes = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ];

  // Use loopback redirect for local OAuth capture
  const redirectUri = "http://localhost:0";
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    redirect_uri: redirectUri,
  });
  console.log("\n[crm-gmail] Open this URL in your browser to authorize Gmail access:\n");
  console.log(authUrl);
  console.log();

  // Start a temporary local HTTP server to capture the redirect
  const code = await captureAuthCode();

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`[crm-gmail] Token saved to ${tokenPath}`);
  return client;
}

/** Start a one-shot HTTP server on a random port to capture the OAuth redirect code. */
async function captureAuthCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlObj = new URL(req.url ?? "/", "http://localhost");
      const code = urlObj.searchParams.get("code");
      if (code) {
        res.end("Authorization successful. You may close this tab.");
        server.close();
        resolve(code);
      } else {
        res.end("Missing code parameter.");
        server.close();
        reject(new Error("No code in redirect"));
      }
    });
    server.listen(0, "localhost", () => {
      const address = server.address() as { port: number };
      console.log(`[crm-gmail] Listening for OAuth redirect on http://localhost:${address.port}/`);
    });
    server.on("error", reject);
  });
}

// ============================================================================
// Message parsing helpers
// ============================================================================

function decodeBase64Url(encoded: string): string {
  return Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseEmailAddress(raw: string): { name?: string; email: string } {
  // "Alice Smith <alice@example.com>" or "alice@example.com"
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim() || undefined, email: match[2].trim().toLowerCase() };
  }
  return { email: raw.trim().toLowerCase() };
}

function extractBodyText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) {
    return "";
  }
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    for (const sub of part.parts) {
      const text = extractBodyText(sub);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

// ============================================================================
// EmailProvider implementation
// ============================================================================

class GmailProvider implements EmailProvider {
  private gmail: gmail_v1.Gmail;

  constructor(auth: OAuth2Client) {
    this.gmail = new gmail_v1.Gmail({ auth });
  }

  async fetchRecentMessages(since: Date, limit = 200): Promise<EmailMessage[]> {
    const q = `after:${Math.floor(since.getTime() / 1000)} in:inbox`;
    const listRes = await this.gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: Math.min(limit, 500),
    });

    const messageIds = listRes.data.messages ?? [];
    const messages: EmailMessage[] = [];

    // Fetch in batches of 10 to avoid rate limits
    for (let i = 0; i < messageIds.length; i += 10) {
      const batch = messageIds.slice(i, i + 10);
      const fetched = await Promise.allSettled(
        batch.map((m) =>
          this.gmail.users.messages.get({
            userId: "me",
            id: m.id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date", "List-Unsubscribe"],
          }),
        ),
      );

      for (const result of fetched) {
        if (result.status !== "fulfilled") {
          continue;
        }
        const msg = result.value.data;
        const headers = msg.payload?.headers ?? [];

        const from = parseEmailAddress(getHeader(headers, "From"));
        const toRaw = getHeader(headers, "To");
        const to = toRaw ? toRaw.split(",").map((s) => parseEmailAddress(s.trim())) : [];
        const subject = getHeader(headers, "Subject");
        const dateStr = getHeader(headers, "Date");
        const listUnsub = !!getHeader(headers, "List-Unsubscribe");

        messages.push({
          messageId: msg.id!,
          threadId: msg.threadId ?? undefined,
          from,
          to,
          subject,
          snippet: msg.snippet ?? "",
          date: dateStr ? new Date(dateStr) : new Date(Number(msg.internalDate)),
          listUnsubscribe: listUnsub,
        });
      }
    }

    return messages;
  }

  async fetchThread(threadId: string): Promise<EmailThread> {
    const res = await this.gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });

    const msgs = res.data.messages ?? [];
    return {
      threadId,
      messages: msgs.map((m) => {
        const headers = m.payload?.headers ?? [];
        return {
          from: getHeader(headers, "From"),
          body: extractBodyText(m.payload).slice(0, 2000),
          date: new Date(Number(m.internalDate)),
        };
      }),
    };
  }

  async createDraft(opts: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
  }): Promise<string> {
    // Build MIME message
    const lines = [
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      opts.body,
    ];
    const raw = Buffer.from(lines.join("\r\n"))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const res = await this.gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw,
          ...(opts.threadId ? { threadId: opts.threadId } : {}),
        },
      },
    });
    return res.data.id ?? "";
  }
}

/** Create a Gmail EmailProvider from an authenticated OAuth2Client. */
export function createGmailProvider(auth: OAuth2Client): EmailProvider {
  return new GmailProvider(auth);
}

// ============================================================================
// Re-export CalendarProvider for Google Calendar (in crm-calendar-google.ts)
// kept separate to avoid importing the calendar API here
// ============================================================================
export type { CalendarProvider };
