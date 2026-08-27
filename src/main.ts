import { Notice, Plugin } from "obsidian";
import { AmbientBacklinksSettingTab, AmbientBacklinksSettings, DEFAULT_SETTINGS } from "./settings";
import { AmbientBacklinksView, VIEW_TYPE_AMBIENT_BACKLINKS } from "./view";
import { ExplainCache } from "./explain";

export default class AmbientBacklinksPlugin extends Plugin {
  settings!: AmbientBacklinksSettings;
  /** In-memory cache of LLM relationship explanations, shared with the view. Cleared on reload. */
  cache = new ExplainCache();

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new AmbientBacklinksSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_AMBIENT_BACKLINKS, (leaf) => new AmbientBacklinksView(leaf, this));

    this.addRibbonIcon("link", "Open Ambient Backlinks", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-panel",
      name: "Open panel",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "explain-backlinks-now",
      name: "Explain backlinks for current note",
      callback: () => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_AMBIENT_BACKLINKS)[0];
        if (leaf && leaf.view instanceof AmbientBacklinksView) {
          void leaf.view.explainMissing();
        } else {
          new Notice("Open the Ambient Backlinks panel first (ribbon icon or command palette).");
        }
      },
    });
  }

  // Note: leaves are intentionally NOT detached in onunload — Obsidian's guidelines say the app
  // handles cleanup of registered views, and detaching would wipe the user's saved panel layout.

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Reveal the existing Ambient Backlinks leaf, or create one in the right sidebar. */
  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_AMBIENT_BACKLINKS);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Ambient Backlinks: could not open a sidebar panel.");
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_AMBIENT_BACKLINKS, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}
