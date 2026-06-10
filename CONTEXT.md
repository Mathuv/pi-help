# Help Command Context

Language for the `/help` extension behavior.

## Language

**Command Registry**:
The runtime list returned by `pi.getCommands()` — the single source of truth for what `/help` shows.
_Avoid_: Filesystem scanning, parallel command lists

**Help Scope**:
Extension commands, prompt templates, and skills only; Pi built-ins are deliberately excluded because they are not exposed to extensions and hardcoded lists drift across Pi releases.
_Avoid_: Hardcoded built-in command tables

**Detail Tiering**:
Skills and prompts show their markdown file body (frontmatter stripped); extension commands show their registry description plus the source file's header doc comment when present.
_Avoid_: LLM-generated help, invented documentation

**Help Overlay**:
An ephemeral TUI view that adds nothing to the transcript or model context; headless mode degrades to a non-turn transcript message.
_Avoid_: Triggering agent turns, persisting help output

**Name Resolution**:
Query normalization strips `/` and `skill:`; exact matches across all sources are shown stacked on collision, then prefix/substring fallback, then bigram-based did-you-mean suggestions.
_Avoid_: Silent winner-picking on name collisions

**Width Safety**:
Every line the overlay returns passes through pi-tui's ANSI-aware `truncateToWidth` at the single render exit point, because pi-tui hard-errors on lines wider than the terminal (narrow split panes).
_Avoid_: Character-count truncation of styled text, unbounded footer/path lines

## Example Dialogue

Dev: "Why doesn't `/help model` show anything for the built-in /model command?"
Domain expert: "Built-ins are outside Help Scope — Pi doesn't expose them to extensions, so /help points you at /hotkeys and the Pi docs instead of maintaining a stale copy."
