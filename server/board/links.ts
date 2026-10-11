const TIMEOUT_MS = 5000;
const checked = new Map<string, Promise<boolean>>();

/**
 * Whether a source URL the agent cited actually exists. Model-written URLs are
 * the classic hallucination, and a public board must not show dead citations.
 * Only a definite miss (404/410, DNS or connection failure) counts against a
 * link: bot walls and method restrictions (401/403/405/429) still prove the page
 * is there.
 */
export function linkResolves(url: string): Promise<boolean> {
  let result = checked.get(url);
  if (!result) {
    result = probe(url);
    checked.set(url, result);
  }
  return result;
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.status !== 404 && res.status !== 410;
  } catch {
    return false;
  }
}
