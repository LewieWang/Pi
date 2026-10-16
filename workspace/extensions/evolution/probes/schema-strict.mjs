#!/usr/bin/env node
/**
 * Probe 1 — schema-strict
 *
 * Calls readConfig() against a temp <home>/.pi/agent/sol-pi.json for
 * every shape we want to constrain. Acceptance:
 *   - accept*: parses without throwing
 *   - reject*: throws with "sol-pi config …" message
 *
 * This is the S2 regression red line for configuration. Any candidate
 * that softens "unknown key" handling or accepts wrong types will
 * drop this probe's pass, fail the red line, and get rolled back.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { readConfig } from "../../dist/shared/config.js";

function freshHome(suffix) {
	const home = mkdtempSync(join(tmpdir(), `probe-schema-${suffix}-`));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	return home;
}

function writeCfg(home, cfg) {
	writeFileSync(join(home, ".pi", "agent", "sol-pi.json"), JSON.stringify(cfg));
}

const CASES = [
	{ kind: "accept", label: "minimal valid {version:1}", cfg: { version: 1 } },
	{ kind: "accept", label: "harnessJournal={} defaults enabled=false", cfg: { version: 1, harnessJournal: {} } },
	{ kind: "accept", label: "harnessJournal.enabled=true", cfg: { version: 1, harnessJournal: { enabled: true } } },
	{ kind: "accept", label: "harnessJournal.maxSessions=10 (boundary)", cfg: { version: 1, harnessJournal: { enabled: true, maxSessions: 10 } } },
	{ kind: "accept", label: "harnessJournal.dir absolute path", cfg: { version: 1, harnessJournal: { dir: "C:/tmp/hj" } } },
	{ kind: "accept", label: "cacheWriteReadRatio=0.5", cfg: { version: 1, cacheWriteReadRatio: 0.5 } },
	{ kind: "accept", label: "cacheWriteReadRatio=0 (boundary)", cfg: { version: 1, cacheWriteReadRatio: 0 } },
	{ kind: "accept", label: "actionFusion+observationPack+reducer all on", cfg: { version: 1, actionFusion: true, observationPack: true, evidencePreservingReducer: true, onlineContextCompact: true } },

	{ kind: "reject", label: "harnessJournal.maxSessions=9 (below floor)", cfg: { version: 1, harnessJournal: { enabled: true, maxSessions: 9 } } },
	{ kind: "reject", label: "harnessJournal.maxSessions=10.5 (not integer)", cfg: { version: 1, harnessJournal: { enabled: true, maxSessions: 10.5 } } },
	{ kind: "reject", label: "harnessJournal.maxSessions='ten' (wrong type)", cfg: { version: 1, harnessJournal: { enabled: true, maxSessions: "ten" } } },
	{ kind: "reject", label: "harnessJournal.dir='' (empty)", cfg: { version: 1, harnessJournal: { dir: "" } } },
	{ kind: "reject", label: "harnessJournal.skillsBank=1 (wrong type)", cfg: { version: 1, harnessJournal: { skillsBank: 1 } } },
	{ kind: "reject", label: "harnessJournal unknown key 'wat'", cfg: { version: 1, harnessJournal: { wat: 1 } } },
	{ kind: "reject", label: "harnessJournal top-level is a string", cfg: { version: 1, harnessJournal: "yes" } },
	{ kind: "reject", label: "harnessJournal.enabled='yes' (wrong type)", cfg: { version: 1, harnessJournal: { enabled: "yes" } } },
	{ kind: "reject", label: "top-level unknown key 'wat'", cfg: { version: 1, wat: true } },
	{ kind: "reject", label: "cacheWriteReadRatio=-1 (negative)", cfg: { version: 1, cacheWriteReadRatio: -1 } },
	{ kind: "reject", label: "cacheWriteReadRatio=NaN", cfg: { version: 1, cacheWriteReadRatio: Number.NaN } },
	{ kind: "reject", label: "cacheWriteReadRatio='0.5' (string)", cfg: { version: 1, cacheWriteReadRatio: "0.5" } },
	{ kind: "reject", label: "actionFusion='yes' (string)", cfg: { version: 1, actionFusion: "yes" } },
	{ kind: "reject", label: "version=2 (only 1 supported)", cfg: { version: 2 } },
	{ kind: "reject", label: "version missing", cfg: { actionFusion: true } },
];

const ERROR_RE = /sol-pi config/;

export async function run() {
	const start = performance.now();
	const failures = [];
	let passed = 0;
	let i = 0;
	for (const c of CASES) {
		i++;
		const home = freshHome(i);
		writeCfg(home, c.cfg);
		try {
			const got = readConfig({ homeDir: home, projectTrusted: false });
			if (c.kind === "reject") {
				failures.push(`${c.label}: expected throw matching ${ERROR_RE} but got config ${JSON.stringify(got)}`);
			} else {
				passed++;
			}
		} catch (err) {
			const msg = err?.message ?? String(err);
			if (c.kind === "reject") {
				if (ERROR_RE.test(msg)) {
					passed++;
				} else {
					failures.push(`${c.label}: throw didn't match ${ERROR_RE}: ${msg}`);
				}
			} else {
				failures.push(`${c.label}: unexpected throw: ${msg}`);
			}
		}
	}
	const total = CASES.length;
	const score = Math.round((100 * passed) / total);
	const durationMs = Number((performance.now() - start).toFixed(1));
	return {
		name: "schema-strict",
		pass: failures.length === 0,
		score,
		durationMs,
		notes: failures.length === 0 ? `all ${total} schema assertions passed` : `${failures.length} of ${total} schema assertions failed`,
		failures,
	};
}
