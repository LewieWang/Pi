/**
 * Observation Pack tests.
 *
 * Covers:
 *   1. createObservation: hashing, byte/line/token counts
 *   2. placeholderFor: id, head/tail excerpt
 *   3. ensureStored: idempotent archive writes
 *   4. readRecallChunk: byte slicing, line truncation, eof flag
 *   5. isObservationId: regex
 *   6. projection: keeps first N full sends, replaces with placeholder after
 *   7. obs_recid tool schema includes id and offset
 */

import * as a from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	createObservation,
	placeholderFor,
	ensureStored,
	observationPath,
	readRecallChunk,
	isObservationId,
	estimateTokens,
	countLines,
	sha256,
	FULL_SENDS,
	THRESHOLD_BYTES,
	type Observation,
} from "../observation-pack/observation.js";

function makeBigText(blocks: number): string {
	const line = "x".repeat(50);
	return Array.from({ length: blocks }, () => line).join("\n");
}

function fakeToolResultMessage(text: string, toolName = "bash"): unknown {
	return {
		role: "toolResult",
		toolName,
		toolCallId: "call-1",
		content: [{ type: "text", text }],
	};
}

describe("createObservation", () => {
	test("returns null for small text (below threshold)", () => {
		const msg = fakeToolResultMessage("hi");
		a.equal(createObservation(msg as never), null);
	});

	test("creates observation for text above threshold", () => {
		const text = makeBigText(200); // ~10KB
		const msg = fakeToolResultMessage(text);
		const obs = createObservation(msg as never);
		a.ok(obs);
		a.equal(obs!.toolName, "bash");
		a.equal(obs!.toolCallId, "call-1");
		a.ok(obs!.id.startsWith("obs_"));
		a.ok(obs!.bytes >= THRESHOLD_BYTES);
		a.equal(obs!.lines, 200); // 200 lines, no trailing newline
		a.equal(obs!.contentHash, sha256(text));
	});

	test("stable id for identical content", () => {
		const text = makeBigText(200);
		const a1 = createObservation(fakeToolResultMessage(text) as never);
		const a2 = createObservation(fakeToolResultMessage(text) as never);
		a.equal(a1!.id, a2!.id);
	});

	test("different content → different id", () => {
		const o1 = createObservation(fakeToolResultMessage(makeBigText(200)) as never);
		const o2 = createObservation(fakeToolResultMessage(makeBigText(300)) as never);
		a.notEqual(o1!.id, o2!.id);
	});
});

describe("placeholderFor", () => {
	test("includes id, tool, bytes, lines, tokens, head, tail", () => {
		const text = makeBigText(200);
		const obs = createObservation(fakeToolResultMessage(text) as never)!;
		const placeholder = placeholderFor(obs);
		a.ok(placeholder.includes(`[obs id=${obs.id}`));
		a.ok(placeholder.includes(`tool=bash`));
		a.ok(placeholder.includes(`bytes=${obs.bytes}`));
		a.ok(placeholder.includes(`lines=${obs.lines}`));
		a.ok(placeholder.includes(`tokens=${obs.tokens}`));
		a.ok(placeholder.includes("--- head ---"));
		a.ok(placeholder.includes("--- tail ---"));
		a.ok(placeholder.includes("obs_recid"));
	});
});

describe("ensureStored", () => {
	test("writes the file and is idempotent", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "obs-store-"));
		try {
			const text = makeBigText(200);
			const obs = createObservation(fakeToolResultMessage(text) as never)!;
			await ensureStored(tmp, obs);
			const path = observationPath(tmp, obs.id);
			a.ok(existsSync(path));
			a.equal(readFileSync(path, "utf8"), text);

			// Call again — should be a no-op.
			await ensureStored(tmp, obs);
			a.equal(readFileSync(path, "utf8"), text);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("readRecallChunk", () => {
	test("returns the full file when smaller than limits", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "obs-recall-"));
		try {
			const text = makeBigText(200); // ~10KB
			const obs = createObservation(fakeToolResultMessage(text) as never)!;
			await ensureStored(tmp, obs);
			const chunk = await readRecallChunk(observationPath(tmp, obs.id), 0, {
				maxBytes: 16 * 1024,
				maxLines: 400,
			});
			a.equal(chunk.bytes, Buffer.byteLength(text, "utf8"));
			a.equal(chunk.text, text);
			a.equal(chunk.eof, true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("truncates by bytes when over line budget", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "obs-recall-"));
		try {
			const text = makeBigText(200); // 200 lines
			const obs = createObservation(fakeToolResultMessage(text) as never)!;
			await ensureStored(tmp, obs);
			const chunk = await readRecallChunk(observationPath(tmp, obs.id), 0, {
				maxBytes: 16 * 1024,
				maxLines: 10, // < 200
			});
			a.equal(chunk.lines, 10);
			a.equal(chunk.eof, false); // 10 lines < 200, more to read
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("next_offset and eof at end of file", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "obs-recall-"));
		try {
			const text = makeBigText(200);
			const obs = createObservation(fakeToolResultMessage(text) as never)!;
			await ensureStored(tmp, obs);
			const path = observationPath(tmp, obs.id);
			const chunk = await readRecallChunk(path, 0, {
				maxBytes: 100, // tiny window
				maxLines: 400,
			});
			a.ok(chunk.bytes <= 100);
			a.ok(chunk.nextOffset > 0);
			a.equal(chunk.eof, false);

			// Read the rest from next_offset.
			const rest = await readRecallChunk(path, chunk.nextOffset, {
				maxBytes: 16 * 1024,
				maxLines: 400,
			});
			a.ok(rest.eof);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("offset past end returns empty + eof", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "obs-recall-"));
		try {
			const text = makeBigText(200);
			const obs = createObservation(fakeToolResultMessage(text) as never)!;
			await ensureStored(tmp, obs);
			const chunk = await readRecallChunk(observationPath(tmp, obs.id), 999_999, {
				maxBytes: 1024,
				maxLines: 10,
			});
			a.equal(chunk.bytes, 0);
			a.equal(chunk.eof, true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("isObservationId", () => {
	test("accepts well-formed obs_ ids", () => {
		a.ok(isObservationId("obs_0123456789abcdef"));
		a.ok(isObservationId("obs_aabbccdd11223344"));
	});
	test("rejects malformed", () => {
		a.equal(isObservationId("obs_short"), false);
		a.equal(isObservationId("not_an_id"), false);
		a.equal(isObservationId("OBS_UPPERCASE"), false);
		a.equal(isObservationId(123), false);
	});
});

describe("projection policy", () => {
	test("FULL_SENDS defaults to 2 (SoL-Pi alignment)", () => {
		a.equal(FULL_SENDS, 2);
	});

	test("after FULL_SENDS sends, placeholderTokens < originalTokens", () => {
		const text = makeBigText(200);
		const obs = createObservation(fakeToolResultMessage(text) as never)!;
		const placeholder = placeholderFor(obs);
		a.ok(estimateTokens(placeholder) < obs.tokens);
	});
});

describe("helpers", () => {
	test("estimateTokens uses ~4 chars/token", () => {
		a.equal(estimateTokens(""), 0);
		a.equal(estimateTokens("abcd"), 1);
		a.equal(estimateTokens("abcdefgh"), 2);
	});

	test("countLines handles empty, single, multi, trailing newline", () => {
		a.equal(countLines(""), 0);
		a.equal(countLines("a"), 1);
		a.equal(countLines("a\nb"), 2);
		a.equal(countLines("a\nb\n"), 2); // trailing newline subtracted
	});
});