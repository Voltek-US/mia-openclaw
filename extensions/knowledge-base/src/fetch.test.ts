import { describe, expect, it } from "vitest";
import { classifyUrl, validateUrlScheme } from "./fetch.js";

describe("classifyUrl", () => {
  it("classifies twitter.com as tweet", () => {
    expect(classifyUrl("https://twitter.com/user/status/123")).toBe("tweet");
  });

  it("classifies x.com as tweet", () => {
    expect(classifyUrl("https://x.com/user/status/123")).toBe("tweet");
  });

  it("classifies youtube.com as youtube", () => {
    expect(classifyUrl("https://www.youtube.com/watch?v=abc123")).toBe("youtube");
  });

  it("classifies youtu.be as youtube", () => {
    expect(classifyUrl("https://youtu.be/abc123")).toBe("youtube");
  });

  it("classifies .pdf extension as pdf", () => {
    expect(classifyUrl("https://example.com/document.pdf")).toBe("pdf");
  });

  it("classifies generic HTTP URLs as article", () => {
    expect(classifyUrl("https://example.com/blog/post")).toBe("article");
  });

  it("handles invalid URLs gracefully (defaults to article)", () => {
    expect(classifyUrl("not-a-url")).toBe("article");
  });
});

describe("validateUrlScheme", () => {
  it("accepts http URLs", () => {
    expect(() => validateUrlScheme("http://example.com")).not.toThrow();
  });

  it("accepts https URLs", () => {
    expect(() => validateUrlScheme("https://example.com")).not.toThrow();
  });

  it("rejects file:// URLs", () => {
    expect(() => validateUrlScheme("file:///etc/passwd")).toThrow(/Unsupported URL scheme/);
  });

  it("rejects ftp:// URLs", () => {
    expect(() => validateUrlScheme("ftp://example.com/file")).toThrow(/Unsupported URL scheme/);
  });

  it("rejects data: URLs", () => {
    expect(() => validateUrlScheme("data:text/html,<h1>Hi</h1>")).toThrow(/Unsupported URL scheme/);
  });

  it("rejects javascript: URLs", () => {
    expect(() => validateUrlScheme("javascript:alert(1)")).toThrow(/Unsupported URL scheme/);
  });

  it("throws for completely invalid URLs", () => {
    expect(() => validateUrlScheme("not-a-url")).toThrow();
  });
});
