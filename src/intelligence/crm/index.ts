// CRM module barrel — re-exports all public APIs

export * from "./crm-store.js";
export * from "./crm-scorer.js";
export * from "./crm-nudge.js";
export * from "./crm-profiler.js";
export * from "./crm-provider.js";
export * from "./crm-discover.js";
export * from "./crm-draft.js";

// Gmail
export { createGmailProvider, loadGmailOAuthClient, runGmailAuthFlow } from "./crm-gmail.js";
export { createGoogleCalendarProvider } from "./crm-calendar-google.js";

// MS365
export { createMs365Provider, hasMs365Token, runMs365AuthFlow } from "./crm-msgraph.js";
export { createMs365CalendarProvider } from "./crm-calendar-ms365.js";
