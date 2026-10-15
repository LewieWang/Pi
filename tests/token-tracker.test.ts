/**
 * Token Tracker tests.
 *
 * Covers the pure logic: usage accumulation, hit ratio, savings, and
 * the formatter line / block shapes (snapshot-styled so a tweak to the
 * box drawing flags only when intended).
 */

import * as a from "node:assert";
import { describe, test } from "node:test";
import { formatInt, pad } from "../token-tracker/format.js";
import {
	addToolResult,
	addTurn,
	addUsage,
	addUserMessage,
	cacheHitRatio,
	cacheHitSavings,
	emptyStats,
	zeroUsage,
	type TokenUsage,
} from "../token-tracker/state.js";

describe("formatInt", () => {
	test("renders small ints raw", () => {
		a.equal(formatInt(0), "0");
		a.equal(formatInt(999), "999");
	});
	test("renders thousands as K", () => {
		a.equal(formatInt(1000), "1\u202FK");
		a.equal(formatInt(12_345), "12.3\u202FK");
	});
	test("renders millions as M", () => {
		a.equal(formatInt(1_500_000), "1.5\u202FM");
	});
});

describe("pad", () => {
	test("pads with spaces", () => {
		const padded = pad("in", 5);
		a.equal(padded.length, 5);
		a.equal(padded.startsWith("in"), true);
	});
});

describe("addUsage", () => {
	test("zero + zero = zero", () => {
		const s = addUsage(zeroUsage(), zeroUsage());
		a.equal(s.input, 0);
		a.equal(s.cacheWrite1h, undefined);
	});
	test("sums and keeps optional fields present when any input had them", () => {
		const a1: TokenUsage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 20 };
		const a2: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const s = addUsage(a1, a2);
		a.equal(s.input, 100);
		a.equal(s.output, 50);
		a.equal(s.cacheWrite1h, 20);
	});
});

describe("session stats", () => {
	test("addTurn increments and accumulates", () => {
		const usage: TokenUsage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10 };
		const s = addTurn(emptyStats(), usage, 1000);
		a.equal(s.turns, 1);
		a.equal(s.assistantMessages, 1);
		a.equal(s.firstTurnAt, 1000);
		a.equal(s.lastTurnAt, 1000);
		a.equal(s.total.input, 100);
		a.equal(s.total.output, 20);
		a.equal(s.total.cacheRead, 30);
		a.equal(s.total.cacheWrite, 10);
	});

	test("addUserMessage increments user count", () => {
		const s = addUserMessage(emptyStats());
		a.equal(s.userMessages, 1);
	});

	test("addToolResult increments tool count", () => {
		const s = addToolResult(emptyStats(), 3);
		a.equal(s.toolResults, 3);
	});

	test("cacheHitRatio is cacheRead / (input + cacheRead)", () => {
		const stats = addTurn(
			addTurn(emptyStats(), { input: 100, output: 0, cacheRead: 50, cacheWrite: 0 }, 1),
			{ input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
			2,
		);
		const r = cacheHitRatio(stats);
		// cacheRead = 50, input = 200, ratio = 50/250 = 0.2
		a.ok(Math.abs(r - 0.2) < 1e-9);
	});

	test("cacheHitRatio is 0 with no usage", () => {
		a.equal(cacheHitRatio(emptyStats()), 0);
	});

	test("cacheHitSavings uses writeReadRatio", () => {
		const stats = addTurn(emptyStats(), { input: 0, output: 0, cacheRead: 1000, cacheWrite: 0 }, 1);
		a.equal(cacheHitSavings(stats, 0), 0);
		a.equal(cacheHitSavings(stats, 1), 1000);
		a.equal(cacheHitSavings(stats, 4), 4000);
	});
});