/**
 * Vision Guard — fail loudly when images get silently downgraded.
 *
 * Background: pi's downgradeUnsupportedImages() replaces image blocks with
 * "(image omitted: model does not support images)" whenever the active
 * model's `input` array lacks "image". This is correct behavior for
 * incompatible providers, but it silently hides the two most common
 * operator mistakes:
 *
 *   1. The model actually supports vision, but `~/.pi/agent/models.json`
 *      declares `"input": ["text"]`. (We hit this ourselves with
 *      MiniMax-M3 and ark-code-latest — both read images fine once the
 *      config said so.)
 *   2. The user attaches an image without realizing the current model
 *      will never see it.
 *
 * What this extension does:
 *   - At session start, if the configured model lacks "image" in its
 *     input list, print a one-line warning to stderr.
 *   - When a user message carries images and the model can't see them,
 *     print a specific warning naming the model and the fix.
 *
 * This is fail-loud, not fail-open: the point is to make the silent
 * downgrade visible so the operator can fix the config instead of
 * wondering why "image omitted" appears.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface VisionGuardOptions {
	readonly forceEnable?: boolean;
}

interface ImageEvent {
	readonly count: number;
	readonly role: "user" | "toolResult";
}

function modelSupportsImages(context: ExtensionContext): boolean | null {
	const model = context.model;
	if (!model) return null;
	const input = (model as { input?: unknown }).input;
	if (!Array.isArray(input)) return null;
	return input.includes("image");
}

function modelName(context: ExtensionContext): string {
	const model = context.model as { id?: string; provider?: string } | undefined;
	if (!model) return "unknown";
	return `${model.provider ?? "?"}/${model.id ?? "?"}`;
}

function countImages(message: unknown): number {
	const m = message as { content?: unknown };
	if (!Array.isArray(m?.content)) return 0;
	let count = 0;
	for (const block of m.content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
			count += 1;
		}
	}
	return count;
}

export function createVisionGuardExtension(options: VisionGuardOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const warnedSessions = new Set<string>();

		pi.on("session_start", (_event, context) => {
			const supports = modelSupportsImages(context);
			if (supports === false) {
				process.stderr.write(
					`[vision-guard] model ${modelName(context)} is configured without "image" input — ` +
						`attached images will be replaced with "(image omitted)" placeholders. ` +
						`If the model actually supports vision, add "image" to its input array in ~/.pi/agent/models.json.\n`,
				);
			}
		});

		pi.on("input", (event, context) => {
			const imageCount = countImages(event);
			if (imageCount === 0) return;
			const supports = modelSupportsImages(context);
			if (supports !== false) return;
			const sessionId = context.sessionManager.getSessionId();
			if (warnedSessions.has(`${sessionId}:warned`)) return;
			warnedSessions.add(`${sessionId}:warned`);
			process.stderr.write(
				`[vision-guard] WARNING: this message carries ${imageCount} image(s), but model ` +
					`${modelName(context)} is declared as text-only in ~/.pi/agent/models.json. ` +
					`pi will replace the images with placeholders and the model will never see them. ` +
					`Fix: set "input": ["text", "image"] for this model (verified working for ` +
					`minimax/MiniMax-M3 and volcengine-ark/ark-code-latest).\n`,
			);
		});

		void options;
	};
}

export default function visionGuardExtension(pi: ExtensionAPI): void {
	createVisionGuardExtension()(pi);
}