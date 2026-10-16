/**
 * Evidence-Preserving Reducer tests.
 */

import * as a from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { reduce, type Evidence } from "../evidence-reducer/heuristic.js";
import { archiveBody, archivePath, readArchive } from "../evidence-reducer/archive.js";
import {
	formatReceipt,
	renderReceipt,
	REDUCER_RECEIPT_PREFIX,
	REDUCER_RECEIPT_SUFFIX,
	REDUCER_RECEIPT_SCHEMA,
} from "../evidence-reducer/receipt.js";
import { isDiagnostic, detectThenRun } from "../evidence-reducer/candidate.js";
import { sha256 } from "../shared/sha256.js";

const SAMPLE_BUILD_FAIL = `\
> myproject@1.0.0 build
> tsc --noEmit

src/foo.ts(7,5): error TS2304: cannot find name 'X'.
src/bar.ts(12,9): error TS2304: cannot find name 'Y'.
src/baz.ts(3,1): error TS2304: cannot find name 'Z'.
Found 3 errors. ELIFECYCLE  Command failed with exit code 1.
`;

const SAMPLE_TEST_PASS = `\
> vitest run

 ✓ tests/a.test.ts (3 tests) 5ms
 ✓ tests/b.test.ts (7 tests) 12ms

Test Files  2 passed (2)
     Tests  10 passed (10)
`;

const SAMPLE_TRACEBACK = `\
Traceback (most recent call last):
  File "app.py", line 12, in <module>
    do_thing()
  File "app.py", line 8, in do_thing
    raise RuntimeError("boom")
RuntimeError: boom
`;

const SAMPLE_PYTEST_FAIL = `\
============================= test session starts ==============================
collected 12 items

test_a.py ...F........                                                   [ 41%]
test_b.py F.........F                                                    [ 83%]
test_c.py ..                                                              [100%]

=================================== FAILURES ===================================
_______________________________ test_x_y ____________________________________
test_a.py:42: in test_x_y
    assert 1 == 2
E   AssertionError: 1 != 2
==================================== PASSES ====================================
=========================== short test summary info ============================
FAILED test_a.py::test_x_y - AssertionError: 1 != 2
FAILED test_b.py::test_y - AssertionError: 1 != 2
2 failed, 10 passed in 0.12s
`;

describe("heuristic reducer", () => {
	test("type-check failure: keeps target lines and summary", () => {
		const r = reduce(SAMPLE_BUILD_FAIL, { isError: true });
		a.equal(r.status, "failure");
		a.equal(r.uncertain, false);
		const kinds = r.evidence.map((e) => e.kind);
		a.ok(kinds.includes("target"), "should keep compiler error lines");
		a.ok(kinds.includes("summary"), "should keep failure summary");
		for (const e of r.evidence) {
			a.ok(SAMPLE_BUILD_FAIL.includes(e.quote), `quote missing: ${e.quote}`);
		}
	});

	test("successful test: keeps a passing summary, no failures", () => {
		const r = reduce(SAMPLE_TEST_PASS, { isError: false });
		a.equal(r.status, "success");
		a.ok(r.evidence.some((e) => e.kind === "summary"));
		for (const e of r.evidence) {
			a.ok(SAMPLE_TEST_PASS.includes(e.quote));
		}
	});

	test("traceback: keeps the traceback block", () => {
		const r = reduce(SAMPLE_TRACEBACK, { isError: true });
		a.equal(r.status, "failure");
		a.ok(r.evidence.some((e) => e.kind === "fatal"));
		for (const e of r.evidence) {
			a.ok(SAMPLE_TRACEBACK.includes(e.quote));
		}
	});

	test("pytest summary: target line + summary line kept", () => {
		const r = reduce(SAMPLE_PYTEST_FAIL, { isError: true });
		a.equal(r.status, "failure");
		const kinds = r.evidence.map((e) => e.kind);
		a.ok(kinds.includes("summary"));
		for (const e of r.evidence) {
			a.ok(SAMPLE_PYTEST_FAIL.includes(e.quote), `quote missing: ${e.quote}`);
		}
	});

	test("empty log → uncertain receipt", () => {
		const r = reduce("", { isError: false });
		a.equal(r.uncertain, true);
		a.equal(r.evidence.length, 0);
	});

	test("respects maxEvidence cap", () => {
		const huge = SAMPLE_BUILD_FAIL.repeat(1000);
		const r = reduce(huge, { isError: true, limits: { maxEvidence: 5, maxQuoteChars: 500 } });
		a.ok(r.evidence.length <= 5);
	});

	test("truncates quotes longer than maxQuoteChars", () => {
		const longLine = `error ${"x".repeat(2000)}`;
		const r = reduce(`header\n${longLine}\nfooter`, {
			isError: true,
			limits: { maxEvidence: 32, maxQuoteChars: 50 },
		});
		for (const e of r.evidence) {
			a.ok(e.quote.length <= 50, `quote too long: ${e.quote.length}`);
		}
	});
});

describe("receipt formatting", () => {
	test("contains source_sha256, source_bytes, source_lines, status, evidence", () => {
		const archive = archiveBodySync(SAMPLE_BUILD_FAIL);
		const r = reduce(SAMPLE_BUILD_FAIL, { isError: true });
		const rendered = renderReceipt(
			"npm run build",
			archive.hash,
			archive.bytes,
			archive.lines,
			r,
		);
		a.ok(rendered.text.startsWith(REDUCER_RECEIPT_PREFIX));
		a.ok(rendered.text.includes(`source_sha256=${archive.hash}`));
		a.ok(rendered.text.includes(`source_bytes=${archive.bytes}`));
		a.ok(rendered.text.includes(`status=failure`));
		a.ok(rendered.text.includes(REDUCER_RECEIPT_SUFFIX));
	});

	test("each line in the body is a byte-exact quote from source", () => {
		const r = reduce(SAMPLE_BUILD_FAIL, { isError: true });
		const text = formatReceipt(
			"npm run build",
			"abc123",
			SAMPLE_BUILD_FAIL.length,
			SAMPLE_BUILD_FAIL.split("\n").length,
			r,
		);
		const evidenceLines = text
			.split("\n")
			.filter((l) => /^(fatal|failure|warning|target|summary)\s+L\s+\d+\s+/u.test(l));
		for (const line of evidenceLines) {
			const m = line.match(/^(?:fatal|failure|warning|target|summary)\s+L\s+\d+\s+(.*)$/u);
			a.ok(m);
			a.ok(SAMPLE_BUILD_FAIL.includes(m![1]), `quote not in source: ${m![1]}`);
		}
	});
});

function archiveBodySync(text: string) {
	const root = mkdtempSync(join(tmpdir(), "sync-"));
	try {
		const hash = sha256(text);
		const path = archivePath(root, hash);
		writeFileSync(path, text, "utf8");
		return { hash, bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length, path };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("archive", () => {
	test("archiveBody persists and is idempotent", async () => {
		const root = mkdtempSync(join(tmpdir(), "archive-"));
		try {
			const a1 = await archiveBody(root, SAMPLE_BUILD_FAIL);
			a.ok(existsSync(a1.path));
			a.equal(readFileSync(a1.path, "utf8"), SAMPLE_BUILD_FAIL);
			// Second call should be a no-op.
			const a2 = await archiveBody(root, SAMPLE_BUILD_FAIL);
			a.equal(a1.hash, a2.hash);
			a.equal(a1.bytes, a2.bytes);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("readArchive round-trips", async () => {
		const root = mkdtempSync(join(tmpdir(), "archive-"));
		try {
			const a1 = await archiveBody(root, SAMPLE_TEST_PASS);
			const back = await readArchive(root, a1.hash);
			a.equal(back, SAMPLE_TEST_PASS);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("isDiagnostic", () => {
	test("recognizes build commands", () => {
		a.ok(isDiagnostic("npm run build"));
		a.ok(isDiagnostic("pnpm test"));
		a.ok(isDiagnostic("tsc --noEmit"));
		a.ok(isDiagnostic("vitest run"));
		a.ok(isDiagnostic("pytest tests/"));
	});
	test("rejects non-build commands", () => {
		a.equal(isDiagnostic("ls -la"), false);
		a.equal(isDiagnostic("cat file.txt"), false);
		a.equal(isDiagnostic("echo hello"), false);
	});
});

describe("schema constants", () => {
	test("REDUCER_RECEIPT_SCHEMA is set", () => {
		a.equal(REDUCER_RECEIPT_SCHEMA, "evidence-preserving-reducer/v1");
	});
});

void mkdirSync;
void detectThenRun;