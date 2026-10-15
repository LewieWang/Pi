/**
 * Footer Override tests — pure render logic.
 *
 * We can't easily instantiate pi's Theme in unit tests (it wants real
 * terminal colors), so we use a stub theme whose fg() just tags text.
 * What matters is which stats appear / don't appear and the hover
 * detail line toggling.
 */

import * as a from "node:assert";
import { describe, test } from "node:test";

// The OverrideFooter class is not exported; we reach it through the
// factory by stubbing the ExtensionAPI surface.
import { createFooterOverrideExtension } from "../footer-override/index.js";

interface CapturedFooter {
	factory: ((tui: unknown, theme: unknown, footerData: unknown) => unknown) | null;
}

function makeStubTheme() {
	return {
		fg: (_color: string, text: string) => `<${_color}>${text}`,
		bold: (text: string) => `**${text}**`,
	};
}

function install(): { captured: CapturedFooter } {
	const captured: CapturedFooter = { factory: null };
	const handlers = new Map<string, unknown>();
	const pi = {
		on: (event: string, handler: unknown) => {
			handlers.set(event, handler);
		},
		registerTool: () => {},
	} as never as Parameters<ReturnType<typeof createFooterOverrideExtension>>[0];

	const ext = createFooterOverrideExtension();
	ext(pi);

	// Simulate session_start with a TUI-mode context.
	const sessionStart = handlers.get("session_start") as
		| ((event: unknown, ctx: never) => void)
		| undefined;
	a.ok(sessionStart, "session_start handler registered");

	const ctx = {
		mode: "tui",
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => "test-session",
			getEntries: () => [],
			getBranch: () => [],
		},
		ui: {
			setFooter: (factory: unknown) => {
				captured.factory = factory as CapturedFooter["factory"];
			},
		},
		model: { id: "MiniMax-M3", provider: "minimax", input: ["text", "image"] },
		getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
	} as never;

	(sessionStart as unknown as (e: unknown, c: unknown) => void)({}, ctx);
	a.ok(captured.factory, "setFooter was called with a factory");
	return { captured };
}

describe("Footer Override", () => {
	test("factory produces a component whose render omits token stats", () => {
		const { captured } = install();
		const footer = captured.factory!(null, makeStubTheme(), {
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map([["sol-pi", "⚡ 1 KiB saved"]]),
		}) as { render(width: number): string[] };

		const lines = footer.render(120);
		a.ok(Array.isArray(lines));
		const joined = lines.join("\n");
		// The token counters must be gone.
		a.ok(!joined.includes("↑"), "should not show ↑ input counter");
		a.ok(!joined.includes("↓"), "should not show ↓ output counter");
		// Extension statuses are kept.
		a.ok(joined.includes("sol-pi"), "extension statuses kept");
		// No hover detail line yet.
		a.ok(!joined.includes("👁"), "no hover detail before hover");
	});

	test("hover detail appears on mouse move and shows session counters", () => {
		const { captured } = install();
		const footer = captured.factory!(null, makeStubTheme(), {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
		}) as {
			render(width: number): string[];
			handleMouse(event: { type: string; button?: string }): unknown;
		};

		footer.handleMouse({ type: "move" });
		const lines = footer.render(120);
		const joined = lines.join("\n");
		a.ok(joined.includes("👁"), "hover detail visible on move");
		a.ok(joined.includes("in "), "hover shows input tokens");
		a.ok(joined.includes("turns "), "hover shows turn count");
	});

	test("click pins the detail line", () => {
		const { captured } = install();
		const footer = captured.factory!(null, makeStubTheme(), {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
		}) as {
			render(width: number): string[];
			handleMouse(event: { type: string; button?: string }): unknown;
		};

		footer.handleMouse({ type: "press", button: "left" });
		const joined = footer.render(120).join("\n");
		a.ok(joined.includes("📌"), "pinned detail visible after click");
	});
});