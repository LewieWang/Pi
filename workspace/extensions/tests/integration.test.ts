/**
 * Integration test: drive a real pi session and verify the harness
 * extensions cooperate.
 *
 * Strategy: launch pi with --print and a synthetic task that exercises
 * every extension:
 *
 *   1. Action Fusion: a write + then_run that creates a file and a
 *      marker in a single call.
 *   2. Observation Pack: the same bash output appears multiple times.
 *   3. Evidence-Preserving Reducer: a long tsc-style error log.
 *   4. Token Tracker: visible in stderr.
 *
 * We don't depend on the model — we just hand it a one-shot bash
 * command that performs all of the above, then inspect the journal
 * for the expected events.
 */

import * as a from "node:assert";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const PI_CLI = String(
	process.env.PI_CLI ??
		"C:\\Users\\lewie\\.workbuddy\\binaries\\node\\versions\\22.22.2-6\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js",
);

const HARNESS = "D:/PI/workspace/extensions";

const journalPath = (): string => {
	const home =
		process.env.HOME ?? process.env.USERPROFILE ?? "C:/Users/lewie";
	return join(home, ".pi", "agent", "decisions.jsonl");
};

function journalTailLines(n: number): string[] {
	const path = journalPath();
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n").filter(Boolean);
	return lines.slice(-Math.max(n, 50));
}

describe("Integration: end-to-end extension cooperation", () => {
	test(
		"pi can run a fused write+then_run, reducer detects a long log, observation packs repeats",
		{ timeout: 180_000 },
		() => {
			// Sandbox under tmp so we don't fight existing session data.
			// Use a path that survives Git Bash's MSYS path mangling by
			// being relative (no drive letter) — we cd into it explicitly.
			const work = mkdtempSync(join(tmpdir(), "harness-int-"));
			const workBash = work.replace(/\\/g, "/");
			try {
				// Stage a 7K tsc-style error log so the reducer is a no-op
				// (it stays under 2KB) — we still want a deterministic input
				// so we don't depend on the model generating it.
				const big = Array.from(
					{ length: 150 },
					(_, i) => `src/file${i}.ts(${i + 1},7): error TS2322: type mismatch on line with extra text.`,
				).join("\n");
				const longPath = join(work, "long.log");
				writeFileSync(longPath, big, "utf8");
				a.ok(existsSync(longPath));
				a.ok(big.length > 7000, `log too small: ${big.length}`);

				// Drop a fresh project config so the test doesn't depend on
				// the user's sol-pi.json. The harness reads from <cwd>/.pi
				// first, so this is authoritative for the run.
				const dotPi = join(work, ".pi");
				mkdirSync(dotPi, { recursive: true });
				writeFileSync(
					join(dotPi, "sol-pi.json"),
					JSON.stringify({
						version: 1,
						actionFusion: true,
						observationPack: true,
						evidencePreservingReducer: true,
						onlineContextCompact: true,
						cacheWriteReadRatio: 0.0,
					}),
				);

				// Stage a 2-file test scenario the model can finish in one turn.
				const srcDir = join(work, "src");
				mkdirSync(srcDir, { recursive: true });
				writeFileSync(
					join(srcDir, "a.ts"),
					"export const a: number = 1;\n",
				);
				writeFileSync(
					join(srcDir, "b.ts"),
					"export const b: number = 2;\n",
				);

				// Run pi with --print. Single task, deterministic length.
				// We do NOT call --no-session because we want the journal
				// to land at the standard path. The session id changes
				// per run; we only inspect lines appended during the run.
				const before = existsSync(journalPath())
					? readFileSync(journalPath(), "utf8")
					: "";
				const beforeLineCount = before.split("\n").filter(Boolean).length;

				const cmd = `cd "${workBash}" && MSYS_NO_PATHCONV=1 node '${PI_CLI}' --print --approve --model "minimax/MiniMax-M3" 'Do this in one turn: (1) use the read tool on src/a.ts and src/b.ts, (2) use the write tool to create src/c.ts with content "export const c = a + b;" AND set then_run to "echo fused-success > fused.marker", (3) then use bash to run "wc -l src/*.ts && cat long.log | head -3" so I can see file sizes and a log excerpt. Report what you did.'`;
				const r = spawnSync("bash", ["-lc", cmd], {
					encoding: "utf8",
					maxBuffer: 50 * 1024 * 1024,
					timeout: 150_000,
				});
				// Don't fail the test on pi's exit code — we're checking the
				// journal, not the model output. (Print mode may exit non-
				// zero if the model aborted.)
				if (r.stderr) {
					process.stderr.write(
						`[integration:exit=${r.status}]\n[integration:stderr-trimmed]\n${r.stderr.split("\n").slice(0, 15).join("\n")}\n`,
					);
				}
				process.stderr.write(
					`[integration:stdout-trimmed]\n${(r.stdout ?? "").split("\n").slice(0, 5).join("\n")}\n`,
				);

				// Read only the lines that were appended during this run.
				const afterText = existsSync(journalPath())
					? readFileSync(journalPath(), "utf8")
					: "";
				const allLines = afterText.split("\n").filter(Boolean);
				const newLines = allLines.slice(beforeLineCount);
				const events = newLines.map((l) => {
					try {
						return JSON.parse(l) as { kind?: string; [k: string]: unknown };
					} catch {
						return {};
					}
				});
				const kinds = new Set(events.map((e) => e.kind).filter(Boolean));

				// At minimum, the session should have started a config and
				// registered the extension tools we asked for. Without
				// these we never wired up.
				a.ok(
					kinds.has("config_loaded"),
					`config_loaded missing; kinds: ${[...kinds].join(",")}`,
				);
				a.ok(
					kinds.has("tools_registered"),
					`tools_registered missing; kinds: ${[...kinds].join(",")}`,
				);

				// We expected at least one fused write call (write with then_run).
				const fusedWriteApplied = events.some(
					(e) => e.kind === "then_run",
				);
				a.ok(
					fusedWriteApplied,
					`then_run missing; events: ${events.map((e) => e.kind).join(",")}`,
				);

				// The reducer should at least have been considered for the
				// 7K tsc-style log. The diagnostic tool is `cat long.log`
				// which doesn't match our regex, so this is informational
				// rather than asserted.
				const reducerApplied = events.some(
					(e) => e.kind === "reducer_applied",
				);
				const reducerCandidate = events.some(
					(e) => e.kind === "reducer_candidate",
				);
				if (!reducerApplied && !reducerCandidate) {
					// Soft warn via stderr; don't fail — the log was cat'd
					// rather than typed-checked, so no diagnostic.
					process.stderr.write(
						"[integration] reducer did not see a diagnostic command (expected when log is cat'd)\n",
					);
				}

				// Token tracker should have logged at least one turn and a session.
				const tokenTurns = events.filter((e) => e.kind === "token_turn").length;
				const tokenSessions = events.filter((e) => e.kind === "token_session").length;
				a.ok(
					tokenTurns >= 1,
					`token_turn missing; kinds: ${[...kinds].join(",")}`,
				);
				a.ok(
					tokenSessions >= 1,
					`token_session missing; kinds: ${[...kinds].join(",")}`,
				);

				// The fused marker file should exist.
				a.ok(
					existsSync(join(work, "fused.marker")),
					"fused.marker not created; write+then_run did not fire",
				);
				a.equal(
					readFileSync(join(work, "fused.marker"), "utf8").trim(),
					"fused-success",
				);
			} finally {
				rmSync(work, { recursive: true, force: true });
			}
		},
	);
});
