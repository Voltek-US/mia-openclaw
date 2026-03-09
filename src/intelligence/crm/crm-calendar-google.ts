import { calendar_v3 } from "@googleapis/calendar";
import type { OAuth2Client } from "google-auth-library";
import type { CalendarEvent, CalendarProvider } from "./crm-provider.js";

/** Maximum attendees before a meeting is considered "large" and skipped. */
const MAX_ATTENDEES = 10;

class GoogleCalendarProvider implements CalendarProvider {
  private cal: calendar_v3.Calendar;

  constructor(auth: OAuth2Client) {
    this.cal = new calendar_v3.Calendar({ auth });
  }

  async fetchRecentEvents(since: Date): Promise<CalendarEvent[]> {
    const res = await this.cal.events.list({
      calendarId: "primary",
      timeMin: since.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 500,
    });

    const items = res.data.items ?? [];
    const events: CalendarEvent[] = [];

    for (const item of items) {
      // Skip all-day events (no dateTime, only date)
      if (!item.start?.dateTime) {
        continue;
      }

      const attendees = (item.attendees ?? [])
        .map((a) => a.email?.toLowerCase())
        .filter((e): e is string => !!e);

      // Skip if no attendees or too many (large meeting)
      if (attendees.length === 0 || attendees.length > MAX_ATTENDEES) {
        continue;
      }

      events.push({
        eventId: item.id ?? `${item.start.dateTime}-${item.summary}`,
        title: item.summary ?? "(no title)",
        startTime: new Date(item.start.dateTime),
        endTime: new Date(item.end?.dateTime ?? item.start.dateTime),
        attendees,
      });
    }

    return events;
  }
}

/** Create a Google Calendar provider from an authenticated OAuth2Client. */
export function createGoogleCalendarProvider(auth: OAuth2Client): CalendarProvider {
  return new GoogleCalendarProvider(auth);
}
