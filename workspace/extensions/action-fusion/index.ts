/**
 * Action Fusion — entrypoint.
 *
 * Replaces Pi's built-in `edit` and `write` with versions that accept an
 * optional `then_run` parameter. Saves 1 model round-trip per edit+verify.
 *
 * Configuration via `~/.pi/agent/sol-pi.json` (or `.pi/sol-pi.json` in a
 * trusted project):
 *
 *   {
 *     "version": 1,
 *     "actionFusion": true,
 *     "cacheWriteReadRatio": 1.0
 *   }
 *
 * Reference: SoL-Pi src/sol-pi/extensions/action-fusion/index.ts
 */

import type { ExtensionAPI, ExtensionContext, ExtensionFactory, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { readConfig } from "../shared/config.js";
import { createJournal } from "../shared/journal.js";
import { createActionFusionTools } from "./definition.js";

export interface ActionFusionOptions {
	/** Force enable even if config says disabled. Default: follow config. */
	readonly forceEnable?: boolean;
}

// Type aliases we use internally; ToolRenderContext is not part of the public
// type surface but its shape is exported implicitly via ToolDefinition.
type AnyArgs = Record<string, unknown>;
type AnyRenderContext = { args?: AnyArgs };

function badge(theme: Theme | undefined, _args: AnyArgs): Component {
	const container = new Container();
	container.addChild(
		new Text("⚡ Action Fusion · fused command", 0, 0),
	);
	return container;
}

function annotate(theme: Theme | undefined, thenRun: unknown, base: Component): Component {
	if (!thenRun) return base;
	const container = new Container();
	container.addChild(badge(theme, {}));
	container.addChild(base);
	return container;
}

type RenderCallFn = (
	args: AnyArgs,
	theme: Theme,
	context: AnyRenderContext,
) => Component;
type RenderResultFn = (
	result: unknown,
	options: unknown,
	theme: Theme,
	context: AnyRenderContext,
) => Component;

function wrapRenderCall(original: RenderCallFn | undefined): RenderCallFn {
	return (args, theme, context) => {
		const base = original
			? original(args, theme, context)
			: new Text(String(args.path ?? ""), 0, 0);
		return annotate(theme, args.then_run, base);
	};
}

function wrapRenderResult(original: RenderResultFn | undefined): RenderResultFn {
	return (result, options, theme, context) => {
		const base = original
			? original(result, options, theme, context)
			: new Text("", 0, 0);
		return annotate(theme, context.args?.then_run, base);
	};
}

/**
 * Plugin entry — registers the action-fusion replacements if the config allows.
 */
export function createActionFusionExtension(options: ActionFusionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const journal = createJournal();
		let registered = false;

		const tryRegister = (projectTrusted: boolean): void => {
			if (registered) return;
			const config = readConfig({ projectTrusted });
			if (!options.forceEnable && !config.actionFusion) return;

			const tools = createActionFusionTools(process.cwd(), journal);

			// Augment renderers with a "fused" badge when then_run is in play.
			const wrappedEdit = {
				...tools.edit,
				renderCall: wrapRenderCall(tools.edit.renderCall as RenderCallFn | undefined),
				renderResult: wrapRenderResult(tools.edit.renderResult as RenderResultFn | undefined),
			};
			const wrappedWrite = {
				...tools.write,
				renderCall: wrapRenderCall(tools.write.renderCall as RenderCallFn | undefined),
				renderResult: wrapRenderResult(tools.write.renderResult as RenderResultFn | undefined),
			};

			pi.registerTool(wrappedEdit as never);
			pi.registerTool(wrappedWrite as never);
			registered = true;

			void journal.record({
				kind: "tools_registered",
				names: ["edit", "write"],
			});
			void journal.record({
				kind: "config_loaded",
				config: { ...config } as Record<string, unknown>,
			});
		};

		pi.on("session_start", (_event, ctx: ExtensionContext) => {
			tryRegister(ctx.isProjectTrusted());
		});
	};
}

export default function actionFusionExtension(pi: ExtensionAPI): void {
	createActionFusionExtension()(pi);
}