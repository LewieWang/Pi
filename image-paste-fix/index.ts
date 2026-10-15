/**
 * Image Paste Fix — make Ctrl+V image paste actually attach the image bytes.
 *
 * Background: pi's `handleClipboardPaste` writes the clipboard image to
 * `os.tmpdir()/pi-clipboard-{uuid}.{ext}` and inserts the file path into
 * the editor. But interactive `session.prompt(text)` only forwards text,
 * so the model never sees the image — it just sees the path string. CLI
 * mode (`--image-path`) works because it routes through `initialImages`.
 *
 * This extension closes the gap: in the `input` event (the last point
 * before the message hits the provider), scan for the `pi-clipboard-…`
 * filename pi writes, read the file from `os.tmpdir()`, and attach the
 * bytes via the `transform` action so the image reaches the model.
 *
 * Design notes:
 *   - We don't intercept the paste path itself. Pi already writes the
 *     file; we only do the look-up + attach.
 *   - The text is preserved unchanged so users can still see/copy the
 *     path; vision-guard's "image omitted" warning will fire correctly
 *     when the model lacks vision support.
 *   - Files that have been cleaned up (tmpdir rotation, OS reboot,
 *     user pause-then-submit) are silently skipped — fail-open.
 *   - Hard cap at 10 MiB decoded to avoid blowing context.
 *   - Strict path/UUID pattern keeps false positives near zero.
 *
 * References:
 *   - pi 1.2.0 dist/modes/interactive/interactive-mode.js:2515-2522
 *   - pi core/extensions/types.d.ts InputEvent / InputEventResult
 */

import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory, ExtensionHandler, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

export interface ImagePasteFixOptions {
	/** Hard cap per image (decoded bytes). Larger images are skipped with a warning. Default 10 MiB. */
	readonly maxBytes?: number;
	/** Suppress stderr diagnostics. Default false. */
	readonly silent?: boolean;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Filename pattern: pi-clipboard-{uuid-v4-or-v1-or-v5}.{ext}.
 * UUID regex is permissive (any UUID, not just v4) so the extension
 * survives if pi ever switches its UUID variant.
 */
const FILENAME_RE = /pi-clipboard-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpe?g|gif|webp)\b/gi;

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

function writeDiagnostic(message: string, silent: boolean): void {
	if (silent) return;
	process.stderr.write(`[image-paste-fix] ${message}\n`);
}

/**
 * Pure function: given the raw input text, return either undefined
 * (no match → continue as-is) or an InputEventResult that attaches
 * the bytes. Exported for unit testing.
 */
export function transformInputText(
	text: string,
	existingImages: readonly ImageContent[] | undefined,
	options: { maxBytes?: number; tmpdir?: string; readFile?: (p: string) => Buffer; statFile?: (p: string) => number | undefined } = {},
): { action: "transform"; text: string; images: ImageContent[] } | undefined {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const tmp = options.tmpdir ?? tmpdir();
	const readFile = options.readFile ?? ((p: string) => readFileSync(p));
	const statFile = options.statFile ?? ((p: string) => {
		try {
			return statSync(p).size;
		} catch {
			return undefined;
		}
	});

	const newImages: ImageContent[] = existingImages ? [...existingImages] : [];
	const seenUuids = new Set<string>();
	let attached = 0;
	let missed = 0;
	let oversized = 0;
	const silent = true; // diagnostics from pure function suppressed; caller may log

	for (const m of text.matchAll(FILENAME_RE)) {
		const uuid = m[1];
		const ext = m[2].toLowerCase();
		if (seenUuids.has(uuid)) continue;
		seenUuids.add(uuid);

		const filename = m[0];
		const fullPath = join(tmp, filename);
		const size = statFile(fullPath);
		if (size === undefined) {
			missed++;
			continue;
		}
		if (size > maxBytes) {
			writeDiagnostic(`skip ${filename} (${size} bytes > ${maxBytes})`, silent);
			oversized++;
			continue;
		}
		try {
			const bytes = readFile(fullPath);
			newImages.push({
				type: "image",
				data: bytes.toString("base64"),
				mimeType: MIME_BY_EXT[ext] ?? "image/png",
			});
			attached++;
		} catch {
			missed++;
		}
	}

	if (attached === 0) return undefined;
	void { missed, oversized };
	return {
		action: "transform",
		text,
		images: newImages,
	};
}

export function createImagePasteFixExtension(options: ImagePasteFixOptions = {}): ExtensionFactory {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const silent = options.silent ?? false;

	return (pi: ExtensionAPI) => {
		const handler: ExtensionHandler<InputEvent, InputEventResult> = (event) => {
			if (!event.text) return;
			const result = transformInputText(event.text, event.images, { maxBytes });
			if (!result) return;
			// emit a one-line diagnostic so the operator can see it worked
			const added = (result.images?.length ?? 0) - (event.images?.length ?? 0);
			if (added > 0) {
				writeDiagnostic(`attached ${added} pasted image(s)`, silent);
			}
			return result;
		};
		pi.on("input", handler);
	};
}

export default function imagePasteFixExtension(pi: ExtensionAPI): void {
	createImagePasteFixExtension()(pi);
}

// Re-export uuid generator so tests can fabricate matching filenames.
export const _internal = { FILENAME_RE, randomUUID };