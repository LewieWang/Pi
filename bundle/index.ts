/**
 * Sol-Pi Bundle — single entry point that wires up all four mechanisms
 * (Action Fusion, Observation Pack, Evidence-Preserving Reducer, Online
 * Context Compact) plus the token and savings trackers, gated by the
 * user's `~/.pi/agent/sol-pi.json` (project file wins).
 *
 * Reference: SoL-Pi src/sol-pi/index.ts
 *
 * Why a bundle? So you can `pi install <path>` and get the whole suite
 * without editing package.json. Existing standalone entries still work
 * — bundle is opt-in.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readConfig } from "../shared/config.js";
import { createActionFusionExtension } from "../action-fusion/index.js";
import { createObservationPackExtension } from "../observation-pack/index.js";
import { createEvidenceReducerExtension } from "../evidence-reducer/index.js";
import { createOnlineContextCompactExtension } from "../online-compact/index.js";
import { createTokenTrackerExtension } from "../token-tracker/index.js";
import { createSavingsTrackerExtension } from "../savings-tracker/index.js";

export interface BundleOptions {
	readonly forceAll?: boolean;
}

export function createSolPiBundle(options: BundleOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		// Token + savings tracker are always on; they read their own
		// config and degrade gracefully.
		createTokenTrackerExtension()(pi);
		createSavingsTrackerExtension()(pi);

		pi.on("session_start", (_event, ctx: ExtensionContext) => {
			let config;
			try {
				config = readConfig({ projectTrusted: ctx.isProjectTrusted() });
			} catch {
				return;
			}
			if (options.forceAll || config.actionFusion) createActionFusionExtension()(pi);
			if (options.forceAll || config.observationPack) createObservationPackExtension()(pi);
			if (options.forceAll || config.evidencePreservingReducer) createEvidenceReducerExtension()(pi);
			if (options.forceAll || config.onlineContextCompact) createOnlineContextCompactExtension()(pi);
		});
	};
}

export default function solPiBundleExtension(pi: ExtensionAPI): void {
	createSolPiBundle()(pi);
}