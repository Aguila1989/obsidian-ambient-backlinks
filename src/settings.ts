import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_LLM_SETTINGS, LlmSettings } from "./llm";
import type AmbientBacklinksPlugin from "./main";

export type ExplainMode = "auto" | "manual";

export interface AmbientBacklinksSettings extends LlmSettings {
  /** "auto": explain new/changed backlinks automatically (debounced). "manual": only on demand. */
  mode: ExplainMode;
  /** Cap on how many backlinks are shown/explained for a note, to bound LLM cost. */
  maxBacklinks: number;
  /** Max characters of the linking paragraph sent to the LLM and shown on expand. */
  snippetLength: number;
  /** Debounce delay (ms) before auto-mode explains backlinks after switching notes. */
  debounceMs: number;
}

export const DEFAULT_SETTINGS: AmbientBacklinksSettings = {
  ...DEFAULT_LLM_SETTINGS,
  mode: "auto",
  maxBacklinks: 15,
  snippetLength: 240,
  debounceMs: 1200,
};

export class AmbientBacklinksSettingTab extends PluginSettingTab {
  plugin: AmbientBacklinksPlugin;

  constructor(app: App, plugin: AmbientBacklinksPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("LLM connection").setHeading();

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("OpenAI-compatible endpoint, e.g. https://api.openai.com/v1, or a local Ollama/LM Studio URL.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_LLM_SETTINGS.baseUrl)
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Not required for most local servers (Ollama, LM Studio).")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Chat model")
      .setDesc("Model used to explain how each backlink relates to the current note.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_LLM_SETTINGS.chatModel)
          .setValue(this.plugin.settings.chatModel)
          .onChange(async (value) => {
            this.plugin.settings.chatModel = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Behavior").setHeading();

    new Setting(containerEl)
      .setName("Explanation mode")
      .setDesc("Auto explains backlinks shortly after you open a note. Manual only runs when you click the button.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", "Auto (debounced)")
          .addOption("manual", "Manual")
          .setValue(this.plugin.settings.mode)
          .onChange(async (value) => {
            this.plugin.settings.mode = value === "manual" ? "manual" : "auto";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debounce delay (ms)")
      .setDesc("In auto mode, how long to wait after switching notes before calling the LLM.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.debounceMs))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!Number.isNaN(n) && n >= 0) {
              this.plugin.settings.debounceMs = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Max backlinks per note")
      .setDesc("Caps how many inbound links are shown and sent to the LLM, to control cost.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxBacklinks))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.maxBacklinks = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Snippet length (characters)")
      .setDesc("How much of the linking paragraph is sent to the LLM and shown when a row is expanded.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.snippetLength))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.snippetLength = n;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
