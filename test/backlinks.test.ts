import { describe, it, expect, vi } from "vitest";
import { App, TFile } from "obsidian";
import { findBacklinkSources, paragraphAround } from "../src/backlinks";

/** Build a fake TFile with the given path/basename/mtime, using the mocked TFile class. */
function makeFile(path: string, mtime: number): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.replace(/\.md$/, "");
  f.name = f.basename + ".md";
  f.extension = "md";
  f.stat = { ctime: mtime, mtime, size: 0 };
  return f;
}

interface LinkCacheItem {
  link: string;
  position: { start: { offset: number }; end: { offset: number } };
}

interface FakeVaultOptions {
  /** path -> resolvedLinks dest map (dest path -> count) */
  resolvedLinks: Record<string, Record<string, number>>;
  /** path -> file content */
  contents: Record<string, string>;
  /** path -> {links, embeds} cache */
  fileCaches: Record<string, { links?: LinkCacheItem[]; embeds?: LinkCacheItem[] }>;
  /** All files that exist in the vault, by path -> TFile */
  files: Record<string, TFile>;
}

/** Build a fake App exposing just the metadataCache/vault surface backlinks.ts touches. */
function makeApp(opts: FakeVaultOptions): App {
  return {
    metadataCache: {
      resolvedLinks: opts.resolvedLinks,
      getFileCache: (file: TFile) => opts.fileCaches[file.path] ?? null,
      getFirstLinkpathDest: (linktext: string, _sourcePath: string) => opts.files[linktext] ?? null,
    },
    vault: {
      getAbstractFileByPath: (path: string) => opts.files[path] ?? null,
      cachedRead: async (file: TFile) => opts.contents[file.path] ?? "",
    },
  } as unknown as App;
}

describe("findBacklinkSources - inbound link detection", () => {
  it("finds only notes whose resolvedLinks entry for the target has count > 0", async () => {
    const target = makeFile("Target.md", 100);
    const linker = makeFile("Linker.md", 50);
    const zeroCount = makeFile("ZeroCount.md", 60);
    const unrelated = makeFile("Unrelated.md", 70);

    const app = makeApp({
      resolvedLinks: {
        "Linker.md": { "Target.md": 1 },
        "ZeroCount.md": { "Target.md": 0 },
        "Unrelated.md": { "Other.md": 1 },
      },
      contents: { "Linker.md": "Link to [[Target]] here." },
      fileCaches: {
        "Linker.md": {
          links: [{ link: "Target", position: { start: { offset: 9 }, end: { offset: 17 } } }],
        },
      },
      files: {
        "Target.md": target,
        "Linker.md": linker,
        "ZeroCount.md": zeroCount,
        "Unrelated.md": unrelated,
        Target: target,
      },
    });

    const result = await findBacklinkSources(app, target, 15, 200);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Linker");
  });

  it("excludes the target linking to itself", async () => {
    const target = makeFile("Target.md", 100);
    const app = makeApp({
      resolvedLinks: { "Target.md": { "Target.md": 1 } },
      contents: {},
      fileCaches: {},
      files: { "Target.md": target },
    });

    const result = await findBacklinkSources(app, target, 15, 200);
    expect(result).toHaveLength(0);
  });

  it("skips source paths that don't resolve to an actual TFile", async () => {
    const target = makeFile("Target.md", 100);
    const app = makeApp({
      resolvedLinks: { "Ghost.md": { "Target.md": 1 } },
      contents: {},
      fileCaches: {},
      files: { "Target.md": target }, // "Ghost.md" intentionally absent
    });

    const result = await findBacklinkSources(app, target, 15, 200);
    expect(result).toHaveLength(0);
  });

  it("ranks results by mtime descending and applies the maxBacklinks cap", async () => {
    const target = makeFile("Target.md", 100);
    const older = makeFile("Older.md", 10);
    const newer = makeFile("Newer.md", 30);
    const newest = makeFile("Newest.md", 50);

    const app = makeApp({
      resolvedLinks: {
        "Older.md": { "Target.md": 1 },
        "Newer.md": { "Target.md": 1 },
        "Newest.md": { "Target.md": 1 },
      },
      contents: {
        "Older.md": "links [[Target]]",
        "Newer.md": "links [[Target]]",
        "Newest.md": "links [[Target]]",
      },
      fileCaches: {},
      files: { "Target.md": target, "Older.md": older, "Newer.md": newer, "Newest.md": newest },
    });

    const capped = await findBacklinkSources(app, target, 2, 200);
    expect(capped.map((s) => s.title)).toEqual(["Newest", "Newer"]);

    const all = await findBacklinkSources(app, target, 15, 200);
    expect(all.map((s) => s.title)).toEqual(["Newest", "Newer", "Older"]);
  });

  it("only reads file contents for the sources kept after the mtime cap (not every candidate)", async () => {
    const target = makeFile("Target.md", 100);
    const older = makeFile("Older.md", 10);
    const newest = makeFile("Newest.md", 50);
    const cachedRead = vi.fn(async (file: TFile) => "content of " + file.path);

    const app = {
      metadataCache: {
        resolvedLinks: {
          "Older.md": { "Target.md": 1 },
          "Newest.md": { "Target.md": 1 },
        },
        getFileCache: () => null,
        getFirstLinkpathDest: () => null,
      },
      vault: {
        getAbstractFileByPath: (path: string) =>
          ({ "Target.md": target, "Older.md": older, "Newest.md": newest }[path] ?? null),
        cachedRead,
      },
    } as unknown as App;

    await findBacklinkSources(app, target, 1, 200);
    expect(cachedRead).toHaveBeenCalledTimes(1);
    expect(cachedRead).toHaveBeenCalledWith(newest);
  });
});

describe("findBacklinkSources - linking snippet extraction", () => {
  it("extracts the paragraph around the resolved link's position, not just the top of the note", async () => {
    const target = makeFile("Target.md", 100);
    const source = makeFile("Source.md", 50);
    const content = "First paragraph, irrelevant.\n\nSecond paragraph links to [[Target]] right here.\n\nThird.";
    const offset = content.indexOf("[[Target]]");

    const app = makeApp({
      resolvedLinks: { "Source.md": { "Target.md": 1 } },
      contents: { "Source.md": content },
      fileCaches: {
        "Source.md": {
          links: [{ link: "Target", position: { start: { offset }, end: { offset: offset + 10 } } }],
        },
      },
      files: { "Target.md": target, "Source.md": source, Target: target },
    });

    const [result] = await findBacklinkSources(app, target, 15, 200);
    expect(result.snippet).toContain("Second paragraph links to");
    expect(result.snippet).not.toContain("First paragraph");
    expect(result.snippet).not.toContain("Third.");
  });

  it("considers embeds as well as links when locating the paragraph", async () => {
    const target = makeFile("Target.md", 100);
    const source = makeFile("Source.md", 50);
    const content = "Intro.\n\nHere is an embed: ![[Target]] shown inline.";
    const offset = content.indexOf("![[Target]]");

    const app = makeApp({
      resolvedLinks: { "Source.md": { "Target.md": 1 } },
      contents: { "Source.md": content },
      fileCaches: {
        "Source.md": {
          embeds: [{ link: "Target", position: { start: { offset }, end: { offset: offset + 11 } } }],
        },
      },
      files: { "Target.md": target, "Source.md": source, Target: target },
    });

    const [result] = await findBacklinkSources(app, target, 15, 200);
    expect(result.snippet).toContain("Here is an embed");
  });

  it("falls back to the top of the note when no cached link/embed resolves to the target", async () => {
    const target = makeFile("Target.md", 100);
    const source = makeFile("Source.md", 50);
    const content = "Top of the note content that should be used as a fallback snippet.";

    const app = makeApp({
      resolvedLinks: { "Source.md": { "Target.md": 1 } },
      contents: { "Source.md": content },
      fileCaches: {
        // A link exists in the cache, but it resolves to a different file than target.
        "Source.md": {
          links: [{ link: "SomeoneElse", position: { start: { offset: 0 }, end: { offset: 5 } } }],
        },
      },
      files: { "Target.md": target, "Source.md": source }, // "SomeoneElse" deliberately absent
    });

    const [result] = await findBacklinkSources(app, target, 15, 30);
    expect(result.snippet).toBe(content.slice(0, 30).trim());
  });

  it("falls back to the top of the note when the file cache has no links or embeds at all", async () => {
    const target = makeFile("Target.md", 100);
    const source = makeFile("Source.md", 50);
    const content = "No cache entries recorded for this note.";

    const app = makeApp({
      resolvedLinks: { "Source.md": { "Target.md": 1 } },
      contents: { "Source.md": content },
      fileCaches: {},
      files: { "Target.md": target, "Source.md": source },
    });

    const [result] = await findBacklinkSources(app, target, 15, 200);
    expect(result.snippet).toBe(content.trim());
  });

  it("returns the source file's mtime alongside the snippet", async () => {
    const target = makeFile("Target.md", 100);
    const source = makeFile("Source.md", 12345);

    const app = makeApp({
      resolvedLinks: { "Source.md": { "Target.md": 1 } },
      contents: { "Source.md": "links [[Target]]" },
      fileCaches: {},
      files: { "Target.md": target, "Source.md": source },
    });

    const [result] = await findBacklinkSources(app, target, 15, 200);
    expect(result.mtime).toBe(12345);
    expect(result.file).toBe(source);
  });
});

describe("paragraphAround", () => {
  it("returns the whole content when there is only one paragraph", () => {
    const content = "Just one paragraph with a link in the middle of it somewhere.";
    const offset = content.indexOf("link");
    expect(paragraphAround(content, offset, 200)).toBe(content);
  });

  it("isolates the paragraph between the surrounding blank lines", () => {
    const content = "Para one.\n\nPara two has the [[link]] in it.\n\nPara three.";
    const offset = content.indexOf("[[link]]");
    expect(paragraphAround(content, offset, 200)).toBe("Para two has the [[link]] in it.");
  });

  it("uses start-of-content when there is no preceding blank line", () => {
    const content = "Leading paragraph with [[link]].\n\nTrailing paragraph.";
    const offset = content.indexOf("[[link]]");
    expect(paragraphAround(content, offset, 200)).toBe("Leading paragraph with [[link]].");
  });

  it("uses end-of-content when there is no following blank line", () => {
    const content = "Leading paragraph.\n\nTrailing paragraph with [[link]] at the end.";
    const offset = content.indexOf("[[link]]");
    expect(paragraphAround(content, offset, 200)).toBe("Trailing paragraph with [[link]] at the end.");
  });

  it("truncates a long paragraph around the offset with a leading and trailing ellipsis", () => {
    const filler = "x".repeat(100);
    const content = `${filler} [[link]] ${filler}`;
    const offset = content.indexOf("[[link]]");
    const result = paragraphAround(content, offset, 20);
    expect(result.startsWith("…")).toBe(true);
    expect(result.endsWith("…")).toBe(true);
    expect(result).toContain("[[link]]");
    // Roughly maxLen chars of actual content plus the two ellipsis characters.
    expect(result.length).toBeLessThanOrEqual(22);
  });

  it("omits the leading ellipsis when the truncation window starts at the paragraph's beginning", () => {
    const content = "[[link]] " + "y".repeat(100);
    const offset = 0;
    const result = paragraphAround(content, offset, 20);
    expect(result.startsWith("…")).toBe(false);
    expect(result.endsWith("…")).toBe(true);
  });

  it("omits the trailing ellipsis when the truncation window reaches the paragraph's end", () => {
    const content = "z".repeat(100) + " [[link]]";
    const offset = content.length - 1;
    const result = paragraphAround(content, offset, 20);
    expect(result.endsWith("…")).toBe(false);
  });

  it("falls back to a placeholder message when the isolated paragraph is empty", () => {
    const content = "before\n\n\n\nafter";
    // Offset sits inside the empty paragraph between the two blank-line pairs.
    const offset = content.indexOf("\n\n\n\n") + 2;
    expect(paragraphAround(content, offset, 200)).toBe("(no surrounding text found)");
  });
});
