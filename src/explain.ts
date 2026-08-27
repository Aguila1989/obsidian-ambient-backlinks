import { ChatMessage, LlmClient } from "./llm";

/** One backlink source prepared for the LLM prompt. */
export interface ExplainItem {
  /** Cache key: identifies (target mtime, source mtime) so results survive until either changes. */
  key: string;
  title: string;
  snippet: string;
}

/** In-memory cache of relationship explanations, keyed by target+source path/mtime. */
export class ExplainCache {
  private cache = new Map<string, string>();

  key(targetPath: string, targetMtime: number, sourcePath: string, sourceMtime: number): string {
    return `${targetPath}@${targetMtime}::${sourcePath}@${sourceMtime}`;
  }

  get(key: string): string | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
}

const BATCH_SIZE = 8;

/**
 * Ask the LLM, in batches, how each backlink source relates to the current note.
 * Returns a map of item.key -> one-line relationship description for whichever items
 * the model answered (missing keys mean the model skipped/failed that one).
 */
export async function explainBacklinks(
  client: LlmClient,
  targetTitle: string,
  items: ExplainItem[]
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchResult = await explainBatch(client, targetTitle, batch);
    Object.assign(out, batchResult);
  }
  return out;
}

async function explainBatch(
  client: LlmClient,
  targetTitle: string,
  batch: ExplainItem[]
): Promise<Record<string, string>> {
  if (batch.length === 0) return {};

  const listing = batch
    .map(
      (item, i) =>
        `[${i}] Source note: "${item.title}"\nParagraph that links to "${targetTitle}":\n"""\n${item.snippet}\n"""`
    )
    .join("\n\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You help someone browse their personal notes. You are given the current note's title and a list of " +
        "other notes that link TO it, each with the paragraph containing that link. For each numbered note, " +
        "write ONE short line (at most ~15 words) describing the NATURE of its connection to the current note " +
        "— e.g. 'gives an example of this concept', 'contradicts this claim', 'is a prerequisite for this idea'. " +
        "Do not summarize the source note itself, only describe the relationship. " +
        'Respond with strict JSON only, of the form {"relations": {"0": "...", "1": "..."}}.',
    },
    {
      role: "user",
      content: `Current note: "${targetTitle}"\n\nLinking notes:\n\n${listing}`,
    },
  ];

  const result = await client.chatJson<{ relations?: Record<string, string> }>(messages, { temperature: 0.2 });
  const out: Record<string, string> = {};
  batch.forEach((item, i) => {
    const rel = result.relations?.[String(i)];
    if (rel && rel.trim().length > 0) out[item.key] = rel.trim();
  });
  return out;
}
