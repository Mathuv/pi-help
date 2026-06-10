/**
 * /help
 *
 * Unix-style help for the slash commands available in the current Pi config.
 * `/help` lists all commands (extension commands, prompts, skills) from
 * pi.getCommands(); `/help <name>` shows detailed usage for one command:
 * skills/prompts render their markdown docs, extension commands show their
 * description and header doc comment.
 * Built-in Pi commands (/model, /settings, …) are not exposed to extensions
 * and therefore not listed — see /hotkeys and https://pi.dev/docs.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth, Key, type AutocompleteItem, type Component, type TUI } from "@earendil-works/pi-tui";
import fs from "node:fs/promises";
import {
	allEntries,
	formatDetail,
	formatList,
	formatSuggestions,
	groupEntries,
	resolveName,
	stripFrontmatter,
	extractHeaderComment,
	type DetailBlock,
	type HelpEntry,
	type HelpGroups,
} from "./lib.ts";

function invocation(e: HelpEntry): string {
	return e.source === "skill" ? `/skill:${e.bareName}` : `/${e.bareName}`;
}

async function loadBody(e: HelpEntry): Promise<string | null> {
	if (!e.path) return null;
	try {
		const content = await fs.readFile(e.path, "utf8");
		return e.source === "extension" ? extractHeaderComment(content) : stripFrontmatter(content);
	} catch {
		return null;
	}
}

function buildListLines(theme: any, groups: HelpGroups, width: number): string[] {
	const lines: string[] = [];
	const section = (title: string, entries: HelpEntry[]) => {
		if (entries.length === 0) return;
		const nameWidth = Math.max(...entries.map((e) => invocation(e).length));
		lines.push(theme.fg("accent", theme.bold(title)));
		for (const e of entries) {
			const name = theme.fg("text", invocation(e).padEnd(nameWidth));
			const maxDesc = Math.max(0, width - nameWidth - 6);
			const desc = e.description.length > maxDesc ? `${e.description.slice(0, maxDesc - 1)}…` : e.description;
			lines.push(`  ${name}  ${theme.fg("muted", desc)}`);
		}
		lines.push("");
	};
	section("Extension commands", groups.extensions);
	section("Prompts", groups.prompts);
	section("Skills", groups.skills);
	lines.push(theme.fg("dim", "Built-in Pi commands (/model, /settings, …) are not listed — see /hotkeys and https://pi.dev/docs"));
	return lines;
}

function buildDetailLines(theme: any, blocks: DetailBlock[], width: number): string[] {
	const lines: string[] = [];
	blocks.forEach((block, i) => {
		if (i > 0) {
			lines.push("");
			lines.push(theme.fg("dim", "─".repeat(Math.min(40, width))));
			lines.push("");
		}
		const e = block.entry;
		const scope = e.scope ? ` (${e.scope})` : "";
		lines.push(theme.fg("accent", theme.bold(invocation(e))) + theme.fg("muted", ` — ${e.source}${scope}`));
		lines.push("");
		if (block.body && e.source !== "extension") {
			const md = new Markdown(block.body, 0, 0, getMarkdownTheme());
			lines.push(...md.render(width));
		} else {
			const text = block.body?.trim() || e.description || "(no documentation available)";
			for (const l of text.split("\n")) lines.push(theme.fg("text", l));
		}
		lines.push("");
		lines.push(theme.fg("dim", `source: ${e.path}`));
	});
	return lines;
}

class HelpView implements Component {
	private theme: any;
	private title: string;
	private buildBody: (width: number) => string[];
	private onDone: () => void;
	private offset = 0;
	private cachedWidth?: number;
	private cachedBody: string[] = [];

	constructor(theme: any, title: string, buildBody: (width: number) => string[], onDone: () => void) {
		this.theme = theme;
		this.title = title;
		this.buildBody = buildBody;
		this.onDone = onDone;
	}

	private pageHeight(): number {
		return Math.max(8, (process.stdout.rows ?? 30) - 8);
	}

	handleInput(data: string): void {
		const page = this.pageHeight();
		const max = Math.max(0, this.cachedBody.length - page);
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "q") {
			this.onDone();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, Key.down) || data === "j") this.offset = Math.min(max, this.offset + 1);
		else if (matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - page);
		else if (matchesKey(data, Key.pageDown) || data === " ") this.offset = Math.min(max, this.offset + page);
		else if (data === "g") this.offset = 0;
		else if (data === "G") this.offset = max;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 2);
		if (this.cachedWidth !== innerWidth) {
			this.cachedBody = this.buildBody(innerWidth);
			this.cachedWidth = innerWidth;
		}
		const page = this.pageHeight();
		const max = Math.max(0, this.cachedBody.length - page);
		this.offset = Math.min(this.offset, max);

		const border = new DynamicBorder((s: string) => this.theme.fg("accent", s)).render(width);
		const scrollInfo =
			max > 0 ? `  ${this.offset + 1}-${Math.min(this.offset + page, this.cachedBody.length)}/${this.cachedBody.length}` : "";
		const header =
			" " +
			this.theme.fg("accent", this.theme.bold(this.title)) +
			this.theme.fg("dim", `${scrollInfo}  (↑/↓ scroll · Esc/q close)`);

		const visible = this.cachedBody.slice(this.offset, this.offset + page).map((l) => ` ${l}`);
		// pi-tui hard-errors on lines wider than the terminal; ANSI-aware truncation
		// at this single exit point bounds every line regardless of content source.
		return [...border, header, "", ...visible, ...border].map((l) => truncateToWidth(l, width));
	}
}

export default function helpExtension(pi: ExtensionAPI) {
	pi.registerCommand("help", {
		description: "List available slash commands; /help <name> for details",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const q = prefix.trim().toLowerCase();
			const items = allEntries(groupEntries(pi.getCommands() as any))
				.filter((e) => e.bareName.toLowerCase().startsWith(q))
				.map((e) => ({ value: e.bareName, label: invocation(e), description: e.description || e.source }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			const groups = groupEntries(pi.getCommands() as any);
			const query = args.trim();

			if (!query) {
				if (!ctx.hasUI) {
					pi.sendMessage({ customType: "help", content: formatList(groups), display: true }, { triggerTurn: false });
					return;
				}
				await ctx.ui.custom<void>((_tui: TUI, theme: any, _kb: unknown, done: () => void) => {
					return new HelpView(theme, "Pi commands — /help <name> for details", (w) => buildListLines(theme, groups, w), done);
				});
				return;
			}

			const resolution = resolveName(query, groups);
			if (resolution.kind === "suggestions") {
				const msg = formatSuggestions(resolution.query, resolution.names);
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else pi.sendMessage({ customType: "help", content: msg, display: true }, { triggerTurn: false });
				return;
			}

			const blocks: DetailBlock[] = await Promise.all(
				resolution.entries.map(async (entry) => ({ entry, body: await loadBody(entry) })),
			);

			if (!ctx.hasUI) {
				pi.sendMessage({ customType: "help", content: formatDetail(blocks), display: true }, { triggerTurn: false });
				return;
			}
			const title = blocks.length === 1 ? `Help: ${invocation(blocks[0]!.entry)}` : `Help: ${query} (${blocks.length} matches)`;
			await ctx.ui.custom<void>((_tui: TUI, theme: any, _kb: unknown, done: () => void) => {
				return new HelpView(theme, title, (w) => buildDetailLines(theme, blocks, w), done);
			});
		},
	});
}
