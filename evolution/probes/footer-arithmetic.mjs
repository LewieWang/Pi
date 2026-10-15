#!/usr/bin/env node
/**
 * Probe 3 — footer-arithmetic
 *
 * Exercises the pure formatting helpers in footer-override._internal
 * (formatTokens, formatDuration). These are the formatting micro-rules
 * that the footer's "tokens / duration" display depends on — if a
 * candidate softens any of them (e.g. drops the "k"/"M" suffix on the
 * boundary), this probe fails and the candidate gets rolled back.
 */
import { performance } from "node:perf_hooks";
import { _internal } from "../../dist/footer-override/index.js";

const { formatTokens, formatDuration } = _internal;

const TOKENS_CASES = [
	[0, "0"],
	[500, "500"],
	[999, "999"],
	[1000, "1.0k"],
	[1500, "1.5k"],
	[9_500, "9.5k"],
	[9_999, "10.0k"],
	[10_000, "10k"],
	[12_345, "12k"],
	[99_999, "100k"],
	[100_000, "100k"],
	[500_000, "500k"],
	[999_499, "999k"],
	[1_000_000, "1.0M"],
	[5_500_000, "5.5M"],
	[10_000_000, "10M"],
	[50_000_000, "50M"],
];

const DURATION_CASES = [
	[0, "0s"],
	[999, "0s"],
	[1000, "1s"],
	[59_000, "59s"],
	[60_000, "1m"],
	[90_000, "1m 30s"],
	[3_599_000, "59m 59s"],
	[3_600_000, "1h"],
	[3_660_000, "1h 1m"],
	[7_200_000, "2h"],
	[7_261_000, "2h 1m"],
];

function eq(actual, expected) {
	return actual === expected;
}

export async function run() {
	const start = performance.now();
	const failures = [];
	let passed = 0;
	let total = 0;

	for (const [input, expected] of TOKENS_CASES) {
		total++;
		const actual = formatTokens(input);
		if (eq(actual, expected)) {
			passed++;
		} else {
			failures.push(`formatTokens(${input}): expected "${expected}" got "${actual}"`);
		}
	}

	for (const [input, expected] of DURATION_CASES) {
		total++;
		const actual = formatDuration(input);
		if (eq(actual, expected)) {
			passed++;
		} else {
			failures.push(`formatDuration(${input}): expected "${expected}" got "${actual}"`);
		}
	}

	// Idempotence: formatTokens must be a pure function with no global state
	for (let i = 0; i < 3; i++) {
		total++;
		const a = formatTokens(12345);
		const b = formatTokens(12345);
		if (a === b && a === "12k") passed++;
		else failures.push(`formatTokens not stable on call #${i + 1}: ${a} vs ${b}`);
	}

	// Monotonicity on numbers in the same band (no surprising collapses)
	const monotonicInputs = [2000, 20_000, 200_000, 2_000_000, 20_000_000];
	function normalize(s) {
		const m = s.match(/^([0-9]+(?:\.[0-9]+)?)([kM]?)$/);
		if (!m) return NaN;
		const v = parseFloat(m[1]);
		return m[2] === "k" ? v * 1e3 : m[2] === "M" ? v * 1e6 : v;
	}
	total++;
	let monotonic = true;
	let prev = 0;
	for (const n of monotonicInputs) {
		const v = normalize(formatTokens(n));
		if (!(v > prev)) { monotonic = false; break; }
		prev = v;
	}
	if (monotonic) passed++;
	else failures.push(`formatTokens not strictly monotonic: ${monotonicInputs.map(formatTokens).join(" < ")}`);

	const score = Math.round((100 * passed) / total);
	const durationMs = Number((performance.now() - start).toFixed(1));
	return {
		name: "footer-arithmetic",
		pass: failures.length === 0,
		score,
		durationMs,
		notes: failures.length === 0 ? `all ${total} format assertions passed` : `${failures.length} of ${total} format assertions failed`,
		failures,
	};
}
