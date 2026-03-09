import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CalendarEvent, CalendarProvider } from "./crm-provider.js";

/** Maximum attendees before a meeting is considered "large" and skipped. */
const MAX_ATTENDEES = 10;

function defaultTokenPath(): string {
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "crm", "ms365-token.json");
}

type TokenCache = { accessToken: string; expiresOn: number };

function loadToken(tokenPath: string): string | null {
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  try {
    const cache = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as TokenCache;
    if (cache.expiresOn < Date.now()) {
      return null;
    }
    return cache.accessToken;
  } catch {
    return null;
  }
}

type GraphEvent = {
  id?: string;
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  isAllDay?: boolean;
  attendees?: Array<{ emailAddress?: { address?: string } }>;
};

class Ms365CalendarProvider implements CalendarProvider {
  constructor(private tokenPath: string) {}

  async fetchRecentEvents(since: Date): Promise<CalendarEvent[]> {
    const token = loadToken(this.tokenPath);
    if (!token) {
      throw new Error("MS365 token unavailable — run `openclaw crm auth-ms365`");
    }

    const filter = `start/dateTime ge '${since.toISOString()}'`;
    const select = "id,subject,start,end,isAllDay,attendees";

    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/events?$filter=${encodeURIComponent(filter)}&$select=${select}&$top=500`,
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      },
    );

    if (!res.ok) {
      throw new Error(`MS365 Calendar API failed (${res.status})`);
    }

    const data = (await res.json()) as { value: GraphEvent[] };
    const events: CalendarEvent[] = [];

    for (const item of data.value ?? []) {
      if (item.isAllDay) {
        continue;
      }
      if (!item.start?.dateTime) {
        continue;
      }

      const attendees = (item.attendees ?? [])
        .map((a) => a.emailAddress?.address?.toLowerCase())
        .filter((e): e is string => !!e);

      if (attendees.length === 0 || attendees.length > MAX_ATTENDEES) {
        continue;
      }

      events.push({
        eventId: item.id ?? `${item.start.dateTime}-${item.subject}`,
        title: item.subject ?? "(no title)",
        startTime: new Date(item.start.dateTime),
        endTime: new Date(item.end?.dateTime ?? item.start.dateTime),
        attendees,
      });
    }

    return events;
  }
}

/** Create an MS365 Calendar provider. Returns null if no token exists. */
export function createMs365CalendarProvider(
  tokenPath = defaultTokenPath(),
): CalendarProvider | null {
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  return new Ms365CalendarProvider(tokenPath);
}
