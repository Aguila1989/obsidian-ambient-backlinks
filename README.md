# Ambient Backlinks

Shows a one-line, LLM-written explanation of *how* each backlinked note relates to the note
you're currently viewing — not a summary of the other note, but the nature of the connection
("gives a counter-example", "is the prerequisite step", "was written after reading this").

## Features

- A side panel, "Ambient Backlinks", listing every note that links to the one you're viewing,
  most recently modified first.
- For each linking note, the paragraph containing the actual link is located and sent to an
  LLM, which writes one short line describing how it relates to the current note.
- Explanations are cached in memory, keyed by both notes' modification times, so an unchanged
  pair is never re-explained.
- Auto mode explains new/changed backlinks automatically after a short debounce; manual mode
  only calls the LLM when you ask it to, so you control API spend.
- Click a row to open that note, or expand it to see the actual linking paragraph.

## How to use

1. Open the panel via the ribbon icon (link icon), the command palette ("Open panel"), or by
   running "Explain backlinks for current note" directly.
2. Open a note that other notes link to. The panel lists every inbound link, most recently
   modified first.
3. In Auto mode, the panel explains itself shortly after you land on the note. In Manual mode,
   click "Explain backlinks" when you're ready.
4. Click a row's title to open that source note, or click the ▸/▾ toggle to expand the row and
   read the paragraph that contains the link.

Under the hood: the plugin scans `metadataCache.resolvedLinks` for every note that links to the
active one, reads each source note to locate the paragraph containing the actual link (via
`metadataCache.getFileCache().links` + `getFirstLinkpathDest`), trims it to the configured
snippet length, and sends pending sources to the LLM in small batches asking for one
relationship line per source.

## Settings

- **API base URL / API key / Chat model** — standard OpenAI-compatible LLM settings (works with
  OpenAI, Ollama, LM Studio, etc.).
- **Explanation mode** — `Auto` explains new/changed backlinks automatically after a debounce
  delay once you land on a note; `Manual` only runs when you click "Explain backlinks", so you
  control API spend.
- **Debounce delay (ms)** — how long auto mode waits after you open a note before calling the LLM
  (lets you flip through notes without firing a request per note).
- **Max backlinks per note** — caps how many inbound links are shown/explained, most recently
  modified first.
- **Snippet length (characters)** — how much of the linking paragraph is sent to the LLM and shown
  on expand.

## Limitations

- The explanation cache is in-memory only and resets when the plugin reloads or Obsidian restarts
  — reopening a note you've already explained will re-call the LLM once per session.
- Only explicit wikilinks/markdown links and embeds are considered; unresolved links (to notes
  that don't exist yet) are not part of `resolvedLinks` and are ignored, as are links that only
  appear in a way the metadata cache doesn't capture a position for (falls back to the top of the
  note in that rare case).
- The one-line relationship is only as good as the model's read of the linking paragraph; very
  short or context-free snippets (e.g. a bare link in a list) yield less useful explanations.
- No retry/backoff on LLM errors beyond surfacing a `Notice`; a failed batch simply leaves those
  rows as "Not explained yet" until the next explain pass.

## Privacy and network use

This plugin only makes network requests to the LLM endpoint **you configure** in its settings
(OpenAI-compatible; a local Ollama or LM Studio works fully offline). The title of the active note
and the linking paragraph from each backlinking note are sent to that endpoint to generate the
relationship summaries. Nothing is sent anywhere else, no telemetry is collected, and no requests
are made until an endpoint is configured. Using a hosted provider may require a paid account with
that provider.

## Installation

This plugin is not yet available in the Obsidian community plugin store. To try it, install it
manually:

1. Copy (or symlink) the `plugins/ambient-backlinks` folder into
   `<vault>/.obsidian/plugins/ambient-backlinks`.
2. Reload Obsidian (or run "Reload app without saving" from the command palette) and enable
   "Ambient Backlinks" under Settings → Community plugins.
3. Open plugin settings and set an API base URL (e.g. a local Ollama server) and chat model.
