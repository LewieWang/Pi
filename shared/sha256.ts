/**
 * Stable sha256 hex digest.
 *
 * Re-exported as a single function so we don't import crypto everywhere.
 */
import { createHash } from "node:crypto";

export function sha256(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex");
}