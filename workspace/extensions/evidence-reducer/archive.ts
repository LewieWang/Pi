/**
 * Archive - one-shot write of a long tool result to disk so the receipt can
 * be cross-checked later. Mirrors SoL-Pi's archive.ts but with a simpler
 * shape (we just write the raw body under a sha-based path).
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../shared/sha256.js";

export interface ArchiveObject {
	readonly hash: string;
	readonly bytes: number;
	readonly lines: number;
	readonly path: string;
}

export function archivePath(root: string, hash: string): string {
	return join(root, `${hash}.log`);
}

export async function archiveBody(
	root: string,
	body: string,
): Promise<ArchiveObject> {
	const hash = sha256(body);
	const path = archivePath(root, hash);
	await mkdir(root, { recursive: true });
	const bytes = Buffer.byteLength(body, "utf8");
	const lines = countLines(body);
	let existing: import("node:fs").Stats | undefined;
	try {
		existing = await stat(path);
	} catch {
		existing = undefined;
	}
	if (!existing || existing.size !== bytes) {
		await writeFile(path, body, "utf8");
	}
	return { hash, bytes, lines, path };
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let count = 1;
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) count += 1;
	}
	if (text.endsWith("\n")) count -= 1;
	return count;
}

export async function readArchive(root: string, hash: string): Promise<string> {
	return readFile(archivePath(root, hash), "utf8");
}