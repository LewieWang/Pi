/**
 * Tests for the image-paste-fix extension's pure transformInputText function.
 *
 * We test the pure function rather than wiring up a fake ExtensionAPI
 * because the actual extension is one line (`pi.on("input", handler)`)
 * and the value lives in the lookup + size logic.
 */

import * as a from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { transformInputText } from "../image-paste-fix/index.js";
import type { ImageContent } from "@earendil-works/pi-ai";

// minimal 1×1 transparent PNG (67 bytes)
const ONE_PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

const MIME = "image/png";

function withTmpDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "ipf-test-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function makeFixture(dir: string, ext = "png"): { uuid: string; filename: string; fullPath: string; bytes: Buffer } {
	const uuid = randomUUID();
	const filename = `pi-clipboard-${uuid}.${ext}`;
	const fullPath = join(dir, filename);
	const bytes = ext === "png" ? ONE_PIXEL_PNG : Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // JPEG SOI+EOI for non-png
	writeFileSync(fullPath, bytes);
	return { uuid, filename, fullPath, bytes };
}

describe("image-paste-fix: transformInputText", () => {
	test("no pi-clipboard pattern → returns undefined", () => {
		const result = transformInputText("just some text without an image", undefined, { readFile: () => ONE_PIXEL_PNG, statFile: () => ONE_PIXEL_PNG.length });
		a.equal(result, undefined);
	});

	test("empty text → returns undefined", () => {
		const result = transformInputText("", undefined, { readFile: () => ONE_PIXEL_PNG, statFile: () => ONE_PIXEL_PNG.length });
		a.equal(result, undefined);
	});

	test("path that exists → returns transform with image attached", () => {
		withTmpDir((dir) => {
			const { filename, bytes } = makeFixture(dir);
			const text = `Here is a screenshot: C:\\Users\\me\\AppData\\Local\\Temp\\${filename}\nWhat do you see?`;

			let statCalls = 0;
			let readCalls = 0;
			const statFile = (p: string) => {
				statCalls++;
				if (p.endsWith(filename)) return bytes.length;
				return undefined;
			};
			const readFile = (p: string) => {
				readCalls++;
				if (p.endsWith(filename)) return bytes;
				throw new Error("not found");
			};

			const result = transformInputText(text, undefined, {
				tmpdir: dir,
				statFile,
				readFile,
			});

			a.ok(result, "expected a transform result");
			a.equal(result!.action, "transform");
			a.equal(result!.text, text, "text preserved unchanged");
			a.equal(result!.images?.length, 1);
			a.equal(result!.images?.[0].mimeType, MIME);
			a.equal(result!.images?.[0].data, bytes.toString("base64"));
			a.equal(result!.images?.[0].type, "image");
			a.equal(statCalls, 1);
			a.equal(readCalls, 1);
		});
	});

	test("file missing in tmpdir → returns undefined silently", () => {
		withTmpDir((dir) => {
			const ghost = `pi-clipboard-${randomUUID()}.png`;
			const text = `where did the image go? ${ghost}`;
			const result = transformInputText(text, undefined, {
				tmpdir: dir,
				statFile: () => undefined,
				readFile: () => {
					throw new Error("should not be called");
				},
			});
			a.equal(result, undefined);
		});
	});

	test("multiple distinct pastes in one message → all attached", () => {
		withTmpDir((dir) => {
			const a1 = makeFixture(dir, "png");
			const a2 = makeFixture(dir, "jpg");
			const a3 = makeFixture(dir, "gif");
			const text = `first ${a1.filename} then ${a2.filename} and ${a3.filename}`;

			const map = new Map([
				[a1.filename, a1.bytes],
				[a2.filename, a2.bytes],
				[a3.filename, a3.bytes],
			]);

			const result = transformInputText(text, undefined, {
				tmpdir: dir,
				statFile: (p) => map.get(p.split(/[\\/]/).pop()!)?.length,
				readFile: (p) => {
					const b = map.get(p.split(/[\\/]/).pop()!);
					if (!b) throw new Error("not found");
					return b;
				},
			});

			a.ok(result);
			a.equal(result!.images?.length, 3);
			const mimes = result!.images!.map((i) => i.mimeType).sort();
			a.deepEqual(mimes, ["image/gif", "image/jpeg", "image/png"]);
		});
	});

	test("duplicate UUID in text → attached only once", () => {
		withTmpDir((dir) => {
			const { filename, bytes } = makeFixture(dir);
			const text = `${filename} and again ${filename} and again ${filename}`;

			let readCalls = 0;
			const statFile = (p: string) => (p.endsWith(filename) ? bytes.length : undefined);
			const readFile = (p: string) => {
				readCalls++;
				if (p.endsWith(filename)) return bytes;
				throw new Error("not found");
			};

			const result = transformInputText(text, undefined, {
				tmpdir: dir,
				statFile,
				readFile,
			});

			a.ok(result);
			a.equal(result!.images?.length, 1, "deduped to one image");
			a.equal(readCalls, 1, "file read once");
		});
	});

	test("oversized image → skipped, no images attached", () => {
		withTmpDir((dir) => {
			const { filename, bytes } = makeFixture(dir);
			const text = `big image ${filename}`;
			const result = transformInputText(text, undefined, {
				tmpdir: dir,
				maxBytes: bytes.length - 1, // one byte less than the file → over cap
				statFile: (p) => (p.endsWith(filename) ? bytes.length : undefined),
				readFile: (p) => (p.endsWith(filename) ? bytes : (() => { throw new Error("not found"); })()),
			});
			a.equal(result, undefined, "oversized file produces no attach");
		});
	});

	test("existing images preserved + new appended", () => {
		withTmpDir((dir) => {
			const { filename, bytes } = makeFixture(dir);
			const existing: ImageContent[] = [
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			];
			const text = `pasted ${filename}`;

			const result = transformInputText(text, existing, {
				tmpdir: dir,
				statFile: (p) => (p.endsWith(filename) ? bytes.length : undefined),
				readFile: (p) => (p.endsWith(filename) ? bytes : (() => { throw new Error("not found"); })()),
			});

			a.ok(result);
			a.equal(result!.images?.length, 2);
			a.equal(result!.images?.[0], existing[0], "existing image preserved at index 0");
			a.equal(result!.images?.[1].data, bytes.toString("base64"), "new image appended");
		});
	});

	test("non-image path with similar name → no match", () => {
		withTmpDir((dir) => {
			const notAClipboard = "pi-clipboard-doc.txt";
			const text = `wrong extension ${notAClipboard}`;
			const result = transformInputText(text, undefined, {
				tmpdir: dir,
				statFile: () => 100,
				readFile: () => Buffer.from("nope"),
			});
			a.equal(result, undefined);
		});
	});

	test("path-like text without UUID → no match", () => {
		const text = `regular file: /tmp/pi-clipboard-screenshot.png`;
		const result = transformInputText(text, undefined, {
			tmpdir: "/tmp",
			statFile: () => 100,
			readFile: () => Buffer.from("nope"),
		});
		a.equal(result, undefined, "filename without UUID is not matched");
	});

	test("real on-disk lookup against os.tmpdir() (sanity)", () => {
		// This is an end-to-end-ish test: write a real file in os.tmpdir() and
		// rely on the default statFile / readFile (no injection). Catches
		// regressions where injected mocks diverge from real fs behavior.
		withTmpDir((dir) => {
			const { filename, bytes } = makeFixture(dir);
			const text = `${filename}`;
			const result = transformInputText(text, undefined, { tmpdir: dir });
			a.ok(result);
			a.equal(result!.images?.length, 1);
			a.equal(result!.images?.[0].data, bytes.toString("base64"));
		});
	});
});