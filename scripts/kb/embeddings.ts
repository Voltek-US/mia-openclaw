/**
 * Local embedding generation using @xenova/transformers (ONNX runtime).
 *
 * Model: Xenova/all-MiniLM-L6-v2 (384-dim, ~22 MB, downloads on first use).
 * Models are cached in ~/.cache/huggingface/hub/ by default.
 *
 * Install the package before using:
 *   pnpm add -D @xenova/transformers
 *   # or: npm install @xenova/transformers
 */

// Lazy-initialised pipeline — avoid loading the model until first use.
let _pipeline: ((...args: unknown[]) => Promise<unknown>) | null = null;

const MODEL_NAME = process.env.OPENCLAW_KB_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const EMBED_DIM = 384; // all-MiniLM-L6-v2 output dimension

async function getPipeline(): Promise<(text: string) => Promise<Float32Array>> {
  if (_pipeline) {
    return _pipeline as (text: string) => Promise<Float32Array>;
  }

  // Dynamic import so the module is not required at startup.
  let transformers: { pipeline: (task: string, model: string) => Promise<unknown> };
  try {
    // @ts-expect-error — @xenova/transformers is an optional peer; install with: pnpm add -D @xenova/transformers
    transformers = (await import("@xenova/transformers")) as typeof transformers;
  } catch {
    throw new Error(
      "[kb:embeddings] @xenova/transformers is not installed.\n" +
        "Run: pnpm add -D @xenova/transformers\n" +
        "Or set OPENCLAW_KB_EMBED_MODEL to a compatible model.",
    );
  }

  console.log(`[kb:embeddings] Loading model ${MODEL_NAME} (downloads on first use) …`);
  const pipe = await transformers.pipeline("feature-extraction", MODEL_NAME);
  _pipeline = pipe as typeof _pipeline;

  return async (text: string): Promise<Float32Array> => {
    const output = await (pipe as (t: string, opts: object) => Promise<{ data: Float32Array }>)(
      text,
      { pooling: "mean", normalize: true },
    );
    return output.data;
  };
}

/**
 * Generate an embedding vector for a single text string.
 * Returns a normalized Float32Array of length EMBED_DIM.
 */
export async function embed(text: string): Promise<Float32Array> {
  const pipe = await getPipeline();
  return pipe(text);
}

/**
 * Generate embeddings for a batch of texts.
 * Processes sequentially to avoid OOM on large batches.
 */
export async function embedBatch(
  texts: string[],
  onProgress?: (i: number, total: number) => void,
): Promise<Float32Array[]> {
  const pipe = await getPipeline();
  const results: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    results.push(await pipe(texts[i]));
    onProgress?.(i + 1, texts.length);
  }
  return results;
}

/**
 * Cosine similarity between two normalized vectors.
 * Since vectors from all-MiniLM are L2-normalized, dot product == cosine similarity.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return Math.max(-1, Math.min(1, dot)); // clamp for floating-point drift
}

export { EMBED_DIM };
