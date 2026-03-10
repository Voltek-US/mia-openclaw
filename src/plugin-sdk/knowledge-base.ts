// Re-exports for the knowledge-base extension.
export type { OpenClawPluginApi } from "../plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";
export { requireNodeSqlite } from "../memory/sqlite.js";
export { loadSqliteVecExtension } from "../memory/sqlite-vec.js";
export {
  createEmbeddingProvider,
  DEFAULT_LOCAL_MODEL,
  type EmbeddingProvider,
  type EmbeddingProviderOptions,
  type EmbeddingProviderResult,
} from "../memory/embeddings.js";
export { withFileLock, type FileLockOptions } from "./file-lock.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
