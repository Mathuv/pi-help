# pi-help

The missing `/help` command for [Pi](https://pi.dev) — discover and learn the slash commands available in your Pi config, unix `--help` style.

Pi configs accumulate slash commands from many places: extensions you write, packages you install, prompt templates, and skills. In a team environment, with a shared Pi config,  new team members (and future you) have no helpful way to see what's available or how to use any of it. `pi-help` fixes that with two commands:

- **`/help`** — list every slash command in the current config, grouped by source, with one-line descriptions
- **`/help <name>`** — full documentation for one command: usage, workflow, examples
- **`/help <name> <question>`** — ask the agent anything about one command, grounded in its docs

## Install

```bash
pi install git:github.com/Mathuv/pi-help
```

That's it — `/help` is available in your next Pi session.

## Usage

### List all commands

```
/help
```

Opens a scrollable overlay grouped into three sections:

| Section | Source | Invoked as |
|---|---|---|
| Extension commands | Extensions (yours + installed packages) | `/name` |
| Prompts | Prompt templates (`prompts/*.md`) | `/name` |
| Skills | Skills (yours + installed packages) | `/skill:name` |

### Search the list

Press `/` in the list overlay (man-page style) and start typing — the list narrows live, matching against command **names and descriptions** (case-insensitive substring). If nothing contains what you typed, a typo-tolerant fallback kicks in (`/commt` still finds `commit`, marked `~fuzzy`).

- `Enter` keeps the filter and returns the normal keys (`j`/`k`, `q`, …)
- `Esc` while typing abandons the search; `Esc` on a kept filter clears it; `Esc` on the full list closes the overlay

### Drill into one command

```
/help commit
/help review
/help context_usage
```

The argument is forgiving:

- `commit`, `/commit`, and `skill:commit` all work (matching is case-insensitive)
- **Tab completion** — type `/help rev<tab>` to complete from all known command names
- **Prefix/substring fallback** — `/help usage` finds `context_usage`
- **Did you mean** — `/help commt` suggests `/commit`
- **Name collisions** — if a skill and an extension command share a name, both are shown stacked

What you see depends on where the command comes from:

- **Skills & prompts** — the full markdown documentation (SKILL.md / prompt file body, frontmatter stripped), rendered with formatting
- **Extension commands** — the registered description, plus the doc comment from the top of the extension source file when present

### Ask the agent about a command

```
/help review onboard me with this command
/help review give a quick walkthrough of the command
```

Add a question (two or more words) after the command name and `/help` hands it to the agent as a real LLM turn, with that command's documentation injected as context. The transcript shows a compact one-liner instead of the doc wall; the model sees the full docs.

Unlike everything else `/help` does, this **does** trigger an agent turn (that's the point) — but never by accident:

- a single stray word (`/help commit push`) shows the normal detail view plus a hint, no turn
- an unresolvable name (`/help reviw onboard me`) shows did-you-mean suggestions, no turn
- name collisions inject the docs of **all** matches and let the model disambiguate

### Keys (overlay)

| Key | Action |
|---|---|
| `↑`/`↓` or `k`/`j` | Scroll line |
| `PgUp`/`PgDn` or `Space` | Scroll page |
| `g` / `G` | Jump to top / bottom |
| `/` | Search the list (list overlay only) |
| `Esc` or `q` | Close (`Esc` first clears an active filter) |

The overlay is ephemeral — nothing is added to your session transcript or model context, so browsing help costs zero tokens.

### Headless / scripted use

In non-interactive mode (`pi -p`, RPC), `/help` emits its output as a plain-text custom message (`customType: "help"`) without triggering an agent turn:

```bash
pi --mode json -p --no-session "/help"
pi --mode json -p --no-session "/help commit"
```

The ask form behaves identically to interactive mode — it emits a `customType: "help-ask"` message and **does** trigger a turn, so it's scriptable:

```bash
pi --mode json -p --no-session "/help commit explain the workflow"
```

## What's NOT listed (by design)

Pi's **built-in** commands (`/model`, `/settings`, `/fork`, …) don't appear, because Pi doesn't expose them to extensions — any hardcoded list would silently go stale across Pi releases. For built-ins, use `/hotkeys` or see the [Pi docs](https://pi.dev/docs).

## How it works

Everything comes live from `pi.getCommands()` — the same registry Pi uses for command dispatch. No filesystem scanning, no configuration: install a new package and its commands appear in `/help` immediately.

## Development

```
extensions/help/
├── index.ts       # extension shell: command, completions, TUI overlay, headless fallback
├── lib.ts         # pure logic (grouping, name resolution, formatting) — no pi imports
└── lib.test.ts    # unit tests
```

```bash
npm test     # node --test, no dependencies needed (Node ≥ 22)
```

Design notes live in [CONTEXT.md](./CONTEXT.md) and [docs/](./docs/).

## License

[MIT](./LICENSE)
