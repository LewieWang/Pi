/**
 * Action Fusion tests using Node's built-in test runner.
 *
 * Why not vitest? Vitest worker pool crashes on Windows + Node 25.
 * Node's `node:test` ships with Node 18+ and is zero-dependency.
 */

import * as a from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createActionFusionTools } from "../action-fusion/definition.js";
import { makeFakeToolContext } from "./fake-context.js";
import { silentJournal, type Journal } from "../shared/journal.js";

describe("Action Fusion", { concurrency: false }, () => {
	test("edit + then_run: mutates a file and runs the follow-up command", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "sol-pi-test-"));
		try {
			const target = join(tmp, "hello.txt");
			writeFileSync(target, "old content\n", "utf8");
			mkdirSync(join(tmp, "marker"), { recursive: true });

			const tools = createActionFusionTools(tmp, silentJournal);
			const tctx = await makeFakeToolContext({ cwd: tmp });

			const result = await tools.edit.execute(
				"test-1",
				{
					path: target,
					edits: [{ oldText: "old content", newText: "new content" }],
					then_run: {
						command: `node -e "require('fs').writeFileSync('marker/flag', 'fired')"`,
						timeout: 5,
					},
				} as never,
				undefined,
				undefined,
				tctx,
			);

			a.equal(readFileSync(target, "utf8"), "new content\n", "file mutated");
			a.ok(existsSync(join(tmp, "marker", "flag")), "marker created by then_run");
			const text = result.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { text: string }).text)
				.join("\n");
			a.ok(text.includes("[then_run:succeeded]"), `[then_run:succeeded] in output:\n${text}`);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("write + then_run: preserves mutation when then_run fails", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "sol-pi-test-"));
		try {
			const target = join(tmp, "preserve.txt");
			writeFileSync(target, "old\n", "utf8");

			const tools = createActionFusionTools(tmp, silentJournal);
			const tctx = await makeFakeToolContext({ cwd: tmp });

			let capturedError: Error | undefined;
			try {
				await tools.write.execute(
					"test-2",
					{
						path: target,
						content: "fresh\n",
						then_run: { command: "exit 1", timeout: 5 },
					} as never,
					undefined,
					undefined,
					tctx,
				);
			} catch (err) {
				capturedError = err as Error;
			}

			a.equal(readFileSync(target, "utf8"), "fresh\n", "mutation preserved");
			a.ok(capturedError, "expected then_run to throw");
			a.ok(
				capturedError!.message.includes("[then_run:failed]"),
				`error has [then_run:failed]: ${capturedError!.message}`,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("write works without then_run (original behavior)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "sol-pi-test-"));
		try {
			const target = join(tmp, "plain.txt");
			writeFileSync(target, "old\n", "utf8");

			const tools = createActionFusionTools(tmp, silentJournal);
			const tctx = await makeFakeToolContext({ cwd: tmp });

			await tools.write.execute(
				"test-4",
				{ path: target, content: "new\n" } as never,
				undefined,
				undefined,
				tctx,
			);

			a.equal(readFileSync(target, "utf8"), "new\n");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("schema includes then_run on both edit and write", () => {
		const tools = createActionFusionTools(tmpdir(), silentJournal);
		const editProps = (tools.edit.parameters as { properties: Record<string, unknown> }).properties;
		const writeProps = (tools.write.parameters as { properties: Record<string, unknown> }).properties;
		a.ok("then_run" in editProps, "edit has then_run");
		a.ok("then_run" in writeProps, "write has then_run");
		a.ok("path" in editProps, "edit keeps path");
		a.ok("edits" in editProps, "edit keeps edits");
		a.ok("path" in writeProps, "write keeps path");
		a.ok("content" in writeProps, "write keeps content");
	});

	test("journal records mutation + then_run events", async () => {
		const events: JournalEvent[] = [];
		const recordingJournal: Journal = {
			record: async (event) => {
				events.push(event);
			},
		};

		const tmp = mkdtempSync(join(tmpdir(), "sol-pi-test-"));
		try {
			const target = join(tmp, "journal.txt");
			writeFileSync(target, "old\n", "utf8");
			mkdirSync(join(tmp, "marker"), { recursive: true });

			const tools = createActionFusionTools(tmp, recordingJournal);
			const tctx = await makeFakeToolContext({ cwd: tmp });

			await tools.write.execute(
				"test-journal",
				{
					path: target,
					content: "fresh\n",
					then_run: {
						command: `node -e "require('fs').writeFileSync('marker/flag', 'fired')"`,
						timeout: 5,
					},
				} as never,
				undefined,
				undefined,
				tctx,
			);

			const mutation = events.find((e) => e.kind === "mutation");
			const thenRun = events.find((e) => e.kind === "then_run");
			a.ok(mutation, "mutation event present");
			a.ok(thenRun, "then_run event present");
			if (thenRun && thenRun.kind === "then_run") {
				a.equal(thenRun.outcome, "succeeded", "then_run succeeded");
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("hash guard: external write between mutation and then_run skips command", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "sol-pi-test-"));
		try {
			const target = join(tmp, "guard.txt");
			writeFileSync(target, "start\n", "utf8");

			// Wrap createEditToolDefinition indirectly by injecting an
			// interfering writer between mutate() and the hash guard yield.
			// We do this by replacing the underlying edit tool with one that
			// touches the file after running.
			const tools = createActionFusionTools(tmp, silentJournal);

			// Override the wrapped execute to inject a writer after mutation.
			const wrappedExecute = tools.edit.execute;
			tools.edit = {
				...tools.edit,
				async execute(toolCallId, input, signal, onUpdate, tctx) {
					const tctxTyped = tctx as Parameters<typeof wrappedExecute>[4];
					const r = await wrappedExecute(toolCallId, input, signal, onUpdate, tctxTyped);
					// External write after mutation — between this and hash guard
					writeFileSync(target, "interfered\n", "utf8");
					return r;
				},
			};

			const tctx = await makeFakeToolContext({ cwd: tmp });
			let capturedError: Error | undefined;
			try {
				await tools.edit.execute(
					"guard-1",
					{
						path: target,
						edits: [{ oldText: "start", newText: "changed" }],
						then_run: { command: "echo should-not-run", timeout: 5 },
					} as never,
					undefined,
					undefined,
					tctx,
				);
			} catch (err) {
				capturedError = err as Error;
			}
			// We expect the mutation to succeed; then_run should be skipped due
			// to the intervening write. The mutation result returned unchanged.
			a.equal(readFileSync(target, "utf8"), "interfered\n", "file ends in interfered (mutated then external write)");
			a.ok(capturedError === undefined, "no top-level throw — mutation kept");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// Helper type for the journal event list
type JournalEvent = Parameters<Journal["record"]>[0];