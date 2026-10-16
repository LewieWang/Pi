/**
 * Observation Pack — entrypoint.
 *
 * Replaces large tool results with stable placeholders after the first few
 * provider requests, and provides `obs_recid` for the model to recall exact
 * paged excerpts on demand.
 *
 * Configuration via `~/.pi/agent/sol-pi.json`:
 *
 *   {
 *     "version": 1,
 *     "observationPack": true,
 *     "cacheWriteReadRatio": 1.0
 *   }
 *
 * Reference: SoL-Pi src/sol-pi/extensions/observation-pack/index.ts
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { readConfig } from "../shared/config.js";
import { createJournal } from "../shared/journal.js";
import { createProjectionHandler } from "./projection.js";
import { registerObsRecall } from "./recall.js";

export interface ObservationPackOptions {
	readonly forceEnable?: boolean;
}

export function createObservationPackExtension(
	options: ObservationPackOptions = {},
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const journal = createJournal();
		let registered = false;

		const tryRegister = (projectTrusted: boolean): void => {
			if (registered) return;
			const config = readConfig({ projectTrusted });
			if (!options.forceEnable && !config.observationPack) return;

			const onContext = createProjectionHandler(pi, journal);
			pi.on("context", onContext as never);
			registerObsRecall(pi, journal);
			registered = true;

			void journal.record({
				kind: "config_loaded",
				config: { ...config } as Record<string, unknown>,
			});
			void journal.record({
				kind: "tools_registered",
				names: ["obs_recid"],
			});
		};

		pi.on("session_start", (_event, ctx: ExtensionContext) => {
			tryRegister(ctx.isProjectTrusted());
		});
	};
}

export default function observationPackExtension(pi: ExtensionAPI): void {
	createObservationPackExtension()(pi);
}