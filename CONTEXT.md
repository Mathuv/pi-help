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
Live, man-style narrowing of the Help Overlay list via `/`; membership is decided by case-insensitive substring over name, description, and Package Origin searchable tail, with a bigram typo-rescue on names only when substring finds nothing — so the list always stays explainable by the text typed. Rows show the raw Package Origin tag only while a filter is active, keeping membership visible. List overlay only; the detail view is a document, not a directory.
_Avoid_: Fuzzy-only membership, filtering inside the detail view, origin tags on the unfiltered list

**Package Origin**:
The raw package source string a command was installed from (`git:…`, `npm:…`, or a local path), present only for commands with origin `package`; displayed raw (scheme kept, so git vs npm stays visible) in the detail header and Help Ask block headers. Only its searchable tail — scheme, host, and path noise dropped (`git:github.com/adtrac/superpowers` → `adtrac/superpowers`, `../../devel/pi-help` → `pi-help`) — participates in the List Filter, so generic parts like `git` or `github.com` never act as filter words. Synthetic origin markers (`auto`, `cli`, `local`) are never displayed or searchable.
_Avoid_: Stripping the scheme from display, matching generic scheme/host parts, matching synthetic origin markers, origin-based name resolution

**Width Safety**:
Every line the overlay returns passes through pi-tui's ANSI-aware `truncateToWidth` at the single render exit point, because pi-tui hard-errors on lines wider than the terminal (narrow split panes).
_Avoid_: Character-count truncation of styled text, unbounded footer/path lines

**Startup Overhead**:
What pi-help adds to pi's startup: the delta between two otherwise-identical startups, with and without pi-help, on the same workload — attributed to the extension-load phase, never inferred from absolute totals.
_Avoid_: Quoting absolute startup times as overhead, single-run numbers

**Feature Cost**:
The extra time and peak memory of a run that actually exercises a `/help` feature, relative to a startup-only run of the same configuration. Help Ask is out of scope: its cost belongs to the model, not the extension.
_Avoid_: Counting model latency or tokens as extension cost

**Isolated Mode**:
The benchmark baseline where discovery is disabled and pi-help is the only extension present — the reproducible numbers published to users.
_Avoid_: Publishing numbers measured inside a personal config

**Full-Config Mode**:
The benchmark mode where pi-help is toggled inside a disposable copy of a real, fully-loaded personal config — a sanity check that Isolated Mode numbers survive contact with a busy setup. Its numbers are environment-specific.
_Avoid_: Treating full-config numbers as portable, mutating the live config

## Example Dialogue

Dev: "Why doesn't `/help model` show anything for the built-in /model command?"
Domain expert: "Built-ins are outside Help Scope — Pi doesn't expose them to extensions, so /help points you at /hotkeys and the Pi docs instead of maintaining a stale copy."
