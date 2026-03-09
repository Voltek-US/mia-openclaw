/**
 * Text chunking for the RAG ingestion pipeline.
 *
 * Strategy: sentence-aware sliding window.
 *   - Target chunk size: ~400 words (~512 tokens for most embedding models).
 *   - Overlap: ~40 words to preserve context across chunk boundaries.
 *   - Splits on paragraph / sentence boundaries when possible.
 */

const TARGET_WORDS = 400;
const OVERLAP_WORDS = 40;

/** Rough token count estimate (English ~1.3 tokens/word). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
}

/**
 * Split text into overlapping chunks.
 * Returns an array of { content, tokenCount } objects.
 */
export function chunkText(text: string): Array<{ content: string; tokenCount: number }> {
  // Normalize whitespace.
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) {
    return [];
  }

  // Split into paragraphs first, then sentences within long paragraphs.
  const sentences = splitIntoSentences(normalized);
  if (sentences.length === 0) {
    return [];
  }

  const chunks: Array<{ content: string; tokenCount: number }> = [];
  let i = 0;

  while (i < sentences.length) {
    const windowSentences: string[] = [];
    let wordCount = 0;

    // Fill a chunk up to TARGET_WORDS.
    let j = i;
    while (j < sentences.length && wordCount < TARGET_WORDS) {
      const words = sentences[j].split(/\s+/).length;
      windowSentences.push(sentences[j]);
      wordCount += words;
      j++;
    }

    const content = windowSentences.join(" ").trim();
    if (content.length > 0) {
      chunks.push({ content, tokenCount: estimateTokens(content) });
    }

    // Advance by (TARGET_WORDS - OVERLAP_WORDS) words.
    let advanceWords = 0;
    let advance = 0;
    while (advance < windowSentences.length && advanceWords < TARGET_WORDS - OVERLAP_WORDS) {
      advanceWords += windowSentences[advance].split(/\s+/).length;
      advance++;
    }
    i += Math.max(advance, 1); // Always advance at least one sentence.
  }

  return chunks;
}

/**
 * Split text into sentence-like segments, respecting paragraph boundaries.
 * We keep sentences as the atomic unit so chunks never split mid-sentence.
 */
function splitIntoSentences(text: string): string[] {
  const results: string[] = [];

  // First split on double-newlines (paragraphs).
  const paragraphs = text.split(/\n\n+/);

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      continue;
    }

    // Split into sentences on [.!?] followed by whitespace + uppercase.
    // Handles common abbreviations by requiring the next char to be uppercase.
    const sentenceRe = /(?<=[.!?])\s+(?=[A-Z"'([])/g;
    const parts = trimmed
      .split(sentenceRe)
      .map((s) => s.trim())
      .filter(Boolean);

    // If a part is very long (> 2× target), split on commas / semicolons.
    for (const part of parts) {
      if (part.split(/\s+/).length > TARGET_WORDS * 2) {
        const subParts = part
          .split(/[;,]\s+/)
          .map((s) => s.trim())
          .filter(Boolean);
        results.push(...subParts);
      } else {
        results.push(part);
      }
    }
  }

  return results;
}
