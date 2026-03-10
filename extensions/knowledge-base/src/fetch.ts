import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/knowledge-base";

export type SourceType = "article" | "tweet" | "youtube" | "pdf" | "howto" | "prompt" | "issue";

export type FetchResult = {
  title: string;
  text: string;
  sourceType: SourceType;
  canonicalUrl: string;
};

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Validate that the URL uses http or https scheme.
 * Throws for file://, ftp://, data:, and other schemes.
 */
export function validateUrlScheme(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported URL scheme "${parsed.protocol.replace(":", "")}". Only http and https are allowed.`,
    );
  }
}

/** Classify a URL as a specific source type based on hostname and path. */
export function classifyUrl(url: string): SourceType {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "article";
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");

  if (host === "twitter.com" || host === "x.com") {
    return "tweet";
  }

  if (host === "youtube.com" || host === "youtu.be" || host === "m.youtube.com") {
    return "youtube";
  }

  if (
    parsed.pathname.toLowerCase().endsWith(".pdf") ||
    parsed.searchParams.get("format") === "pdf"
  ) {
    return "pdf";
  }

  return "article";
}

/**
 * Fetch and extract content from a URL.
 * Dispatches to the appropriate handler based on source type.
 * Uses SSRF-guarded fetch (no private IPs, DNS pinning).
 */
export async function fetchSource(url: string, signal?: AbortSignal): Promise<FetchResult> {
  validateUrlScheme(url);
  const sourceType = classifyUrl(url);

  switch (sourceType) {
    case "tweet":
      return fetchTweet(url, signal);
    case "youtube":
      return fetchYouTube(url, signal);
    case "pdf":
      return fetchPdf(url, signal);
    default:
      return fetchArticle(url, signal);
  }
}

// ============================================================================
// Article fetcher
// ============================================================================

async function fetchArticle(url: string, signal?: AbortSignal): Promise<FetchResult> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    mode: "strict",
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
  });

  try {
    const html = await response.text();
    const { title, text } = await extractReadableContent(html, url);
    return { title, text, sourceType: "article", canonicalUrl: url };
  } finally {
    await release();
  }
}

// Module-level lazy-load promises to avoid mixing static + dynamic imports.
let linkedomPromise: Promise<typeof import("linkedom")> | null = null;
let readabilityPromise: Promise<typeof import("@mozilla/readability")> | null = null;

async function loadLinkedom(): Promise<typeof import("linkedom")> {
  if (!linkedomPromise) {
    linkedomPromise = import("linkedom");
  }
  return linkedomPromise;
}

async function loadReadability(): Promise<typeof import("@mozilla/readability")> {
  if (!readabilityPromise) {
    readabilityPromise = import("@mozilla/readability");
  }
  return readabilityPromise;
}

async function extractReadableContent(
  html: string,
  url: string,
): Promise<{ title: string; text: string }> {
  try {
    const { parseHTML } = await loadLinkedom();
    const { document } = parseHTML(html);

    const { Readability } = await loadReadability();
    const reader = new Readability(document as unknown as Document);
    const article = reader.parse();

    if (article) {
      const text = stripHtmlTags(article.textContent ?? article.content ?? "");
      return { title: article.title || extractOgTitle(html) || url, text };
    }
  } catch {
    // Fall through to OG meta extraction.
  }

  // Fallback: extract og:title and og:description.
  const title = extractOgTitle(html) || url;
  const text = extractOgDescription(html) || "";
  return { title, text };
}

// ============================================================================
// Tweet fetcher
// ============================================================================

async function fetchTweet(url: string, signal?: AbortSignal): Promise<FetchResult> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    mode: "strict",
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
    init: {
      headers: {
        // Use a standard browser UA so Twitter serves HTML.
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        Accept: "text/html,application/xhtml+xml",
      },
    },
  });

  try {
    const html = await response.text();

    // Extract tweet text from og:description (most reliable without API).
    const description = extractOgDescription(html);
    const title = extractOgTitle(html) || "Tweet";

    return {
      title,
      text: description || `Tweet from ${url}`,
      sourceType: "tweet",
      canonicalUrl: url,
    };
  } finally {
    await release();
  }
}

// ============================================================================
// YouTube fetcher
// ============================================================================

async function fetchYouTube(url: string, signal?: AbortSignal): Promise<FetchResult> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    mode: "strict",
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
    init: {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
  });

  let html: string;
  try {
    html = await response.text();
  } finally {
    await release();
  }

  const title = extractOgTitle(html) || "YouTube Video";
  const description = extractOgDescription(html) || "";

  // Try to fetch auto-generated captions via ytInitialData.
  try {
    const transcript = await fetchYouTubeCaptions(html, signal);
    if (transcript) {
      return {
        title,
        text: `${description}\n\nTranscript:\n${transcript}`.trim(),
        sourceType: "youtube",
        canonicalUrl: url,
      };
    }
  } catch {
    // Caption extraction is best-effort; fall back to title+description.
  }

  return {
    title,
    text: description || `YouTube video: ${title}`,
    sourceType: "youtube",
    canonicalUrl: url,
  };
}

async function fetchYouTubeCaptions(html: string, signal?: AbortSignal): Promise<string | null> {
  // Find caption track URL in ytInitialPlayerResponse.
  const captionMatch = html.match(/"captionTracks":\s*\[.*?"baseUrl":\s*"([^"]+)"/);
  if (!captionMatch) {
    return null;
  }

  // Unescape unicode sequences.
  const captionUrl = captionMatch[1].replace(/\\u0026/g, "&").replace(/\\u003d/g, "=");

  const { response, release } = await fetchWithSsrFGuard({
    url: captionUrl,
    mode: "strict",
    timeoutMs: 10_000,
    signal,
  });

  try {
    const xml = await response.text();
    // Strip XML tags to get plain text.
    return xml
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    await release();
  }
}

// ============================================================================
// PDF fetcher
// ============================================================================

async function fetchPdf(url: string, signal?: AbortSignal): Promise<FetchResult> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    mode: "strict",
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
  });

  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } finally {
    await release();
  }

  const text = await extractPdfText(buffer);
  // Use URL pathname as title fallback.
  const filename =
    new URL(url).pathname.split("/").filter(Boolean).pop()?.replace(".pdf", "") ?? url;

  return {
    title: filename,
    text: text || `PDF from ${url}`,
    sourceType: "pdf",
    canonicalUrl: url,
  };
}

// Lazy-load pdfjs to keep startup light.
type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfJsPromise: Promise<PdfJsModule> | null = null;

function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((err) => {
      pdfJsPromise = null;
      throw new Error(`pdfjs-dist is required for PDF extraction: ${String(err)}`);
    });
  }
  return pdfJsPromise;
}

async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const { getDocument } = await loadPdfJs();

  const pdf = await getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
  }).promise;

  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? String(item.str) : ""))
      .filter(Boolean)
      .join(" ");
    pages.push(pageText);
  }

  return pages.join("\n\n");
}

// ============================================================================
// HTML helpers
// ============================================================================

function extractOgTitle(html: string): string {
  const match =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? decodeHtmlEntities(match[1].trim()) : "";
}

function extractOgDescription(html: string): string {
  const match =
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return match ? decodeHtmlEntities(match[1].trim()) : "";
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
