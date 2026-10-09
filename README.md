# claude-mods — personal fork

Based on [Tickloop/claude-mods](https://github.com/Tickloop/claude-mods), with
expanded `tool-lines` controls and summaries for personal use.

| Mod | What it does |
| --- | --- |
| `glamour-dark` | Draws the model's text replies with [glamour](https://github.com/charmbracelet/glamour)'s default dark style |
| `tool-lines` | Compact tool rows with expandable results, status dots, shortened paths and change summaries |

## Tool-lines improvements

- Click the triangle or `tool_call:` to unfold one call; close it with the
  triangle or the `hide` button below its output.
- Show longer commands, session-relative paths and shortened scratchpad paths.
- Include added/removed line counts, Read line counts, agent statistics and
  readable MCP tool names in compact rows.
- Fold groups of calls into a summary with combined status and change counts.
- Preserve the engine's expanded transcript view when Ctrl+O is open.

These changes affect terminal presentation. Other surfaces keep the engine's
rendering. `glamour-dark` is included unchanged and can be installed separately.

## Installation

Add this repo as a plugin marketplace, then install the mods you want:

```sh
claude plugin marketplace add suatkocar/claude-mods
claude plugin install tool-lines@claude-mods --scope user
```

To add the optional theme, install `glamour-dark@claude-mods` separately.
Run `/reload-plugins` in an open session to apply plugin changes.

To pick up a new release (a mod's `version` in its `plugin.json` changed):

```sh
claude plugin marketplace update claude-mods
claude plugin update tool-lines@claude-mods
```

Then run `/reload-plugins` in any open session to switch to the new version.

## Development

Clone the repo, then start Claude Code from its root with both mods loaded:

```sh
claude --plugin-dir ./glamour-dark --plugin-dir ./tool-lines
```

`--plugin-dir` loads a mod for that session only. To use the local checkout in
every project, register it as a directory marketplace from the repository root:

```sh
claude plugin marketplace add . --scope user
claude plugin install tool-lines@claude-mods --scope user
```

`claude plugin list --json` reports the local `readFromFolder`. Keep that
directory in place and use `/reload-plugins` after editing the source.

Validate changes before publishing:

```sh
claude plugin test tool-lines
claude plugin validate tool-lines --strict
```
