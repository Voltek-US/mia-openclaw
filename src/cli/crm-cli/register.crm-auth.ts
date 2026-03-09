import type { Command } from "commander";

export function registerCrmAuthCommands(parent: Command): void {
  parent
    .command("auth-gmail")
    .description("Authorize Gmail + Google Calendar access (opens OAuth URL, saves token)")
    .action(async () => {
      const { runGmailAuthFlow } = await import("../../intelligence/crm/crm-gmail.js");
      await runGmailAuthFlow();
    });

  parent
    .command("auth-ms365")
    .description(
      "Authorize Microsoft 365 (Outlook + Calendar) access (opens OAuth URL, saves token)",
    )
    .action(async () => {
      const { runMs365AuthFlow } = await import("../../intelligence/crm/crm-msgraph.js");
      await runMs365AuthFlow();
    });
}
