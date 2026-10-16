/**
 * Resolve the directory under which extensions can write per-session archives.
 *
 * Mirrors SoL-Pi's runtimeRoot() pattern. When a Pi session is active we use
 * `<session-dir>/<extension>/<session-id>/` so the data lives next to the
 * session log and is naturally cleaned up with it.
 *
 * When `--no-session` (or in-memory) sessions are active, Pi does not provide
 * a session directory. We fall back to a private tmpdir keyed by session id
 * so two no-session runs don't clobber each other.
 *
 * Reference: SoL-Pi src/sol-pi/runtime-paths.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const temporaryRoots = new Map<string, string>();

const SAFE_SESSION_ID = /^[a-z0-9][a-z0-9._-]*$/iu;

export function runtimeRoot(ctx: ExtensionContext, subdir: string): string {
	const sessionDir = ctx.sessionManager.getSessionDir();
	const sessionId = ctx.sessionManager.getSessionId();
	if (!SAFE_SESSION_ID.test(sessionId)) {
		throw new Error(`harness-extensions: unsafe Pi session id: ${sessionId}`);
	}
	if (sessionDir) return join(sessionDir, subdir, sessionId);

	// --no-session or in-memory: fall back to a private tmpdir keyed by session id.
	let root = temporaryRoots.get(sessionId);
	if (!root) {
		root = mkdtempSync(join(tmpdir(), `harness-${sessionId}-`));
		temporaryRoots.set(sessionId, root);
	}
	return join(root, subdir);
}