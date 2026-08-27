import { App, TFile } from "obsidian";

/** A note that links to the current file, with the paragraph containing that link. */
export interface BacklinkSource {
  file: TFile;
  title: string;
  snippet: string;
  mtime: number;
}

/**
 * Find every note that links to `target` (via metadataCache.resolvedLinks) and pull out
 * the paragraph surrounding the actual link for each, most recently modified first.
 */
export async function findBacklinkSources(
  app: App,
  target: TFile,
  maxBacklinks: number,
  snippetLength: number
): Promise<BacklinkSource[]> {
  const resolved = app.metadataCache.resolvedLinks;
  const sourcePaths: string[] = [];
  for (const sourcePath of Object.keys(resolved)) {
    if (sourcePath === target.path) continue;
    const dests = resolved[sourcePath];
    if (dests && dests[target.path] > 0) sourcePaths.push(sourcePath);
  }

  // Resolve to files and rank by mtime BEFORE reading contents, so only the notes we
  // actually keep get read (a hub note can have hundreds of inbound links).
  const files: TFile[] = [];
  for (const sourcePath of sourcePaths) {
    const file = app.vault.getAbstractFileByPath(sourcePath);
    if (file instanceof TFile) files.push(file);
  }
  files.sort((a, b) => b.stat.mtime - a.stat.mtime);

  const sources: BacklinkSource[] = [];
  for (const file of files.slice(0, maxBacklinks)) {
    const snippet = await extractLinkingSnippet(app, file, target, snippetLength);
    sources.push({ file, title: file.basename, snippet, mtime: file.stat.mtime });
  }
  return sources;
}

/** Read `source` and return the paragraph around wherever it links to `target`. */
async function extractLinkingSnippet(
  app: App,
  source: TFile,
  target: TFile,
  snippetLength: number
): Promise<string> {
  const cache = app.metadataCache.getFileCache(source);
  const content = await app.vault.cachedRead(source);
  const candidates = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];

  for (const link of candidates) {
    const dest = app.metadataCache.getFirstLinkpathDest(link.link, source.path);
    if (dest && dest.path === target.path) {
      return paragraphAround(content, link.position.start.offset, snippetLength);
    }
  }
  // Fallback (e.g. link recorded but position stale): use the top of the note.
  return content.slice(0, snippetLength).trim();
}

/** Extract the paragraph containing `offset`, trimmed to roughly `maxLen` chars around it. */
export function paragraphAround(content: string, offset: number, maxLen: number): string {
  const start = content.lastIndexOf("\n\n", offset);
  const end = content.indexOf("\n\n", offset);
  const paraStart = start === -1 ? 0 : start + 2;
  const paraEnd = end === -1 ? content.length : end;
  let para = content.slice(paraStart, paraEnd).trim();

  if (para.length > maxLen) {
    const offsetInPara = offset - paraStart;
    const half = Math.floor(maxLen / 2);
    const sliceStart = Math.max(0, offsetInPara - half);
    const truncated = para.slice(sliceStart, sliceStart + maxLen);
    para = (sliceStart > 0 ? "…" : "") + truncated + (sliceStart + maxLen < para.length ? "…" : "");
  }
  return para || "(no surrounding text found)";
}
