/**
 * Hash guard for Action Fusion.
 *
 * Reference: SoL-Pi src/sol-pi/extensions/action-fusion/then-run.ts::assertUnchangedBeforeCommand
 *
 * Two hash reads with a `setImmediate` yield between them. If the hash differs,
 * something else wrote to the file between our mutation and the dispatch — most
 * often another tool, a watcher, or an external process. We skip then_run in
 * that case rather than run it against the wrong content.
 *
 * Throws HashGuardError so callers can distinguish guard failures from other
 * errors.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const THEN_RUN_SKIPPED = "[then_run:skipped]";

export class HashGuardError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HashGuardError";
	}
}

async function fileSha256(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Hash twice with a yield between. Throw `HashGuardError` if the hashes
 * differ. The yield is a single `setImmediate` tick — enough to surface any
 * interleave that is queued behind us in the event loop.
 */
export async function assertUnchangedBeforeCommand(
	path: string,
	yieldForInterference: () => Promise<void> = defaultYield,
): Promise<void> {
	let firstHash: string;
	try {
		firstHash = await fileSha256(path);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new HashGuardError(`${THEN_RUN_SKIPPED} cannot read ${path}: ${reason}`);
	}

	await yieldForInterference();

	let secondHash: string;
	try {
		secondHash = await fileSha256(path);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new HashGuardError(`${THEN_RUN_SKIPPED} cannot re-read ${path}: ${reason}`);
	}

	if (firstHash !== secondHash) {
		throw new HashGuardError(
			`${THEN_RUN_SKIPPED} ${path} content changed after mutation; command not run`,
		);
	}
}