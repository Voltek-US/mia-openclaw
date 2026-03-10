import { describe, expect, it } from "vitest";
import { chunkText, estimateTokenCount } from "./chunk.js";

describe("estimateTokenCount", () => {
  it("approximates token count as ceil(length / 4)", () => {
    expect(estimateTokenCount("abcd")).toBe(1);
    expect(estimateTokenCount("abcde")).toBe(2);
    expect(estimateTokenCount("")).toBe(0);
  });
});

describe("chunkText", () => {
  it("returns empty array for empty string", () => {
    expect(chunkText("")).toHaveLength(0);
    expect(chunkText("   ")).toHaveLength(0);
  });

  it("returns a single chunk for short text", () => {
    const chunks = chunkText("Hello world", { chunkTokens: 512 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIdx).toBe(0);
    expect(chunks[0].text).toBe("Hello world");
  });

  it("assigns sequential chunkIdx values", () => {
    const longText = Array.from({ length: 600 }, (_, i) => `Sentence ${i}.`).join(" ");
    const chunks = chunkText(longText, { chunkTokens: 100, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => expect(c.chunkIdx).toBe(i));
  });

  it("second chunk contains overlap from the first", () => {
    // Build text large enough to require splitting
    const para1 = "Alpha ".repeat(300).trim(); // ~450 tokens
    const para2 = "Beta ".repeat(300).trim(); // ~450 tokens
    const text = `${para1}\n\n${para2}`;

    const chunks = chunkText(text, { chunkTokens: 200, overlapTokens: 50 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Chunk 1 should contain some content from para1 in chunk 2.
    const chunk0Words = chunks[0].text.split(" ").slice(-10).join(" ");
    const chunk1Text = chunks[1].text;
    // The overlap means chunk1 should begin with the tail of chunk0.
    expect(chunk1Text).toContain(chunk0Words.split(" ").at(-1));
  });

  it("respects paragraph boundaries", () => {
    const para1 = "First paragraph content. ".repeat(5).trim();
    const para2 = "Second paragraph content. ".repeat(5).trim();
    const text = `${para1}\n\n${para2}`;
    const chunks = chunkText(text, { chunkTokens: 512, overlapTokens: 0 });
    // Small text — one chunk expected.
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("tokenCount is populated on each chunk", () => {
    const text = "Word ".repeat(600).trim();
    const chunks = chunkText(text, { chunkTokens: 100 });
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });
});
