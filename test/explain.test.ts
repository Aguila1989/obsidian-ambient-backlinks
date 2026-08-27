import { describe, it, expect, vi } from "vitest";
import { ExplainCache, explainBacklinks, ExplainItem } from "../src/explain";
import type { LlmClient } from "../src/llm";

/** Fake LlmClient whose chatJson() is fully controlled by the test. */
function makeClient(impl: (...args: unknown[]) => unknown): LlmClient {
  return { chatJson: vi.fn(impl) } as unknown as LlmClient;
}

describe("ExplainCache", () => {
  it("builds a key that combines both paths and both mtimes", () => {
    const cache = new ExplainCache();
    const key = cache.key("Target.md", 100, "Source.md", 50);
    expect(key).toBe("Target.md@100::Source.md@50");
  });

  it("produces a different key when either mtime changes", () => {
    const cache = new ExplainCache();
    const k1 = cache.key("Target.md", 100, "Source.md", 50);
    const k2 = cache.key("Target.md", 101, "Source.md", 50);
    const k3 = cache.key("Target.md", 100, "Source.md", 51);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k2).not.toBe(k3);
  });

  it("round-trips a value through set/get, and returns undefined for a miss", () => {
    const cache = new ExplainCache();
    const key = cache.key("Target.md", 100, "Source.md", 50);
    expect(cache.get(key)).toBeUndefined();
    cache.set(key, "gives an example of this");
    expect(cache.get(key)).toBe("gives an example of this");
  });

  it("clear() empties all entries", () => {
    const cache = new ExplainCache();
    const key = cache.key("Target.md", 100, "Source.md", 50);
    cache.set(key, "some relation");
    cache.clear();
    expect(cache.get(key)).toBeUndefined();
  });
});

describe("explainBacklinks", () => {
  it("returns an empty object immediately for an empty item list, without calling the client", async () => {
    const client = makeClient(() => ({ relations: {} }));
    const out = await explainBacklinks(client, "Target", []);
    expect(out).toEqual({});
    expect(client.chatJson).not.toHaveBeenCalled();
  });

  it("maps each item's cache key to the model's relationship line by numeric index", async () => {
    const client = makeClient(() => ({ relations: { "0": "is a prerequisite", "1": "gives an example" } }));
    const items: ExplainItem[] = [
      { key: "keyA", title: "Source A", snippet: "snippet a" },
      { key: "keyB", title: "Source B", snippet: "snippet b" },
    ];
    const out = await explainBacklinks(client, "Target", items);
    expect(out).toEqual({ keyA: "is a prerequisite", keyB: "gives an example" });
  });

  it("omits keys the model didn't answer, rather than inserting empty/undefined values", async () => {
    const client = makeClient(() => ({ relations: { "0": "explained" } })); // index 1 missing
    const items: ExplainItem[] = [
      { key: "keyA", title: "Source A", snippet: "s" },
      { key: "keyB", title: "Source B", snippet: "s" },
    ];
    const out = await explainBacklinks(client, "Target", items);
    expect(out).toEqual({ keyA: "explained" });
    expect(out).not.toHaveProperty("keyB");
  });

  it("treats a whitespace-only relationship as unanswered", async () => {
    const client = makeClient(() => ({ relations: { "0": "   " } }));
    const items: ExplainItem[] = [{ key: "keyA", title: "Source A", snippet: "s" }];
    const out = await explainBacklinks(client, "Target", items);
    expect(out).toEqual({});
  });

  it("trims the relationship text before storing it", async () => {
    const client = makeClient(() => ({ relations: { "0": "  spaced out  " } }));
    const items: ExplainItem[] = [{ key: "keyA", title: "Source A", snippet: "s" }];
    const out = await explainBacklinks(client, "Target", items);
    expect(out.keyA).toBe("spaced out");
  });

  it("tolerates a response with no relations field at all", async () => {
    const client = makeClient(() => ({}));
    const items: ExplainItem[] = [{ key: "keyA", title: "Source A", snippet: "s" }];
    const out = await explainBacklinks(client, "Target", items);
    expect(out).toEqual({});
  });

  it("splits more than BATCH_SIZE (8) items into multiple chatJson calls", async () => {
    const chatJson = vi.fn().mockResolvedValueOnce({ relations: { "0": "first-batch" } }).mockResolvedValueOnce({
      relations: { "0": "second-batch" },
    });
    const client = { chatJson } as unknown as LlmClient;

    const items: ExplainItem[] = Array.from({ length: 10 }, (_, i) => ({
      key: `key${i}`,
      title: `Source ${i}`,
      snippet: `snippet ${i}`,
    }));

    const out = await explainBacklinks(client, "Target", items);

    expect(chatJson).toHaveBeenCalledTimes(2);
    // First batch has 8 items (indices 0-7 locally), second batch has the remaining 2 (indices 0-1 locally).
    expect(out.key0).toBe("first-batch"); // local index 0 of batch 1 -> item 0
    expect(out.key8).toBe("second-batch"); // local index 0 of batch 2 -> item 8
    // Every other item was "unanswered" by our mock and should be absent.
    expect(Object.keys(out)).toEqual(["key0", "key8"]);
  });

  it("builds a user prompt containing the target title and every batch item's title and snippet", async () => {
    const chatJson = vi.fn().mockResolvedValue({ relations: {} });
    const client = { chatJson } as unknown as LlmClient;
    const items: ExplainItem[] = [{ key: "keyA", title: "My Source Note", snippet: "the surrounding paragraph" }];

    await explainBacklinks(client, "My Target Note", items);

    expect(chatJson).toHaveBeenCalledTimes(1);
    const [messages] = chatJson.mock.calls[0] as [Array<{ role: string; content: string }>, unknown];
    const userMessage = messages.find((m) => m.role === "user");
    const systemMessage = messages.find((m) => m.role === "system");
    expect(userMessage?.content).toContain("My Target Note");
    expect(userMessage?.content).toContain("My Source Note");
    expect(userMessage?.content).toContain("the surrounding paragraph");
    expect(systemMessage?.content).toContain("JSON");
  });

  it("passes a low temperature through to the client for deterministic-ish output", async () => {
    const chatJson = vi.fn().mockResolvedValue({ relations: {} });
    const client = { chatJson } as unknown as LlmClient;
    const items: ExplainItem[] = [{ key: "keyA", title: "A", snippet: "s" }];

    await explainBacklinks(client, "Target", items);

    const [, opts] = chatJson.mock.calls[0] as [unknown, { temperature?: number }];
    expect(opts.temperature).toBe(0.2);
  });
});
