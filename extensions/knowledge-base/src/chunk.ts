export type TextChunk = {
  text: string;
  tokenCount: number;
  chunkIdx: number;
};

export type ChunkOptions = {
  /** Target chunk size in tokens (approximate). Default: 512. */
  chunkTokens?: number;
  /** Overlap in tokens between consecutive chunks. Default: 128. */
  overlapTokens?: number;
};

/**
 * Rough token count estimate: ~4 chars per token.
 * Avoids pulling in a tokenizer dependency.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split text into overlapping chunks for embedding.
 * Tries to split on paragraph boundaries, then sentence boundaries,
 * then word boundaries — in that order — to avoid cutting mid-sentence.
 */
export function chunkText(text: string, opts?: ChunkOptions): TextChunk[] {
  const chunkTokens = opts?.chunkTokens ?? 512;
  const overlapTokens = opts?.overlapTokens ?? 128;
  const chunkChars = chunkTokens * 4;
  const overlapChars = overlapTokens * 4;

  const normalized = text.trim();
  if (!normalized) {
    return [];
  }

  if (estimateTokenCount(normalized) <= chunkTokens) {
    return [{ text: normalized, tokenCount: estimateTokenCount(normalized), chunkIdx: 0 }];
  }

  // Split into paragraphs first.
  const paragraphs = splitIntoParagraphs(normalized);
  const segments = mergeSegments(paragraphs, chunkChars);

  const chunks: TextChunk[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    // Add overlap from the tail of the previous chunk.
    let chunkText = segment;
    if (i > 0 && overlapChars > 0) {
      const prev = segments[i - 1];
      const overlapSlice = tailChars(prev, overlapChars);
      chunkText = `${overlapSlice} ${segment}`.trim();
    }
    chunks.push({
      text: chunkText,
      tokenCount: estimateTokenCount(chunkText),
      chunkIdx: i,
    });
  }

  return chunks;
}

/** Split text on double-newlines (paragraph boundaries). */
function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Merge short segments and split long ones to target ~chunkChars per segment.
 * Long paragraphs are split on sentence boundaries (". "), then on spaces.
 */
function mergeSegments(segments: string[], targetChars: number): string[] {
  const result: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) {
      result.push(current.trim());
      current = "";
    }
  };

  for (const seg of segments) {
    if (seg.length > targetChars) {
      // Flush pending content first.
      flush();
      // Split long segment on sentence boundaries.
      const sentences = splitOnSentences(seg);
      for (const sentence of sentences) {
        if (current.length + sentence.length + 1 > targetChars) {
          flush();
        }
        current = current ? `${current} ${sentence}` : sentence;
      }
    } else if (current.length + seg.length + 2 > targetChars) {
      flush();
      current = seg;
    } else {
      current = current ? `${current}\n\n${seg}` : seg;
    }
  }
  flush();

  return result;
}

/** Split on sentence-ending punctuation followed by whitespace. */
function splitOnSentences(text: string): string[] {
  // Split after ". ", "! ", "? " but keep the punctuation on the left side.
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Return the last `n` characters of a string (word-boundary safe). */
function tailChars(text: string, n: number): string {
  if (text.length <= n) {
    return text;
  }
  const slice = text.slice(-n);
  // Trim to word boundary.
  const wordBoundary = slice.indexOf(" ");
  if (wordBoundary > 0) {
    return slice.slice(wordBoundary + 1);
  }
  return slice;
}
