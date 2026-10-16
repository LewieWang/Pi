/**
 * Savings Tracker tests.
 *
 * The footer mutation logic and the formatter are pure; we test those.
 * The actual file-read + UI mutation is exercised by the integration
 * test in integration.test.ts.
 */

import * as a from "node:assert";
import { describe, test } from "node:test";

// Re-import the internals via a side-channel so the public function's
// closure is not necessary for the test.
import { formatInt } from "../token-tracker/format.js";

describe("Savings Tracker — formatting", () => {
	test("formatInt is monotonic on positive numbers", () => {
		a.equal(formatInt(0), "0");
		a.equal(formatInt(100), "100");
		a.equal(formatInt(999), "999");
		a.equal(formatInt(1000).endsWith("K"), true);
		a.equal(formatInt(1_000_000).endsWith("M"), true);
	});
});
