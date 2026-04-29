# opencode-tmux

Auto-spawn tmux panes for OpenCode subagent sessions — when OpenCode creates a child session, this plugin splits a new tmux pane and attaches it automatically.

## How It Works

When OpenCode fires a `session.created` event for a child session (one with a `parentID`), the plugin:
1. Splits a new tmux pane horizontally
2. Runs `opencode attach <serverUrl> --session <id> --dir <dir>` in it
3. Applies your configured layout
4. Closes the pane when the session goes idle (if `autoClose: true`)
5. Polls periodically as a fallback to catch missed events

## Requirements

- **tmux ≥ 3.0** installed and in `PATH`
- OpenCode must be **running inside a tmux session** (the plugin is a no-op otherwise)
- `opencode` binary must be in `PATH` (for the `attach` command in spawned panes)

## Installation

```bash
bun add @floschl/opencode-tmux
```

Register the plugin in your `opencode.json` (global `~/.config/opencode/opencode.json` or project-local):

```json
{
  "plugin": ["@floschl/opencode-tmux"]
}
```

> **Note:** OpenCode validates `opencode.json` against its own strict schema and rejects unknown keys.
> Plugin config lives in a **separate file** — do not add `"tmux": { ... }` to `opencode.json`.

## Configuration

Create `opencode-tmux.json` with the plugin's settings. Keys are flat (no nesting):

**Global** (`~/.config/opencode/opencode-tmux.json`):
```json
{
  "layout": "main-vertical",
  "mainPaneSize": 60,
  "autoClose": true
}
```

**Project-local** (either path works; `<project>/opencode-tmux.json` takes precedence):
- `<project>/opencode-tmux.json`
- `<project>/.opencode/opencode-tmux.json`

Project-local config overrides global config. Unset keys fall back to defaults.

## Configuration Reference

All keys go directly in `opencode-tmux.json` (flat, no nesting).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `layout` | string | `"main-vertical"` | tmux layout: `main-vertical`, `main-horizontal`, `tiled`, `even-horizontal`, `even-vertical` |
| `mainPaneSize` | number | `60` | Main pane size as percentage (10–90). Used with `main-vertical` / `main-horizontal` layouts |
| `autoClose` | boolean | `true` | Close pane automatically when session goes idle |
| `pollIntervalMs` | number | `2000` | How often (ms) to poll session status as a fallback |
| `sessionTimeoutMs` | number | `600000` | Max session lifetime in ms (10 min default) before force-close |

Project-level `opencode-tmux.json` overrides global config.

## Event Handling

| Event | Action |
|-------|--------|
| `session.created` (child only) | Spawn new tmux pane with `opencode attach` |
| `session.status` → `idle` | Close pane (if `autoClose: true`) |
| `session.status` → `busy` | Re-spawn pane if session is known but pane was closed |
| `session.deleted` | Close pane unconditionally |
| Poll tick | Close idle / timed-out / long-missing sessions |

## Debugging

Set `OPENCODE_TMUX_DEBUG=1` to enable verbose stderr logging:

```bash
OPENCODE_TMUX_DEBUG=1 opencode
```

## Limitations

- **tmux only** — no support for other terminal multiplexers
- **Child sessions only** — top-level sessions (no `parentID`) are ignored
- Requires OpenCode to be started from within an active tmux session
- The `opencode attach` command must be available in the spawned pane's `PATH`
