import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type AmbientBacklinksPlugin from "./main";
import { BacklinkSource, findBacklinkSources } from "./backlinks";
import { explainBacklinks } from "./explain";
import { LlmClient } from "./llm";

export const VIEW_TYPE_AMBIENT_BACKLINKS = "ambient-backlinks-view";

interface Row {
  source: BacklinkSource;
  cacheKey: string;
  relationship?: string;
  expanded: boolean;
}

/** Side panel listing notes that link to the active note, with an LLM one-liner on how each relates. */
export class AmbientBacklinksView extends ItemView {
  private plugin: AmbientBacklinksPlugin;
  private currentFile: TFile | null = null;
  private rows: Row[] = [];
  private loading = false;
  /** Set when explainMissing() is requested while a request is already in flight, so it re-runs after. */
  private explainQueued = false;
  private debounceTimer: number | null = null;
  /** Separate timer for the auto-mode explain delay, so refresh events don't cancel a pending explain. */
  private explainTimer: number | null = null;
  private errorMessage: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: AmbientBacklinksPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_AMBIENT_BACKLINKS;
  }

  getDisplayText(): string {
    return "Ambient Backlinks";
  }

  getIcon(): string {
    return "link";
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("ambient-backlinks-view");
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRefresh()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleRefresh()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleRefresh()));
    await this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    if (this.explainTimer !== null) window.clearTimeout(this.explainTimer);
  }

  /** Re-scan backlinks for whatever note is now active, then (in auto mode) explain the new ones. */
  private scheduleRefresh(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.refresh().catch((e) => {
        this.errorMessage = e instanceof Error ? e.message : String(e);
        this.render();
      });
    }, 150);
  }

  private async refresh(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file && this.currentFile) {
      // Focus moved to a leaf without a file — usually this panel itself (clicking the
      // button or a toggle fires active-leaf-change). Keep showing the last note
      // instead of wiping the panel.
      return;
    }
    this.currentFile = file;
    this.errorMessage = null;

    if (!file) {
      this.rows = [];
      this.render();
      return;
    }

    const sources = await findBacklinkSources(
      this.app,
      file,
      this.plugin.settings.maxBacklinks,
      this.plugin.settings.snippetLength
    );
    if (this.currentFile !== file) return; // a newer refresh took over while reading snippets
    this.rows = sources.map((source) => {
      const cacheKey = this.plugin.cache.key(file.path, file.stat.mtime, source.file.path, source.mtime);
      return { source, cacheKey, relationship: this.plugin.cache.get(cacheKey), expanded: false };
    });
    this.render();

    if (this.plugin.settings.mode === "auto") {
      if (this.explainTimer !== null) window.clearTimeout(this.explainTimer);
      this.explainTimer = window.setTimeout(() => void this.explainMissing(), this.plugin.settings.debounceMs);
    }
  }

  /** Ask the LLM for a relationship line for every row that doesn't have a cached one yet. */
  async explainMissing(): Promise<void> {
    if (!this.currentFile) return;
    if (this.loading) {
      // A request is already in flight (possibly for another note); re-run once it finishes.
      this.explainQueued = true;
      return;
    }
    const target = this.currentFile;
    const pending = this.rows.filter((r) => !r.relationship);
    if (pending.length === 0) return;

    const client = new LlmClient(this.plugin.settings);
    if (!client.configured()) {
      new Notice("Ambient Backlinks: set an API base URL (and key, if needed) in plugin settings.");
      return;
    }

    this.loading = true;
    this.errorMessage = null;
    this.render();
    try {
      const items = pending.map((r) => ({ key: r.cacheKey, title: r.source.title, snippet: r.source.snippet }));
      const result = await explainBacklinks(client, target.basename, items);
      for (const row of pending) {
        const rel = result[row.cacheKey];
        if (rel) {
          this.plugin.cache.set(row.cacheKey, rel);
          row.relationship = rel;
        }
      }
    } catch (e) {
      this.errorMessage = e instanceof Error ? e.message : String(e);
      new Notice("Ambient Backlinks: " + this.errorMessage);
    } finally {
      this.loading = false;
      this.render();
      if (this.explainQueued) {
        this.explainQueued = false;
        void this.explainMissing();
      }
    }
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    if (!this.currentFile) {
      container.createDiv({ cls: "ambient-backlinks-empty", text: "Open a note to see its ambient backlinks." });
      return;
    }

    const header = container.createDiv({ cls: "ambient-backlinks-header" });
    header.createEl("span", {
      cls: "ambient-backlinks-count",
      text: `${this.rows.length} inbound link${this.rows.length === 1 ? "" : "s"}`,
    });

    if (this.plugin.settings.mode === "manual") {
      const btn = header.createEl("button", { text: this.loading ? "Explaining…" : "Explain backlinks" });
      btn.disabled = this.loading || this.rows.every((r) => r.relationship);
      btn.addEventListener("click", () => void this.explainMissing());
    } else if (this.loading) {
      header.createEl("span", { cls: "ambient-backlinks-loading", text: "Explaining…" });
    }

    if (this.errorMessage) {
      container.createDiv({ cls: "ambient-backlinks-error", text: this.errorMessage });
    }

    if (this.rows.length === 0) {
      container.createDiv({ cls: "ambient-backlinks-empty", text: "No notes link to this one yet." });
      return;
    }

    const list = container.createDiv({ cls: "ambient-backlinks-list" });
    for (const row of this.rows) {
      const item = list.createDiv({ cls: "ambient-backlinks-item" });

      const titleRow = item.createDiv({ cls: "ambient-backlinks-title-row" });
      const link = titleRow.createEl("a", { cls: "ambient-backlinks-title", text: row.source.title });
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        void this.app.workspace.getLeaf(false).openFile(row.source.file);
      });
      const toggle = titleRow.createEl("span", {
        cls: "ambient-backlinks-toggle",
        text: row.expanded ? "▾" : "▸",
      });
      toggle.addEventListener("click", () => {
        row.expanded = !row.expanded;
        this.render();
      });

      item.createDiv({
        cls: row.relationship ? "ambient-backlinks-relationship" : "ambient-backlinks-relationship is-pending",
        text: row.relationship ?? (this.loading ? "Explaining…" : "Not explained yet"),
      });

      if (row.expanded) {
        item.createDiv({ cls: "ambient-backlinks-snippet", text: row.source.snippet });
      }
    }
  }
}
