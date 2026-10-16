#!/usr/bin/env node
/**
 * evolution/probes/run.mjs — probe orchestrator.
 *
 * Usage:
 *   node evolution/probes/run.mjs              # all probes, NDJSON to stdout
 *   node evolution/probes/run.mjs schema-strict # single probe
 *   node evolution/probes/run.mjs --json       # all probes, single JSON object
 *
 * Exit code:
 *   0 — every probe passed
 *   1 — at least one probe failed (regression)
 *
 * Cost discipline: each probe must finish well under 30 s. Total
 * budget < 2 min. No LLM calls.
 */
import { performance } from "node:perf_hooks";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** @type {Array<{name:string, file:string}>} */
const probes = [
	{ name: "schema-strict", file: "schema-strict.mjs" },
	{ name: "extensions-load", file: "extensions-load.mjs" },
	{ name: "footer-arithmetic", file: "footer-arithmetic.mjs" },
	{ name: "harness-journal-arithmetic", file: "harness-journal-arithmetic.mjs" },
];

function parseArgs(argv) {
	const out = { names: new Set(), json: false };
	for (const a of argv.slice(2)) {
		if (a === "--json") out.json = true;
		else if (a === "--help" || a === "-h") out.help = true;
		else out.names.add(a);
	}
	return out;
}

async function loadProbe(file) {
	const url = pathToFileURL(join(here, file)).href;
	const mod = await import(url);
	if (typeof mod.run !== "function") {
		throw new Error(`probe ${file} has no exported run()`);
	}
	return mod.run;
}

function fmtDuration(ms) {
	return ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function renderTable(results) {
	const header = ["probe", "pass", "score", "duration"];
	const rows = results.map((r) => [
		r.name,
		r.pass ? "✓" : "✗",
		String(r.score),
		fmtDuration(r.durationMs),
	]);
	const widths = header.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
	);
	const sep = widths.map((w) => "-".repeat(w)).join(" ");
	const lines = [];
	lines.push(header.map((h, i) => h.padEnd(widths[i])).join("  "));
	lines.push(sep);
	for (const r of rows) lines.push(r.map((c, i) => String(c).padEnd(widths[i])).join("  "));
	return lines.join("\n");
}

async function main() {
	const args = parseArgs(process.argv);
	if (args.help) {
		process.stdout.write(`Usage: node evolution/probes/run.mjs [name ...] [--json]\n\nProbes:\n${probes.map((p) => `  - ${p.name}`).join("\n")}\n`);
		return 0;
	}
	const selected = probes.filter((p) => args.names.size === 0 || args.names.has(p.name));
	if (selected.length === 0) {
		process.stderr.write(`No matching probes. Available: ${probes.map((p) => p.name).join(", ")}\n`);
		return 2;
	}
	const totalStart = performance.now();
	const results = [];
	for (const p of selected) {
		try {
			const runner = await loadProbe(p.file);
			const result = await runner();
			results.push({
				name: result.name ?? p.name,
				pass: !!result.pass,
				score: typeof result.score === "number" ? result.score : 0,
				durationMs: Number(result.durationMs ?? 0),
				notes: result.notes ?? "",
				failures: result.failures ?? [],
			});
		} catch (err) {
			results.push({
				name: p.name,
				pass: false,
				score: 0,
				durationMs: Number((performance.now() - totalStart).toFixed(1)),
				notes: `probe crashed: ${err?.message ?? String(err)}`,
				failures: [`<internal>: ${err?.message ?? String(err)}`],
			});
		}
	}
	const totalMs = Number((performance.now() - totalStart).toFixed(1));
	const allPass = results.every((r) => r.pass);
	const aggregateScore = Math.round(results.reduce((a, r) => a + r.score, 0) / Math.max(1, results.length));

	if (args.json) {
		process.stdout.write(
			JSON.stringify(
				{
					pass: allPass,
					aggregateScore,
					totalDurationMs: totalMs,
					probes: results,
				},
				null,
				2,
			) + "\n",
		);
	} else {
		for (const r of results) {
			process.stdout.write(JSON.stringify(r) + "\n");
		}
		process.stderr.write("\n" + renderTable(results) + `\n\naggregate: ${aggregateScore}/100 · total: ${fmtDuration(totalMs)} · ${allPass ? "PASS" : "FAIL"}\n`);
		if (!allPass) {
			for (const r of results.filter((r) => !r.pass)) {
				process.stderr.write(`\n✗ ${r.name}: ${r.notes}\n`);
				for (const f of r.failures.slice(0, 10)) {
					process.stderr.write(`    - ${f}\n`);
				}
				if (r.failures.length > 10) process.stderr.write(`    ... +${r.failures.length - 10} more\n`);
			}
		}
	}
	return allPass ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		process.stderr.write(`runner crashed: ${err?.stack ?? err}\n`);
		process.exit(2);
	},
);
