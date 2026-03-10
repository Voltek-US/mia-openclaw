import type { OpenClawPluginApi } from "openclaw/plugin-sdk/knowledge-base";
import { registerAddCommand } from "./cli/add.js";
import { registerDeleteCommand } from "./cli/delete.js";
import { registerGetCommand } from "./cli/get.js";
import { registerIngestCommand } from "./cli/ingest.js";
import { registerListCommand } from "./cli/list.js";
import { registerQueryCommand } from "./cli/query.js";
import { registerStatusCommand } from "./cli/status.js";

const knowledgeBasePlugin = {
  id: "knowledge-base",
  name: "Knowledge Base",
  description:
    "RAG knowledge base — ingest URLs, how-tos, prompts, and known issues; query with semantic search",
  kind: "kb",

  register(api: OpenClawPluginApi) {
    api.registerCli(
      ({ program, config }) => {
        const kb = program
          .command("kb")
          .description("Knowledge base commands (ingest, query, manage)");

        registerIngestCommand(kb, config);
        registerAddCommand(kb, config);
        registerQueryCommand(kb, config);
        registerGetCommand(kb);
        registerListCommand(kb);
        registerDeleteCommand(kb);
        registerStatusCommand(kb, config);
      },
      { commands: ["kb"] },
    );
  },
};

export default knowledgeBasePlugin;
