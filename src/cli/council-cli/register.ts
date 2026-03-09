import type { Command } from "commander";
import { registerCouncilFeedbackCommand } from "./register.council-feedback.js";
import { registerCouncilRecsCommand } from "./register.council-recs.js";
import { registerCouncilRunCommand } from "./register.council-run.js";
import { registerCouncilStatusCommand } from "./register.council-status.js";
import { registerCouncilSyncCommand } from "./register.council-sync.js";

export function registerCouncilCli(program: Command): void {
  const council = program
    .command("council")
    .description("Business Intelligence Council — nightly expert analysis and recommendations");

  registerCouncilRunCommand(council);
  registerCouncilStatusCommand(council);
  registerCouncilRecsCommand(council);
  registerCouncilFeedbackCommand(council);
  registerCouncilSyncCommand(council);
}
