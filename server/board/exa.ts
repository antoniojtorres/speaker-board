// Exa web search (https://exa.ai/docs/search/quickstart), called with the
// installation's own key. Results come back to this server rather than being
// consumed inside the model provider, which is what lets the board check that
// every cited source and image actually came from a search.

const ENDPOINT = "https://api.exa.ai/search";
const TIMEOUT_MS = 30_000;

export interface ExaResult {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  highlights: string[];
  image?: string; // the page's representative image, when it has one
}

interface ExaResponse {
  results?: {
    title?: string | null;
    url: string;
    publishedDate?: string;
    author?: string | null;
    highlights?: string[];
    image?: string;
  }[];
  costDollars?: { total?: number };
  error?: string;
}

export async function exaSearch(apiKey: string, query: string): Promise<{ results: ExaResult[]; cost: number }> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: 5,
      // Key passages rather than full page text: enough to ground a tile, a
      // fraction of the tokens.
      contents: { highlights: { numSentences: 3, highlightsPerUrl: 2 } },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as ExaResponse | null;
  if (!res.ok || !body) throw new Error(`Exa ${res.status}: ${body?.error ?? res.statusText}`);
  return {
    results: (body.results ?? []).map((r) => ({
      title: r.title || r.url,
      url: r.url,
      publishedDate: r.publishedDate,
      author: r.author ?? undefined,
      highlights: r.highlights ?? [],
      image: r.image,
    })),
    cost: body.costDollars?.total ?? 0,
  };
}
