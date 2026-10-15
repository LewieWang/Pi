/**
 * Off-switch verification: when sol-pi.json has actionFusion=false, the
 * extension must NOT register a fused replacement. We test the underlying
 * config loader to verify the strict semantics.
 */

import * as a from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readConfig } from "../shared/config.js";

function withTmpHome<T>(fn: (home: string) => T): T {
	const home = mkdtempSync(join(tmpdir(), "off-home-"));
	try {
		return fn(home);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

describe("Off-switch (config loader)", () => {
	test("default config has actionFusion=false", () => {
		withTmpHome((home) => {
			// projectTrusted=false skips project file lookup; home has no sol-pi.json
			const cfg = readConfig({ projectTrusted: false, homeDir: home });
			a.equal(cfg.actionFusion, false);
			a.equal(cfg.observationPack, false);
			a.equal(cfg.evidencePreservingReducer, false);
			a.equal(cfg.onlineContextCompact, false);
			a.equal(cfg.cacheWriteReadRatio, 1.0);
		});
	});

	test("project config takes precedence over home", () => {
		withTmpHome((home) => {
			mkdirSync(join(home, ".pi", "agent"), { recursive: true });
			writeFileSync(
				join(home, ".pi", "agent", "sol-pi.json"),
				JSON.stringify({ version: 1, actionFusion: true }),
			);

			const project = mkdtempSync(join(tmpdir(), "off-proj-"));
			try {
				mkdirSync(join(project, ".pi"), { recursive: true });
				writeFileSync(
					join(project, ".pi", "sol-pi.json"),
					JSON.stringify({ version: 1, actionFusion: false }),
				);

				const oldCwd = process.cwd();
				process.chdir(project);
				try {
					const cfg = readConfig({ projectTrusted: true, homeDir: home });
					a.equal(cfg.actionFusion, false, "project file wins");
				} finally {
					process.chdir(oldCwd);
				}
			} finally {
				rmSync(project, { recursive: true, force: true });
			}
		});
	});

	test("strict schema rejects unknown key", () => {
		withTmpHome((home) => {
			const project = mkdtempSync(join(tmpdir(), "off-proj-"));
			try {
				mkdirSync(join(project, ".pi"), { recursive: true });
				writeFileSync(
					join(project, ".pi", "sol-pi.json"),
					JSON.stringify({
						version: 1,
						actionFusion: true,
						unknownFeature: true,
					}),
				);

				const oldCwd = process.cwd();
				process.chdir(project);
				try {
					a.throws(
						() => readConfig({ projectTrusted: true, homeDir: home }),
						/Unknown sol-pi config key/,
					);
				} finally {
					process.chdir(oldCwd);
				}
			} finally {
				rmSync(project, { recursive: true, force: true });
			}
		});
	});

	test("strict schema rejects non-boolean actionFusion", () => {
		withTmpHome((home) => {
			const project = mkdtempSync(join(tmpdir(), "off-proj-"));
			try {
				mkdirSync(join(project, ".pi"), { recursive: true });
				writeFileSync(
					join(project, ".pi", "sol-pi.json"),
					JSON.stringify({ version: 1, actionFusion: "yes" }),
				);

				const oldCwd = process.cwd();
				process.chdir(project);
				try {
					a.throws(
						() => readConfig({ projectTrusted: true, homeDir: home }),
						/actionFusion must be boolean/,
					);
				} finally {
					process.chdir(oldCwd);
				}
			} finally {
				rmSync(project, { recursive: true, force: true });
			}
		});
	});

	test("rejects invalid cacheWriteReadRatio (negative)", () => {
		withTmpHome((home) => {
			const project = mkdtempSync(join(tmpdir(), "off-proj-"));
			try {
				mkdirSync(join(project, ".pi"), { recursive: true });
				writeFileSync(
					join(project, ".pi", "sol-pi.json"),
					JSON.stringify({ version: 1, cacheWriteReadRatio: -1 }),
				);

				const oldCwd = process.cwd();
				process.chdir(project);
				try {
					a.throws(
						() => readConfig({ projectTrusted: true, homeDir: home }),
						/cacheWriteReadRatio/,
					);
				} finally {
					process.chdir(oldCwd);
				}
			} finally {
				rmSync(project, { recursive: true, force: true });
			}
		});
	});

	test("rejects invalid cacheWriteReadRatio (non-numeric)", () => {
		withTmpHome((home) => {
			const project = mkdtempSync(join(tmpdir(), "off-proj-"));
			try {
				mkdirSync(join(project, ".pi"), { recursive: true });
				writeFileSync(
					join(project, ".pi", "sol-pi.json"),
					JSON.stringify({ version: 1, cacheWriteReadRatio: "1.0" }),
				);

				const oldCwd = process.cwd();
				process.chdir(project);
				try {
					a.throws(
						() => readConfig({ projectTrusted: true, homeDir: home }),
						/cacheWriteReadRatio/,
					);
				} finally {
					process.chdir(oldCwd);
				}
			} finally {
				rmSync(project, { recursive: true, force: true });
			}
		});
	});

	test("rejects version mismatch", () => {
		withTmpHome((home) => {
			const project = mkdtempSync(join(tmpdir(), "off-proj-"));
			try {
				mkdirSync(join(project, ".pi"), { recursive: true });
				writeFileSync(
					join(project, ".pi", "sol-pi.json"),
					JSON.stringify({ version: 2, actionFusion: true }),
				);

				const oldCwd = process.cwd();
				process.chdir(project);
				try {
					a.throws(
						() => readConfig({ projectTrusted: true, homeDir: home }),
						/version must be 1/,
					);
				} finally {
					process.chdir(oldCwd);
				}
			} finally {
				rmSync(project, { recursive: true, force: true });
			}
		});
	});
});