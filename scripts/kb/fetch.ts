/**
 * URL fetching per source type.
 *
 * Detects source type from URL patterns, then extracts clean text:
 *   - article / generic: fetch HTML → linkedom + Readability
 *   - tweet: Twitter oEmbed API (no auth required)
 *   - youtube: YouTube oEmbed API + description from page
 *   - pdf: pdfjs-dist text extraction
 *
 * All fetches enforce a 30-second timeout and a 10 MB body cap.
 */
import type { FetchedContent, SourceType } from "./types.ts";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

/** Detect source type from URL. */
export function detectSourceType(url: string): SourceType {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "twitter.com" || host === "x.com") {
      return "tweet";
    }
    if (host === "youtube.com" || host === "youtu.be") {
      return "youtube";
    }
    if (u.pathname.toLowerCase().endsWith(".pdf")) {
      return "pdf";
    }
    const ct = u.searchParams.get("content-type") ?? "";
    if (ct.includes("pdf")) {
      return "pdf";
    }
  } catch {
    /* fall through */
  }
  return "article";
}

/** Fetch with abort signal. */
async function fetchWithLimits(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyCapped(res: Response): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) {
    return new Uint8Array(0);
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// ── Article / HTML ────────────────────────────────────────────────────────────

async function fetchArticle(url: string): Promise<FetchedContent> {
  const res = await fetchWithLimits(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenClaw-KB/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }

  const bytes = await readBodyCapped(res);
  const html = new TextDecoder().decode(bytes);

  // Use linkedom + Readability (already in repo deps).
  let linkedom: { parseHTML: (html: string) => { document: Document } };
  let Readability: new (doc: Document) => {
    parse(): { title: string; textContent: string } | null;
  };
  try {
    linkedom = (await import("linkedom")) as typeof linkedom;
    const readabilityMod = (await import("@mozilla/readability")) as {
      Readability: typeof Readability;
    };
    Readability = readabilityMod.Readability;
  } catch {
    throw new Error("linkedom or @mozilla/readability not installed. Run: pnpm install");
  }

  const { document } = linkedom.parseHTML(html);
  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();

  if (!article) {
    // Fall back to stripping all tags from the raw HTML.
    const text = html
      .replace(/<[^>]{0,2000}>/g, " ")
      .replace(/\s{3,}/g, "\n")
      .trim();
    return { title: new URL(url).hostname, text, sourceType: "article" };
  }

  return {
    title: article.title.trim() || new URL(url).hostname,
    text: article.textContent.replace(/\s{3,}/g, "\n").trim(),
    sourceType: "article",
  };
}

// ── Tweet ─────────────────────────────────────────────────────────────────────

async function fetchTweet(url: string): Promise<FetchedContent> {
  // Twitter oEmbed requires no auth and returns HTML + author info.
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`;
  const res = await fetchWithLimits(oembedUrl);

  if (!res.ok) {
    // oEmbed may fail for protected/deleted tweets; fall back to article fetch.
    console.warn(`[kb:fetch] Twitter oEmbed failed (${res.status}); trying article fallback.`);
    return fetchArticle(url);
  }

  const data = (await res.json()) as {
    html: string;
    author_name?: string;
  };

  // Strip HTML tags from the embed HTML to get plain tweet text.
  const text = data.html
    .replace(/<[^>]{0,2000}>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, " ")
    .trim();

  const author = data.author_name ?? "Unknown";
  return {
    title: `Tweet by ${author}`,
    text,
    sourceType: "tweet",
  };
}

// ── YouTube ───────────────────────────────────────────────────────────────────

async function fetchYouTube(url: string): Promise<FetchedContent> {
  // YouTube oEmbed for title + author.
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const res = await fetchWithLimits(oembedUrl);

  let title = "YouTube video";
  let description = "";

  if (res.ok) {
    const data = (await res.json()) as { title?: string; author_name?: string };
    title = data.title ?? title;
    if (data.author_name) {
      title += ` by ${data.author_name}`;
    }
  }

  // Fetch the watch page to extract the description meta tag (best-effort).
  try {
    const pageRes = await fetchWithLimits(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenClaw-KB/1.0)" },
    });
    if (pageRes.ok) {
      const bytes = await readBodyCapped(pageRes);
      const html = new TextDecoder().decode(bytes);
      // description is in <meta name="description" content="...">
      const m = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']{0,2000})["']/i);
      if (m) {
        description = m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim();
      }
    }
  } catch {
    /* non-fatal */
  }

  const text = description
    ? `Title: ${title}\n\nDescription: ${description}`
    : `Title: ${title}\n\n(No description available — consider adding a transcript manually.)`;

  return { title, text, sourceType: "youtube" };
}

// ── PDF ───────────────────────────────────────────────────────────────────────

async function fetchPdf(url: string): Promise<FetchedContent> {
  const res = await fetchWithLimits(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenClaw-KB/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching PDF: ${url}`);
  }

  const bytes = await readBodyCapped(res);

  let pdfjsLib: {
    getDocument: (data: { data: Uint8Array }) => {
      promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<{
          getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
        }>;
        getMetadata: () => Promise<{ info?: { Title?: string } }>;
      }>;
    };
  };
  try {
    pdfjsLib = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as typeof pdfjsLib;
  } catch {
    throw new Error("pdfjs-dist not installed. Run: pnpm install");
  }

  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  const doc = await loadingTask.promise;

  // Extract title from PDF metadata.
  let title = "PDF document";
  try {
    const meta = await doc.getMetadata();
    if (meta.info?.Title) {
      title = meta.info.Title;
    }
  } catch {
    /* no metadata */
  }

  // Extract text page by page.
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: { str?: string }) => item.str ?? "")
      .join(" ")
      .replace(/\s{3,}/g, " ")
      .trim();
    if (pageText) {
      pages.push(pageText);
    }
  }

  return {
    title,
    text: pages.join("\n\n"),
    sourceType: "pdf",
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch and extract text content from a URL.
 * Auto-detects source type; can be overridden via `forcedType`.
 */
export async function fetchContent(url: string, forcedType?: SourceType): Promise<FetchedContent> {
  const sourceType = forcedType ?? detectSourceType(url);
  switch (sourceType) {
    case "tweet":
      return fetchTweet(url);
    case "youtube":
      return fetchYouTube(url);
    case "pdf":
      return fetchPdf(url);
    default:
      return fetchArticle(url);
  }
}
