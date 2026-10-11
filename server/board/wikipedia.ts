import type { TileImage } from "../../src/shared/board";

// Wikimedia asks API clients to identify themselves; no personal contact info.
const USER_AGENT = "speaker-board/0.1 (conversation display installation)";
const TIMEOUT_MS = 6000;

export interface WikiPage {
  title: string; // canonical title, after redirects
  description?: string;
  extract: string;
  url: string;
  image?: TileImage;
  disambiguation: boolean;
}

export interface WikiHit {
  title: string;
  snippet: string;
}

interface SummaryResponse {
  type?: string;
  title: string;
  description?: string;
  extract?: string;
  thumbnail?: { source: string };
  content_urls?: { desktop?: { page?: string } };
}

const pages = new Map<string, Promise<WikiPage | null>>();

/**
 * Article summary by exact title (redirects followed): description, lead
 * paragraph, and lead image. This is the only way an image reaches the board —
 * the agent names an article, never a URL. Results, including misses, are cached
 * for the life of the process.
 */
export function lookup(title: string): Promise<WikiPage | null> {
  const key = title.trim().replace(/ /g, "_");
  let page = pages.get(key);
  if (!page) {
    page = fetchSummary(key);
    pages.set(key, page);
    page.catch(() => pages.delete(key)); // transient failures may be retried
  }
  return page;
}

async function fetchSummary(key: string): Promise<WikiPage | null> {
  const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(key)}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Wikipedia summary ${res.status}`);
  const s = (await res.json()) as SummaryResponse;
  const url = s.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(key)}`;
  return {
    title: s.title,
    description: s.description,
    extract: s.extract ?? "",
    url,
    image: s.thumbnail ? { url: s.thumbnail.source, alt: s.title, pageUrl: url } : undefined,
    disambiguation: s.type === "disambiguation",
  };
}

/** Full-text article search, for when the agent doesn't know the exact title. */
export async function search(query: string): Promise<WikiHit[]> {
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: "5",
    format: "json",
  });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Wikipedia search ${res.status}`);
  const body = (await res.json()) as { query?: { search?: { title: string; snippet: string }[] } };
  return (body.query?.search ?? []).map((h) => ({
    title: h.title,
    snippet: h.snippet.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
  }));
}
