/**
 * Tests for journal.formatLocalTime — the helper written into every
 * decision-journal entry so the user's local timezone is visible in the
 * log file. See session 2026-10-15T07-15-55Z where the user noticed that
 * the raw `timestamp` field is UTC ISO and they had to mentally subtract
 * 8 hours to match their local CST clock.
 */
import * as a from "node:assert";
import { describe, test } from "node:test";
import { formatLocalTime, createJournal } from "../shared/journal.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("formatLocalTime", () => {
	test("formats a Date in local timezone with explicit offset", () => {
		// Construct a Date whose UTC representation is 2026-10-15T07:33:25Z.
		// The local wall-clock depends on the runtime TZ, so we read it
		// back via Intl.DateTimeFormat for the comparison instead of
		// hard-coding an offset.
		const utc = new Date("2026-10-15T07:33:25.000Z");
		const got = formatLocalTime(utc);
		// Check: date separator + 24-hour time + offset suffix
		a.match(got, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/);
		// Round-trip: parse the suffix back to verify offset matches runtime
		const m = got.match(/([+-]\d{2}:\d{2}|Z)$/);
		a.ok(m, `no offset suffix: ${got}`);
		// The local HH:MM:SS, given the TZ of the runner, should match Intl
		const expected = utc.toLocaleString("en-US", {
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			year: "numeric", month: "2-digit", day: "2-digit",
			hour: "2-digit", minute: "2-digit", second: "2-digit",
			hour12: false,
		}).replace(/(\d+)\/(\d+)\/(\d+),?/, "$3-$1-$2");
		// Strip the offset we already appended
		const clockOnly = got.replace(/[+-]\d{2}:\d{2}|Z$/, "");
		const expectedNoOff = expected.replace(/[+-]\d{2}:\d{2}|Z$/, "");
		a.equal(clockOnly, expectedNoOff, `clock mismatch: got=${clockOnly} expected=${expectedNoOff}`);
	});

	test("offset suffix is +08:00 on a CST runner, Z on UTC", () => {
		const d = new Date("2026-10-15T00:00:00.000Z");
		const got = formatLocalTime(d);
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (tz === "UTC" || tz === "Etc/UTC") {
			a.match(got, /Z$/, `expected Z suffix on UTC runner, got ${got}`);
		} else if (tz === "Asia/Shanghai" || tz.startsWith("Asia/") && /CST|China/.test(tz)) {
			a.match(got, /\+08:00$/, `expected +08:00 on CST runner, got ${got}`);
		}
		// We don't fail in other TZs — just record what we got.
	});

	test("zero-pads single-digit month, day, hour, minute, second", () => {
		// 2026-01-05T03:01:04Z is a date that, in UTC, has 1/5/3/1/4 digits.
		const d = new Date("2026-01-05T03:01:04.000Z");
		const got = formatLocalTime(d);
		// Match the date+time portion: yyyy=4 digits, mm/dd/HH/MM/SS=2 digits each
		a.match(got, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
		const m = got.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
		a.ok(m);
		a.equal(m[1].length, 4);
		a.equal(m[2].length, 2);
		a.equal(m[3].length, 2);
		a.equal(m[4].length, 2);
		a.equal(m[5].length, 2);
		a.equal(m[6].length, 2);
	});

	test("writes both timestamp (UTC) and localTime into journal entries", async () => {
		const dir = mkdtempSync(join(tmpdir(), "journal-local-"));
		const path = join(dir, "decisions.jsonl");
		try {
			const j = createJournal(path);
			await j.record({ kind: "config_loaded", config: { x: 1 } });
			await j.record({
				kind: "online_compact_decision",
				compact: false,
				reason: "test",
				archiveTokens: 0,
				memoTokens: 0,
				writeTokens: 100,
				contextWindow: 200000,
			});
			const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
			a.equal(lines.length, 2);
			for (const l of lines) {
				const o = JSON.parse(l);
				// UTC timestamp with Z suffix
				a.match(o.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
				// Local time with offset suffix
				a.match(o.localTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/);
				// Timestamp now (UTC) and localTime (clock+offset) refer to the
				// same instant: differ by the offset in minutes.
				const utc = new Date(o.timestamp);
				const offsetMin = -utc.getTimezoneOffset();
				const localDate = new Date(utc.getTime() + offsetMin * 60_000);
				const expected = `${localDate.getUTCFullYear()}-${String(localDate.getUTCMonth()+1).padStart(2,"0")}-${String(localDate.getUTCDate()).padStart(2,"0")} ${String(localDate.getUTCHours()).padStart(2,"0")}:${String(localDate.getUTCMinutes()).padStart(2,"0")}:${String(localDate.getUTCSeconds()).padStart(2,"0")}`;
				a.equal(o.localTime.replace(/[+-]\d{2}:\d{2}|Z$/, ""), expected, `localTime mismatch for ${o.timestamp}`);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});