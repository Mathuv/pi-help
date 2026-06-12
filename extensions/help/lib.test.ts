import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	groupEntries,
	resolveName,
	stripFrontmatter,
	extractHeaderComment,
	filterEntries,
	formatList,
	formatDetail,
	suggestClosest,
	splitAskArgs,
	isAskQuestion,
	buildAskPrompt,
	type HelpCommand,
	type HelpGroups,
} from "./lib.ts";

function cmd(name: string, source: string, description?: string, path = `/fake/${name}.md`): HelpCommand {
	return { name, description, source, sourceInfo: { path, scope: "user" } };
}

const SAMPLE: HelpCommand[] = [
	cmd("review", "extension", "Review changes", "/ext/review.ts"),
	cmd("context_usage", "extension", "Show loaded context overview", "/ext/context.ts"),
	cmd("interactive-plan", "prompt", "Plan workflow", "/prompts/interactive-plan.md"),
	cmd("skill:summarize", "skill", "Summarize session", "/skills/summarize/SKILL.md"),
	cmd("skill:commit", "skill", "Commit msg generator", "/skills/commit/SKILL.md"),
];

describe("groupEntries", () => {
	test("groups by source", () => {
		const g = groupEntries(SAMPLE);
		assert.equal(g.extensions.length, 2);
		assert.equal(g.prompts.length, 1);
		assert.equal(g.skills.length, 2);
	});

	test("sorts each group alphabetically by bare name", () => {
		const g = groupEntries(SAMPLE);
		assert.deepEqual(
			g.extensions.map((e) => e.bareName),
			["context_usage", "review"],
		);
		assert.deepEqual(
			g.skills.map((e) => e.bareName),
			["commit", "summarize"],
		);
	});

	test("strips skill: prefix into bareName but keeps registry name", () => {
		const g = groupEntries(SAMPLE);
		const commit = g.skills.find((e) => e.bareName === "commit");
		assert.ok(commit);
		assert.equal(commit.name, "skill:commit");
	});

	test("missing description becomes empty string", () => {
		const g = groupEntries([cmd("bare", "extension", undefined, "/ext/bare.ts")]);
		assert.equal(g.extensions[0]?.description, "");
	});

	test("multi-line description is collapsed to one line", () => {
		const g = groupEntries([cmd("multi", "extension", "Line one.\nLine two,\n  indented tail.", "/ext/multi.ts")]);
		assert.equal(g.extensions[0]?.description, "Line one. Line two, indented tail.");
	});

	test("unknown source values are ignored", () => {
		const g = groupEntries([cmd("weird", "builtin")]);
		assert.deepEqual([g.extensions.length, g.prompts.length, g.skills.length], [0, 0, 0]);
	});
});

describe("resolveName", () => {
	const groups = groupEntries(SAMPLE);

	test("exact bare-name match", () => {
		const r = resolveName("commit", groups);
		assert.equal(r.kind, "match");
		if (r.kind === "match") {
			assert.equal(r.entries.length, 1);
			assert.equal(r.entries[0]?.name, "skill:commit");
		}
	});

	test("normalizes leading slash and skill: prefix", () => {
		for (const q of ["/commit", "skill:commit", "/skill:commit", "  commit "]) {
			const r = resolveName(q, groups);
			assert.equal(r.kind, "match", `query ${JSON.stringify(q)}`);
		}
	});

	test("match is case-insensitive", () => {
		const r = resolveName("COMMIT", groups);
		assert.equal(r.kind, "match");
	});

	test("collision returns all matching sources", () => {
		const withCollision = groupEntries([...SAMPLE, cmd("commit", "prompt", "Commit prompt", "/prompts/commit.md")]);
		const r = resolveName("commit", withCollision);
		assert.equal(r.kind, "match");
		if (r.kind === "match") {
			assert.equal(r.entries.length, 2);
			assert.deepEqual(r.entries.map((e) => e.source).sort(), ["prompt", "skill"]);
		}
	});

	test("prefix fallback when no exact match", () => {
		const r = resolveName("contex", groups);
		assert.equal(r.kind, "match");
		if (r.kind === "match") {
			assert.equal(r.entries[0]?.bareName, "context_usage");
		}
	});

	test("substring fallback when no prefix match", () => {
		const r = resolveName("usage", groups);
		assert.equal(r.kind, "match");
		if (r.kind === "match") {
			assert.equal(r.entries[0]?.bareName, "context_usage");
		}
	});

	test("no match returns suggestions", () => {
		const r = resolveName("commt", groups);
		assert.equal(r.kind, "suggestions");
		if (r.kind === "suggestions") {
			assert.ok(r.names.includes("commit"));
		}
	});

	test("hopeless query returns empty suggestions", () => {
		const r = resolveName("xyzzy", groups);
		assert.equal(r.kind, "suggestions");
		if (r.kind === "suggestions") {
			assert.equal(r.names.length, 0);
		}
	});
});

describe("suggestClosest", () => {
	const names = ["commit", "context_usage", "review", "summarize", "interactive-plan"];

	test("caps results at 3", () => {
		assert.ok(suggestClosest("c", names).length <= 3);
	});

	test("typo still finds intended name", () => {
		assert.ok(suggestClosest("commt", names).includes("commit"));
	});

	test("nothing similar yields empty list", () => {
		assert.deepEqual(suggestClosest("qqqq", names), []);
	});
});

describe("filterEntries", () => {
	const groups = groupEntries(SAMPLE);
	const total = SAMPLE.length;

	test("empty query returns everything in mode all", () => {
		const r = filterEntries(groups, "");
		assert.equal(r.mode, "all");
		assert.equal(r.count, total);
		assert.deepEqual(r.groups, groups);
	});

	test("whitespace-only query is treated as empty", () => {
		const r = filterEntries(groups, "   ");
		assert.equal(r.mode, "all");
		assert.equal(r.count, total);
	});

	test("matches on name substring", () => {
		const r = filterEntries(groups, "commit");
		assert.equal(r.mode, "substring");
		assert.deepEqual(r.groups.skills.map((e) => e.bareName), ["commit"]);
		assert.equal(r.count, 1);
	});

	test("matches on description substring", () => {
		const r = filterEntries(groups, "loaded context");
		assert.equal(r.mode, "substring");
		assert.deepEqual(r.groups.extensions.map((e) => e.bareName), ["context_usage"]);
		assert.equal(r.count, 1);
	});

	test("matching is case-insensitive both ways", () => {
		assert.equal(filterEntries(groups, "COMMIT").count, 1);
		assert.equal(filterEntries(groups, "summarize session").count, 1);
	});

	test("single-character query filters via substring", () => {
		const r = filterEntries(groups, "z");
		assert.equal(r.mode, "substring");
		// "summarize" name and "Summarize session" description
		assert.deepEqual(r.groups.skills.map((e) => e.bareName), ["summarize"]);
	});

	test("group structure is preserved across sources", () => {
		// "plan" hits prompt name; "Plan workflow" description too
		const r = filterEntries(groups, "plan");
		assert.equal(r.groups.extensions.length, 0);
		assert.deepEqual(r.groups.prompts.map((e) => e.bareName), ["interactive-plan"]);
		assert.equal(r.groups.skills.length, 0);
	});

	test("typo with no substring hit falls back to fuzzy on names", () => {
		const r = filterEntries(groups, "commt");
		assert.equal(r.mode, "fuzzy");
		assert.ok(r.groups.skills.some((e) => e.bareName === "commit"));
		assert.equal(r.count, r.groups.extensions.length + r.groups.prompts.length + r.groups.skills.length);
	});

	test("fuzzy never fires when a substring match exists", () => {
		const r = filterEntries(groups, "com");
		assert.equal(r.mode, "substring");
	});

	test("hopeless query yields zero matches, not fuzzy noise", () => {
		const r = filterEntries(groups, "qqqq");
		assert.equal(r.count, 0);
		assert.deepEqual(allNames(r.groups), []);
	});

	function allNames(g: HelpGroups): string[] {
		return [...g.extensions, ...g.prompts, ...g.skills].map((e) => e.bareName);
	}
});

describe("splitAskArgs", () => {
	test("no trailing words yields empty question", () => {
		assert.deepEqual(splitAskArgs("review"), { name: "review", question: "" });
	});

	test("first token is name, rest is question", () => {
		assert.deepEqual(splitAskArgs("review onboard me with this command"), {
			name: "review",
			question: "onboard me with this command",
		});
	});

	test("extra whitespace is trimmed and collapsed at the split", () => {
		assert.deepEqual(splitAskArgs("  review   give a walkthrough  "), {
			name: "review",
			question: "give a walkthrough",
		});
	});

	test("empty input yields empty name and question", () => {
		assert.deepEqual(splitAskArgs("   "), { name: "", question: "" });
	});
});

describe("isAskQuestion", () => {
	test("empty question is not an ask", () => {
		assert.equal(isAskQuestion(""), false);
	});

	test("single word is not an ask", () => {
		assert.equal(isAskQuestion("push"), false);
	});

	test("two words are an ask", () => {
		assert.equal(isAskQuestion("onboard me"), true);
	});

	test("many words are an ask", () => {
		assert.equal(isAskQuestion("give a quick walkthrough of the command"), true);
	});
});

describe("buildAskPrompt", () => {
	const groups = groupEntries(SAMPLE);
	const commit = groups.skills.find((e) => e.bareName === "commit")!;
	const review = groups.extensions.find((e) => e.bareName === "review")!;

	test("includes raw invocation, docs, source path, and the request", () => {
		const out = buildAskPrompt([{ entry: commit, body: "# Commit skill\nUsage..." }], "onboard me", "commit onboard me");
		assert.match(out, /\/help commit onboard me/);
		assert.match(out, /\/skill:commit/);
		assert.match(out, /# Commit skill/);
		assert.match(out, /\/skills\/commit\/SKILL\.md/);
		assert.match(out, /User's request: onboard me/);
	});

	test("falls back to description when body is null", () => {
		const out = buildAskPrompt([{ entry: review, body: null }], "walk me through", "review walk me through");
		assert.match(out, /Review changes/);
	});

	test("falls back to placeholder when body and description are missing", () => {
		const bare = groupEntries([cmd("bare", "extension", undefined, "/ext/bare.ts")]).extensions[0]!;
		const out = buildAskPrompt([{ entry: bare, body: null }], "explain this", "bare explain this");
		assert.match(out, /\(no documentation available\)/);
	});

	test("single match has no ambiguity note", () => {
		const out = buildAskPrompt([{ entry: commit, body: "body" }], "onboard me", "commit onboard me");
		assert.doesNotMatch(out, /multiple commands/);
	});

	test("collision includes all blocks and an ambiguity note", () => {
		const out = buildAskPrompt(
			[
				{ entry: commit, body: "skill body" },
				{ entry: review, body: null },
			],
			"onboard me",
			"commit onboard me",
		);
		assert.match(out, /multiple commands/);
		assert.match(out, /skill body/);
		assert.match(out, /Review changes/);
	});
});

describe("stripFrontmatter", () => {
	test("removes leading frontmatter block", () => {
		const md = "---\nname: commit\ndescription: x\n---\n\n# Commit\nBody";
		assert.equal(stripFrontmatter(md), "# Commit\nBody");
	});

	test("no frontmatter returns input unchanged", () => {
		const md = "# Title\nBody";
		assert.equal(stripFrontmatter(md), md);
	});

	test("--- mid-file is not frontmatter", () => {
		const md = "# Title\n\n---\n\nBody";
		assert.equal(stripFrontmatter(md), md);
	});

	test("unterminated frontmatter returns input unchanged", () => {
		const md = "---\nname: broken\nno end";
		assert.equal(stripFrontmatter(md), md);
	});
});

describe("extractHeaderComment", () => {
	test("extracts block comment header", () => {
		const src = "/**\n * /context_usage\n *\n * Small TUI view.\n */\n\nimport x from \"y\";";
		assert.equal(extractHeaderComment(src), "/context_usage\n\nSmall TUI view.");
	});

	test("extracts contiguous line comments", () => {
		const src = "// My command\n// Does things\nconst x = 1;";
		assert.equal(extractHeaderComment(src), "My command\nDoes things");
	});

	test("no header comment returns null", () => {
		assert.equal(extractHeaderComment("import x from \"y\";\n// later comment"), null);
	});

	test("skips shebang line", () => {
		const src = "#!/usr/bin/env node\n// Real header\nconst x = 1;";
		assert.equal(extractHeaderComment(src), "Real header");
	});
});

describe("formatList", () => {
	const groups: HelpGroups = groupEntries(SAMPLE);
	const out = formatList(groups);

	test("contains all three section headers", () => {
		assert.match(out, /Extension commands/);
		assert.match(out, /Prompts/);
		assert.match(out, /Skills/);
	});

	test("extension and prompt names rendered with leading slash", () => {
		assert.match(out, /\/context_usage/);
		assert.match(out, /\/interactive-plan/);
	});

	test("skills rendered with skill: invocation form", () => {
		assert.match(out, /\/skill:commit/);
	});

	test("descriptions included", () => {
		assert.match(out, /Show loaded context overview/);
	});

	test("footer mentions /help <name> and built-ins pointer", () => {
		assert.match(out, /\/help <name>/);
		assert.match(out, /\/hotkeys/);
	});

	test("empty group is omitted", () => {
		const out2 = formatList(groupEntries([cmd("only", "extension", "x", "/ext/only.ts")]));
		assert.doesNotMatch(out2, /Prompts/);
		assert.doesNotMatch(out2, /Skills/);
	});
});

describe("formatDetail", () => {
	const groups = groupEntries(SAMPLE);
	const commit = groups.skills.find((e) => e.bareName === "commit")!;
	const review = groups.extensions.find((e) => e.bareName === "review")!;

	test("renders invocation, source type, and path", () => {
		const out = formatDetail([{ entry: commit, body: "# Commit skill\nUsage..." }]);
		assert.match(out, /\/skill:commit/);
		assert.match(out, /skill/);
		assert.match(out, /\/skills\/commit\/SKILL\.md/);
	});

	test("renders body when present", () => {
		const out = formatDetail([{ entry: commit, body: "# Commit skill\nUsage..." }]);
		assert.match(out, /# Commit skill/);
	});

	test("falls back to description when body is null", () => {
		const out = formatDetail([{ entry: review, body: null }]);
		assert.match(out, /Review changes/);
	});

	test("stacks multiple matches with separator", () => {
		const out = formatDetail([
			{ entry: commit, body: "skill body" },
			{ entry: review, body: null },
		]);
		assert.match(out, /skill body/);
		assert.match(out, /Review changes/);
		assert.ok(out.indexOf("skill body") < out.indexOf("Review changes"));
	});
});
