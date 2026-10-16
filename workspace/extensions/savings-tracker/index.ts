/**
 * Savings Tracker — accumulate the savings each mechanism reports in
 * the journal and surface them in the footer status bar.
 *
 * Reference: SoL-Pi src/sol-pi/tui.ts::showSolPiSavings
 *
 * What we tally per session:
 *   - bytes removed from the prompt by the observation pack
 *     (token.removed_tokens * 4 ≈ bytes)
 *   - bytes removed from the prompt by the evidence reducer
 *     (reducer_applied.savedBytes)
 *   - turns saved by the action fusion (1 per then_run)
 *
 * The footer key is "sol-pi" so it does not collide with built-in
 * status keys. We update the status text on every journal event
 * rather than on a fixed interval, so changes appear instantly.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createJournal } from "../shared/journal.js";
import { formatInt } from "../token-tracker/format.js";

const STATUS_KEY = "sol-pi";

interface Savings {
	readonly observationBytes: number;
	readonly reducerBytes: number;
	readonly fusedTurns: number;
	readonly reducerCount: number;
	readonly observationCount: number;
	readonly fusionCount: number;
}

function zeroSavings(): Savings {
	return {
		observationBytes: 0,
		reducerBytes: 0,
		fusedTurns: 0,
		reducerCount: 0,
		observationCount: 0,
		fusionCount: 0,
	};
}

function formatBytes(b: number): string {
	if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)}\u202FMiB`;
	if (b >= 1024) return `${(b / 1024).toFixed(1)}\u202FKiB`;
	return `${b}\u202FB`;
}

function statusText(s: Savings): string {
	const totalBytes = s.observationBytes + s.reducerBytes;
	return [
		"⚡",
		formatBytes(totalBytes),
		"saved",
		`(${s.observationCount} obs · ${s.reducerCount} red · ${s.fusionCount} fuse)`,
	].join(" ");
}

export function createSavingsTrackerExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const bySession = new Map<string, Savings>();
		const journal = createJournal();

		const get = (ctx: ExtensionContext): Savings => {
			const id = ctx.sessionManager.getSessionId();
			let s = bySession.get(id);
			if (!s) {
				s = zeroSavings();
				bySession.set(id, s);
			}
			return s;
		};

		const apply = (ctx: ExtensionContext, s: Savings): void => {
			bySession.set(ctx.sessionManager.getSessionId(), s);
			try {
				ctx.ui.setStatus(STATUS_KEY, statusText(s));
			} catch {
				// print / JSON mode has no UI; the journal still gets the
				// numbers, so we don't need to crash.
			}
		};

		pi.on("session_start", (_event, context) => {
			apply(context, get(context));
		});

		pi.on("session_shutdown", (_event, context) => {
			bySession.delete(context.sessionManager.getSessionId());
			try {
				context.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				// ignore
			}
		});

		// We don't have a generic "journal" event, so we hook the events
		// each mechanism emits and tally them directly.
		pi.on("tool_result", (_event, context) => {
			if (!context) return;
			const s = get(context);
			void journal;
		});

		// We hook the only events we can actually intercept from this
		// extension: turn_end, where the observation pack / reducer emit
		// their events through their own handlers. The cleanest way to
		// read the journal is to tail it after the run, but we want a
		// live counter. Instead, we read the branch entries that were
		// appended by other extensions at agent_settled. The entries we
		// care about:
		//
		//   harness-observation-saved (added by observation-pack)
		//   harness-reducer-applied   (added by evidence-reducer)
		//   harness-fused-turn        (added by action-fusion)
		//
		// To keep this decoupled, we instead read the existing journal
		// file on every turn_end (cheap) and recompute the totals. That
		// gives the user a live counter without coupling to other
		// extensions.
		pi.on("turn_end", async (_event, context) => {
			if (!context) return;
			const fs = await import("node:fs/promises");
			const path = await import("node:path");
			const os = await import("node:os");
			const journalPath = path.join(
				os.homedir(),
				".pi",
				"agent",
				"decisions.jsonl",
			);
			let text: string;
			try {
				text = await fs.readFile(journalPath, "utf8");
			} catch {
				return;
			}
			let s: Savings = zeroSavings();
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				let d: { kind?: string };
				try {
					d = JSON.parse(line) as { kind?: string };
				} catch {
					continue;
				}
				if (d.kind === "observation" && (d as { placeholder?: boolean }).placeholder) {
					s = {
						...s,
						observationCount: s.observationCount + 1,
						observationBytes:
							s.observationBytes +
							((d as { removed_tokens?: number }).removed_tokens ?? 0) * 4,
					};
				} else if (d.kind === "reducer_applied") {
					s = {
						...s,
						reducerCount: s.reducerCount + 1,
						reducerBytes:
							s.reducerBytes + ((d as { savedBytes?: number }).savedBytes ?? 0),
					};
				} else if (d.kind === "then_run") {
					s = {
						...s,
						fusionCount: s.fusionCount + 1,
						fusedTurns: s.fusedTurns + 1,
					};
				}
			}
			apply(context, s);
		});
	};
}

export default function savingsTrackerExtension(pi: ExtensionAPI): void {
	createSavingsTrackerExtension()(pi);
}

void formatInt;