import type { OpenClawConfig } from "openclaw/plugin-sdk/knowledge-base";
import {
  createEmbeddingProvider,
  DEFAULT_LOCAL_MODEL,
  type EmbeddingProvider,
} from "openclaw/plugin-sdk/knowledge-base";

export type KbEmbedder = {
  provider: EmbeddingProvider | null;
  vecAvailable: boolean;
  /** Embedding vector dimension, or null if no provider available. */
  dims: number | null;
  embedQuery: (text: string) => Promise<number[] | null>;
  embedBatch: (texts: string[]) => Promise<Array<number[] | null>>;
};

export type KbEmbedOptions = {
  /** Embedding provider to use. Defaults to "auto" (local → remote fallback). */
  provider?: string;
  config: OpenClawConfig;
};

/**
 * Create a KbEmbedder that wraps the OpenClaw embedding provider factory.
 * Falls back to a no-op embedder (vecAvailable=false) if no provider is available,
 * allowing the KB to operate in FTS-only mode.
 */
export async function createKbEmbedder(opts: KbEmbedOptions): Promise<KbEmbedder> {
  const requestedProvider = (opts.provider as "auto") ?? "auto";

  try {
    const result = await createEmbeddingProvider({
      config: opts.config,
      provider: requestedProvider,
      model: DEFAULT_LOCAL_MODEL,
      fallback: "none",
      local: { modelPath: DEFAULT_LOCAL_MODEL },
    });

    if (!result.provider) {
      return makeNullEmbedder(result.providerUnavailableReason);
    }

    // Probe the dimension by embedding a short test string.
    let dims: number | null = null;
    try {
      const probe = await result.provider.embedQuery("probe");
      dims = probe.length;
    } catch {
      return makeNullEmbedder("Embedding provider probe failed");
    }

    const provider = result.provider;

    return {
      provider,
      vecAvailable: true,
      dims,
      async embedQuery(text) {
        try {
          return await provider.embedQuery(text);
        } catch {
          return null;
        }
      },
      async embedBatch(texts) {
        try {
          const results = await provider.embedBatch(texts);
          return results.map((r) => r ?? null);
        } catch {
          return texts.map(() => null);
        }
      },
    };
  } catch {
    return makeNullEmbedder("No embedding provider available");
  }
}

function makeNullEmbedder(reason?: string): KbEmbedder {
  if (reason) {
    process.stderr.write(`KB embedder: ${reason}. Operating in FTS-only mode.\n`);
  }
  return {
    provider: null,
    vecAvailable: false,
    dims: null,
    async embedQuery() {
      return null;
    },
    async embedBatch(texts) {
      return texts.map(() => null);
    },
  };
}
