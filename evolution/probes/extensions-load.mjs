#!/usr/bin/env node
/**
 * Probe 2 — extensions-load
 *
 * Verifies that every extension declared in package.json pi.extensions,
 * plus a few key shared modules, can be ESM-imported after `tsc` and
 * expose a recognizable factory function. This is the load-layer half
 * of the regression red line: an evolution candidate that breaks an
 * import (untyped export, broken path, missing dependency) trips this
 * probe and is rolled back.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const repoRoot = join(import.meta.dirname, "..", "..");
const distRoot = join(repoRoot, "dist");

function distFor(rel) {
	return join(distRoot, rel.replace(/\.ts$/, ".js"));
}

const SHARED_MODULES = [
	"shared/config.js",
	"shared/journal.js",
	"shared/sha256.js",
];

async function probe(modRel, factoryName) {
	const jsPath = modRel.replace(/\.ts$/, ".js");
	const candidate = join(distRoot, jsPath);
	if (!existsSync(candidate)) {
		return { ok: false, reason: `missing built file: ${jsPath}` };
	}
	try {
		const mod = await import(pathToFileURL(candidate).href);
		const keys = Object.keys(mod);
		const hasDefault = typeof mod.default === "function";
		const hasNamedFactory = factoryName ? typeof mod[factoryName] === "function" : false;
		const hasAnyCreate = keys.some((k) => /^create[A-Z]/.test(k) && typeof mod[k] === "function");
		// shared/helper modules are allowed to export pure functions only
		const isSharedHelper = modRel.startsWith("shared/") && !factoryName;
		const isPublic = hasDefault || hasNamedFactory || hasAnyCreate || isSharedHelper;
		if (!isPublic) {
			return { ok: false, reason: `no default factory or createXxx export (keys: ${keys.join(", ") || "<empty>"})` };
		}
		return { ok: true, hasDefault, hasNamedFactory, hasAnyCreate, exports: keys };
	} catch (err) {
		return { ok: false, reason: `import crashed: ${err?.message ?? String(err)}` };
	}
}

export async function run() {
	const start = performance.now();
	const failures = [];
	const observations = [];
	let passed = 0;

	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const entries = pkg.pi.extensions;

	// 1. Extensions declared in package.json
	for (const rel of entries) {
		const r = await probe(rel);
		observations.push({ file: rel, ...r });
		if (r.ok) passed++;
		else failures.push(`${rel}: ${r.reason}`);
	}

	// 2. Shared modules must import too (they underwrite every extension)
	for (const rel of SHARED_MODULES) {
		const r = await probe(rel);
		observations.push({ file: rel, ...r });
		if (r.ok) passed++;
		else failures.push(`${rel}: ${r.reason}`);
	}

	// 3. Bundle entry must export createSolPiBundle and be callable
	try {
		const bundleMod = await import(pathToFileURL(join(distRoot, "bundle", "index.js")).href);
		if (typeof bundleMod.createSolPiBundle !== "function") {
			failures.push("bundle/index.js: createSolPiBundle is not a function");
		} else {
			// Calling it returns an ExtensionFactory; calling that with a stub pi
			// only registers listeners (no IO), so this is safe + fast.
			try {
				const stubPi = {
					on: () => {},
					registerTool: () => {},
					registerCommand: () => {},
					registerProvider: () => {},
					registerEntryRenderer: () => {},
					appendEntry: () => {},
					getFlag: () => undefined,
					getSessionInfo: () => ({ sessionId: "probe", model: undefined }),
					sessionManager: { getSessionId: () => "probe-session" },
					model: undefined,
					isProjectTrusted: () => false,
					sendMessage: () => {},
					sendUserMessage: () => {},
					getContext: () => ({ messages: [], tools: [] }),
				};
				bundleMod.createSolPiBundle({ forceAll: true })(stubPi);
				passed++;
				observations.push({ file: "bundle/index.js", ok: true, note: "createSolPiBundle({forceAll:true}) ran without throw" });
			} catch (err) {
				failures.push(`bundle/index.js: createSolPiBundle({forceAll:true}) threw ${err?.message ?? String(err)}`);
			}
		}
	} catch (err) {
		failures.push(`bundle/index.js: import failed ${err?.message ?? String(err)}`);
	}

	const total = entries.length + SHARED_MODULES.length + 1;
	const score = Math.round((100 * passed) / total);
	const durationMs = Number((performance.now() - start).toFixed(1));
	return {
		name: "extensions-load",
		pass: failures.length === 0,
		score,
		durationMs,
		notes: failures.length === 0 ? `all ${total} module import + bundle call checks passed` : `${failures.length} of ${total} checks failed`,
		failures,
		observations,
	};
}
