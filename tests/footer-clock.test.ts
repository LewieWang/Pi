/**
 * Tests for footer-override's new formatClockLocal / formatTzOffset
 * helpers. These render the session's local wall-clock + tz offset in the
 * footer, so the user doesn't have to mentally subtract hours.
 */
import * as a from "node:assert";
import { describe, test } from "node:test";
import { formatClockLocal, formatTzOffset } from "../footer-override/index.js";

describe("formatClockLocal", () => {
	test("formats a Date in local timezone as HH:MM:SS", () => {
		const utc = new Date("2026-10-15T07:33:25.000Z");
		const got = formatClockLocal(utc);
		a.match(got, /^\d{2}:\d{2}:\d{2}$/);
		// Cross-check via Intl for the runner's TZ
		const expected = utc.toLocaleTimeString("en-US", {
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			hour12: false,
		});
		a.equal(got, expected);
	});

	test("zero-pads single-digit hours, minutes, seconds", () => {
		// A UTC time that, in any TZ, has small digits after rounding —
		// we just verify the output shape, not the value.
		const d = new Date("2026-10-15T03:01:04.000Z");
		const got = formatClockLocal(d);
		a.match(got, /^\d{2}:\d{2}:\d{2}$/);
		// Each component is 2 chars
		const [h, m, s] = got.split(":");
		a.equal(h.length, 2);
		a.equal(m.length, 2);
		a.equal(s.length, 2);
	});
});

describe("formatTzOffset", () => {
	test("returns Z on UTC runner", () => {
		const d = new Date("2026-10-15T00:00:00.000Z");
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (tz === "UTC" || tz === "Etc/UTC") {
			a.equal(formatTzOffset(d), "Z");
		} else {
			// Non-UTC runner — just verify it has a non-Z offset
			a.notEqual(formatTzOffset(d), "Z");
			a.match(formatTzOffset(d), /^[+-]\d{2}:\d{2}$/);
		}
	});

	test("returns +08:00 on a CST runner", () => {
		const d = new Date("2026-10-15T00:00:00.000Z");
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (tz === "Asia/Shanghai" || (tz.startsWith("Asia/") && /CST|China/.test(tz))) {
			a.equal(formatTzOffset(d), "+08:00");
		}
		// Don't fail in other TZs.
	});

	test("zero-pads hour and minute in offset", () => {
		const d = new Date("2026-10-15T00:00:00.000Z");
		const off = formatTzOffset(d);
		if (off !== "Z") {
			a.match(off, /^[+-]\d{2}:\d{2}$/);
		}
	});
});