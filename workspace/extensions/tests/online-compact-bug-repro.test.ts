// _repro_bug.test.ts — verify the fix against the bug's exact scenario.
// Reproduces the 3 abort turns from session 2026-10-15T06-40-47-400Z:
//   writeTokens crosses 0.7 of 200K window
//   plan is empty
//   no prior compactions
import * as a from "node:assert";
import { describe, test } from "node:test";
import { decideCompaction, shouldFireAbort, DEFAULT_ECONOMICS } from "../online-compact/economics.js";
import { initialOnlineState, recordProviderRequest } from "../online-compact/state.js";

describe("bug repro: session 2026-10-15T06-40-47-400Z", () => {
	const cases = [
		{ writeTokens: 145958, ts: "07:11:58.283" },
		{ writeTokens: 150752, ts: "07:15:11.869" },
		{ writeTokens: 141437, ts: "07:15:47.245" },
	];

	for (const s of cases) {
		test(`abort suppressed at ${s.ts} (writeTokens=${s.writeTokens})`, () => {
			let state = initialOnlineState();
			state = recordProviderRequest(state, s.writeTokens);

			// decideCompaction: bug-era behavior — would say compact=true
			const decision = decideCompaction({
				writeTokens: s.writeTokens,
				contextWindow: 200_000,
				completionBoundary: true,
				requestsSinceLast:
					state.lastCompactionRequestCount === null
						? null
						: state.requestCount - state.lastCompactionRequestCount,
				cacheWriteReadRatio: 0.0,
				economics: DEFAULT_ECONOMICS,
			});
			a.equal(decision.compact, true, `decideCompaction should still say compact: ${decision.reason}`);

			// NEW: shouldFireAbort must now refuse (the fix)
			const gate = shouldFireAbort(state);
			a.equal(gate.fire, false, "must not abort");
			a.equal(gate.reason, "empty-plan", `reason must be empty-plan, got ${gate.reason}`);
		});
	}
});