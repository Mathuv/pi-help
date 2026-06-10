/**
 * Pure logic for the /help extension. No pi / pi-tui imports — fully unit-testable.
 */

/** Shape of entries returned by pi.getCommands() (structural subset). */
export interface HelpCommand {
	name: string;
	description?: string;
	source: string;
	sourceInfo: { path: string; scope?: string };
}

export interface HelpEntry {
	/** Registry name, e.g. "skill:commit". */
	name: string;
	/** Name without the skill: prefix, e.g. "commit". */
	bareName: string;
	description: string;
	source: "extension" | "prompt" | "skill";
	path: string;
	scope?: string;
}

export interface HelpGroups {
	extensions: HelpEntry[];
	prompts: HelpEntry[];
	skills: HelpEntry[];
}

export type Resolution =
	| { kind: "match"; entries: HelpEntry[] }
	| { kind: "suggestions"; query: string; names: string[] };

const SKILL_PREFIX = "skill:";

function toEntry(c: HelpCommand, source: HelpEntry["source"]): HelpEntry {
	const bareName = c.name.startsWith(SKILL_PREFIX) ? c.name.slice(SKILL_PREFIX.length) : c.name;
	return {
		name: c.name,
		bareName,
		description: (c.description ?? "").replace(/\s*\n\s*/g, " ").trim(),
		source,
		path: c.sourceInfo?.path ?? "",
		scope: c.sourceInfo?.scope,
	};
}

export function groupEntries(commands: HelpCommand[]): HelpGroups {
	const byBareName = (a: HelpEntry, b: HelpEntry) => a.bareName.localeCompare(b.bareName);
	const pick = (source: HelpEntry["source"]) =>
		commands.filter((c) => c.source === source).map((c) => toEntry(c, source)).sort(byBareName);
	return {
		extensions: pick("extension"),
		prompts: pick("prompt"),
		skills: pick("skill"),
	};
}

export function allEntries(groups: HelpGroups): HelpEntry[] {
	return [...groups.extensions, ...groups.prompts, ...groups.skills];
}

function normalizeQuery(query: string): string {
	let q = query.trim().toLowerCase();
	if (q.startsWith("/")) q = q.slice(1);
	if (q.startsWith(SKILL_PREFIX)) q = q.slice(SKILL_PREFIX.length);
	return q;
}

export function resolveName(query: string, groups: HelpGroups): Resolution {
	const q = normalizeQuery(query);
	const entries = allEntries(groups);

	const exact = entries.filter((e) => e.bareName.toLowerCase() === q || e.name.toLowerCase() === q);
	if (exact.length > 0) return { kind: "match", entries: exact };

	const prefix = entries.filter((e) => e.bareName.toLowerCase().startsWith(q));
	if (prefix.length > 0) return { kind: "match", entries: prefix };

	const substring = entries.filter((e) => e.bareName.toLowerCase().includes(q));
	if (substring.length > 0) return { kind: "match", entries: substring };

	return {
		kind: "suggestions",
		query: q,
		names: suggestClosest(q, entries.map((e) => e.bareName)),
	};
}

/** Bigram Dice similarity in [0, 1]; tolerant of typos, weak below ~3 chars. */
const FUZZY_MIN_SCORE = 0.4;

function diceScore(query: string, name: string): number {
	const q = bigrams(query.toLowerCase());
	const n = bigrams(name.toLowerCase());
	let shared = 0;
	for (const b of q) if (n.has(b)) shared++;
	return q.size + n.size > 0 ? (2 * shared) / (q.size + n.size) : 0;
}

/**
 * Closest-name suggestions for "did you mean" output.
 * Called only when exact/prefix/substring matching all failed,
 * so this must tolerate typos (e.g. "commt" → "commit").
 * Returns at most 3 names, best first; empty when nothing is plausibly close.
 */
export function suggestClosest(query: string, names: string[]): string[] {
	return names
		.map((name) => ({ name, score: diceScore(query, name) }))
		.filter((s) => s.score >= FUZZY_MIN_SCORE)
		.sort((a, b) => b.score - a.score)
		.slice(0, 3)
		.map((s) => s.name);
}

export type FilterMode = "all" | "substring" | "fuzzy";

export interface FilterResult {
	groups: HelpGroups;
	mode: FilterMode;
	count: number;
}

/**
 * Live list filter for the help overlay (man-style `/` search).
 * Substring over name + description decides membership; the bigram
 * typo-rescue (names only) fires only when substring finds nothing,
 * so list membership always stays explainable by the text typed.
 */
export function filterEntries(groups: HelpGroups, query: string): FilterResult {
	const q = query.trim().toLowerCase();
	if (!q) return { groups, mode: "all", count: allEntries(groups).length };

	const bySubstring = (e: HelpEntry) =>
		e.bareName.toLowerCase().includes(q) || e.description.toLowerCase().includes(q);
	const substring = filterGroups(groups, bySubstring);
	if (substring.count > 0) return { ...substring, mode: "substring" };

	const fuzzy = filterGroups(groups, (e) => diceScore(q, e.bareName) >= FUZZY_MIN_SCORE);
	return { ...fuzzy, mode: fuzzy.count > 0 ? "fuzzy" : "substring" };
}

function filterGroups(groups: HelpGroups, keep: (e: HelpEntry) => boolean): { groups: HelpGroups; count: number } {
	const filtered: HelpGroups = {
		extensions: groups.extensions.filter(keep),
		prompts: groups.prompts.filter(keep),
		skills: groups.skills.filter(keep),
	};
	return { groups: filtered, count: allEntries(filtered).length };
}

function bigrams(s: string): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
	return out;
}

export function stripFrontmatter(md: string): string {
	if (!md.startsWith("---\n") && md.trimStart() !== md) return md;
	if (!md.startsWith("---\n")) return md;
	const end = md.indexOf("\n---", 4);
	if (end === -1) return md;
	const afterMarker = md.indexOf("\n", end + 1);
	if (afterMarker === -1) return md;
	return md.slice(afterMarker + 1).replace(/^\s*\n/, "");
}

export function extractHeaderComment(source: string): string | null {
	let src = source;
	if (src.startsWith("#!")) {
		const nl = src.indexOf("\n");
		if (nl === -1) return null;
		src = src.slice(nl + 1);
	}
	src = src.replace(/^\s*\n/, "");

	if (src.startsWith("/**") || src.startsWith("/*")) {
		const end = src.indexOf("*/");
		if (end === -1) return null;
		const inner = src.slice(src.indexOf("*") + 2, end);
		const lines = inner
			.split("\n")
			.map((l) => l.replace(/^\s*\*\s?/, "").trimEnd());
		return trimBlankEdges(lines).join("\n") || null;
	}

	if (src.startsWith("//")) {
		const lines: string[] = [];
		for (const line of src.split("\n")) {
			if (!line.startsWith("//")) break;
			lines.push(line.replace(/^\/\/\s?/, "").trimEnd());
		}
		return trimBlankEdges(lines).join("\n") || null;
	}

	return null;
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]?.trim() === "") start++;
	while (end > start && lines[end - 1]?.trim() === "") end--;
	return lines.slice(start, end);
}

function invocation(e: HelpEntry): string {
	return e.source === "skill" ? `/${SKILL_PREFIX}${e.bareName}` : `/${e.bareName}`;
}

function renderSection(title: string, entries: HelpEntry[], lines: string[]): void {
	if (entries.length === 0) return;
	const width = Math.max(...entries.map((e) => invocation(e).length));
	lines.push(title);
	for (const e of entries) {
		const name = invocation(e).padEnd(width);
		lines.push(e.description ? `  ${name}  ${e.description}` : `  ${name}`);
	}
	lines.push("");
}

export function formatList(groups: HelpGroups): string {
	const lines: string[] = [];
	lines.push("Pi commands — type /help <name> for details");
	lines.push("");
	renderSection("Extension commands", groups.extensions, lines);
	renderSection("Prompts", groups.prompts, lines);
	renderSection("Skills", groups.skills, lines);
	lines.push("Built-in Pi commands (/model, /settings, …) are not listed — see /hotkeys and https://pi.dev/docs");
	return lines.join("\n");
}

export interface DetailBlock {
	entry: HelpEntry;
	/** Pre-read doc body (markdown / header comment), or null when unavailable. */
	body: string | null;
}

export function formatDetail(matches: DetailBlock[]): string {
	const blocks = matches.map((m) => {
		const e = m.entry;
		const lines: string[] = [];
		const scope = e.scope ? ` (${e.scope})` : "";
		lines.push(`${invocation(e)} — ${e.source}${scope}`);
		lines.push("");
		const body = m.body?.trim() || e.description || "(no documentation available)";
		lines.push(body);
		lines.push("");
		lines.push(`source: ${e.path}`);
		return lines.join("\n");
	});
	return blocks.join("\n\n────────────────────────────\n\n");
}

/** Split /help args into a name candidate (first token) and the Help Ask question (the rest). */
export function splitAskArgs(args: string): { name: string; question: string } {
	const trimmed = args.trim();
	if (!trimmed) return { name: "", question: "" };
	const space = trimmed.search(/\s/);
	if (space === -1) return { name: trimmed, question: "" };
	return { name: trimmed.slice(0, space), question: trimmed.slice(space).trim() };
}

/**
 * A Help Ask question must be ≥2 words: a genuine request is virtually always
 * multi-word, and one stray token must never trigger a paid agent turn.
 */
export function isAskQuestion(question: string): boolean {
	return question.split(/\s+/).filter(Boolean).length >= 2;
}

/**
 * Model-visible prompt for a Help Ask turn: the command's docs (same fallback
 * chain as formatDetail) ground the agent before the user's request.
 */
export function buildAskPrompt(blocks: DetailBlock[], question: string, rawInput: string): string {
	const lines: string[] = [];
	lines.push(`The user ran \`/help ${rawInput}\`.`);
	lines.push(
		"Below is the documentation for the matching command in the current Pi config. " +
			"Answer the question or perform the request about this command, using these docs as the primary source.",
	);
	if (blocks.length > 1) {
		lines.push("");
		lines.push(`Note: the name matched multiple commands; documentation for all of them is included.`);
	}
	for (const m of blocks) {
		const e = m.entry;
		const scope = e.scope ? ` (${e.scope})` : "";
		lines.push("");
		lines.push(`--- ${invocation(e)} — ${e.source}${scope} · source: ${e.path} ---`);
		lines.push(m.body?.trim() || e.description || "(no documentation available)");
	}
	lines.push("");
	lines.push(`User's request: ${question}`);
	return lines.join("\n");
}

export function formatSuggestions(query: string, names: string[]): string {
	const head = `No command found for "${query}".`;
	if (names.length === 0) return `${head} Run /help to see all commands.`;
	return `${head} Did you mean: ${names.map((n) => `/${n}`).join(", ")}?`;
}
