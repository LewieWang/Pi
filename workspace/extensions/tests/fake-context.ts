/**
 * Minimal fake of Pi's ExtensionToolContext. Just enough to let the wrapped
 * edit/write tools run their execute() function end-to-end against the real
 * filesystem.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { tmpdir } from "node:os";

const noopUi = {
	notify: () => {},
	setStatus: () => {},
	pastable: () => false,
} as unknown as ExtensionContext["ui"];

const noopTheme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
} as unknown as Theme;

const noopSessionManager = {
	getSessionId: () => "test-session",
	getSessionFile: () => undefined,
	getSessionDir: () => tmpdir(),
	getLeafId: () => null,
	getEntries: () => [],
	getBranch: () => [],
} as unknown as ExtensionContext["sessionManager"];

export interface FakeContextOptions {
	cwd?: string;
	signal?: AbortSignal;
}

/**
 * Construct a fake ExtensionToolContext. async to match the real API.
 */
export async function makeFakeToolContext(options: FakeContextOptions = {}): Promise<ExtensionToolContext> {
	const cwd = options.cwd ?? tmpdir();
	return {
		ui: noopUi,
		mode: "rpc",
		hasUI: false,
		cwd,
		sessionManager: noopSessionManager,
		modelRegistry: undefined as never,
		model: undefined,
		scopedModels: [],
		thinkingLevel: undefined,
		isIdle: () => true,
		isProjectTrusted: () => false,
		signal: options.signal,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		tools: [] as readonly AgentTool<any>[],
		executeTool: () => {
			throw new Error("executeTool not used in tests");
		},
	} as unknown as ExtensionToolContext;
}

export const testTheme = noopTheme;
export function componentToString(c: Component | undefined): string {
	if (!c) return "";
	return c.render(120).join("\n");
}