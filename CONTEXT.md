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
An ephemeral TUI view that adds nothing to the transcript or model context; headless mode degrades to a non-turn transcript message. Help Ask is the one deliberate exception, and it is a separate concept — the overlay itself never triggers turns.
_Avoid_: Triggering agent turns, persisting help output

**Help Ask**:
Words after the command name (`/help <name> <question>`) are an explicit opt-in to a real agent turn: the question, grounded in that command's documentation, is handed to the model. The question must be at least two words — a single stray token shows the detail view with a hint instead, so a typo or habit never silently costs a paid turn. An unresolvable name yields suggestions, never a turn; a literal registry-name match grounds the agent in that command alone (sibling hint stays out of the prompt), while genuine ties ground it in all matches.
_Avoid_: Turns triggered by typos or stray words, silent winner-picking, answering from invented documentation

**Name Resolution**:
Query normalization strips the leading `/` only; `skill:` is a source qualifier and part of the skill's registry name, never stripped. A query equal to a literal registry name resolves to exactly that command — `iterate` is the extension's literal name, `skill:iterate` the skill's — with a UI-only "also matches" hint for same-bare-name siblings it shadowed. Bare names with no literal match fall back to bare-name exact (stacked on ties), then prefix/substring over both name forms, then bigram-based did-you-mean suggestions. Autocomplete inserts the full registry name so a menu selection is always unambiguous.
_Avoid_: Stripping source qualifiers, arbitrary winner-picking on genuine ties, leaking the sibling hint into model-visible prompts

**List Filter**:
Live, man-style narrowing of the Help Overlay list via `/`; membership is decided by case-insensitive substring over name and description, with a bigram typo-rescue on names only when substring finds nothing — so the list always stays explainable by the text typed. List overlay only; the detail view is a document, not a directory.
_Avoid_: Fuzzy-only membership, filtering inside the detail view

**Width Safety**:
Every line the overlay returns passes through pi-tui's ANSI-aware `truncateToWidth` at the single render exit point, because pi-tui hard-errors on lines wider than the terminal (narrow split panes).
_Avoid_: Character-count truncation of styled text, unbounded footer/path lines

## Example Dialogue

Dev: "Why doesn't `/help model` show anything for the built-in /model command?"
Domain expert: "Built-ins are outside Help Scope — Pi doesn't expose them to extensions, so /help points you at /hotkeys and the Pi docs instead of maintaining a stale copy."
