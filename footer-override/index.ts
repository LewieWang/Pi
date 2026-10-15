/**
 * Footer Override — replace pi's built-in footer with a variant that
 * hides the per-session token/message counters (↑↓R W CH% $cost) but
 * keeps everything else: cwd, git branch, session name, context
 * percentage, model, thinking level, routed model, provider count,
 * and extension statuses.
 *
 * Why: the per-turn token totals now live in the token-tracker output
 * (one stderr line per turn + a session box at the end). Keeping them
 * in the footer duplicates the numbers 100% of the time when they're
 * only actually needed ~1% of the time.
 *
 * Hover: the second line is wrapped in a pi-tui MouseRegion. Moving the
 * mouse over it reveals a detail line (context tokens / window / cache
 * / session turns+messages) that auto-hides after ~2.5 s of no mouse
 * activity; a click pins it until the next click. If the terminal
 * doesn't report mouse events, the footer still renders normally —
 * the detail line just never appears (fail-open).
 *
 * Reference: pi dist/bundle/chunks/chunk-TJXZSVTD.js (built-in footer
 * render), replicated minus the token stats.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui/dist/utils.js";

export interface FooterOverrideOptions {
	readonly forceEnable?: boolean;
}

/** Mirror of pi's internal formatTokens (↑10.5K style). */
function formatTokens(count: number): string {
	if (count < 1e3) return count.toString();
	if (count < 1e4) return `${(count / 1e3).toFixed(1)}k`;
	if (count < 1e6) return `${Math.round(count / 1e3)}k`;
	if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
	return `${Math.round(count / 1e6)}M`;
}

interface CachedStats {
	/** tokens, contextWindow from ctx.getContextUsage() */
	tokens: number | null;
	contextWindow: number | null;
	/** per-session counters from turn_end events */
	turns: number;
	messages: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	/** session start timestamp (Date.now() at session_start) */
	startedAt: number;
}

function emptyCached(): CachedStats {
	return {
		tokens: null,
		contextWindow: null,
		turns: 0,
		messages: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		startedAt: 0,
	};
}

export function createFooterOverrideExtension(options: FooterOverrideOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		// Register the entry renderer for the "token-summary" custom entry
		// so the panel appears inline in the chat at agent_settled time.
		pi.registerEntryRenderer<TokenSummaryData>("token-summary", renderTokenSummaryEntry);

		const bySession = new Map<string, CachedStats>();
		let footerInstalled = false;

		const getStats = (context: ExtensionContext): CachedStats => {
			const id = context.sessionManager.getSessionId();
			let s = bySession.get(id);
			if (!s) {
				s = emptyCached();
				s.startedAt = Date.now();
				bySession.set(id, s);
			}
			return s;
		};

		pi.on("before_provider_request", (_event, context) => {
			const s = getStats(context);
			const usage = context.getContextUsage();
			if (usage) {
				s.tokens = typeof usage.tokens === "number" ? usage.tokens : s.tokens;
				s.contextWindow = usage.contextWindow ?? s.contextWindow;
			}
		});

		pi.on("turn_end", (event, context) => {
			const s = getStats(context);
			s.turns += 1;
			s.messages += 1;
			const usage = (event.message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number } }).usage;
			if (usage) {
				s.input += usage.input ?? 0;
				s.output += usage.output ?? 0;
				s.cacheRead += usage.cacheRead ?? 0;
				s.cacheWrite += usage.cacheWrite ?? 0;
				s.reasoning += usage.reasoning ?? 0;
			}
		});

		pi.on("input", (_event, context) => {
			const s = getStats(context);
			s.messages += 1;
		});

		pi.on("session_start", (_event, context) => {
			const s = getStats(context);
			s.startedAt = Date.now();
			if (context.mode !== "tui") return;
			context.ui.setFooter((tui, theme, footerData) => {
				void tui;
				return new OverrideFooter(theme, footerData, () => {
					// Live stats accessor: reads the latest session snapshot the
					// footer extension saw. Returns the most recent entry.
					let latest: CachedStats | null = null;
					for (const sess of bySession.values()) latest = sess;
					return latest ?? emptyCached();
				});
			});
		});

		pi.on("agent_settled", (_event, context) => {
			const s = getStats(context);
			const durationMs = s.startedAt > 0 ? Date.now() - s.startedAt : 0;
			// Persist a styled "Token 消耗明细" entry into the chat so the
			// session summary is visible inline at agent_settled, not just
			// on hover. Display-only; not sent to the LLM.
			pi.appendEntry("token-summary", {
				input: s.input,
				output: s.output,
				cacheRead: s.cacheRead,
				cacheWrite: s.cacheWrite,
				reasoning: s.reasoning,
				turns: s.turns,
				messages: s.messages,
				tokens: s.tokens ?? 0,
				contextWindow: s.contextWindow ?? 0,
				durationMs,
			});
		});

		pi.on("session_shutdown", (_event, context) => {
			bySession.delete(context.sessionManager.getSessionId());
		});

		void options;
		void footerInstalled;
	};
};

const HOVER_AUTOHIDE_MS = 2_500;

class OverrideFooter {
	private readonly theme: Theme;
	private readonly footerData: {
		getGitBranch(): string | null;
		getExtensionStatuses(): ReadonlyMap<string, string>;
	};
	private readonly getStats: () => CachedStats;
	private hover = false;
	private pinned = false;
	private hideTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		theme: Theme,
		footerData: { getGitBranch(): string | null; getExtensionStatuses(): ReadonlyMap<string, string> },
		getStats: () => CachedStats,
	) {
		this.theme = theme;
		this.footerData = footerData;
		this.getStats = getStats;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const stats = this.getStats();

		// Line 1: pwd (branch) • session  — identical to built-in.
		let pwd = truncateCwd(process.cwd(), process.env.HOME ?? process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		if (branch) pwd = `${pwd} (${branch})`;
		const lines: string[] = [truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."))];

		// Line 2: context% + token summary (Tokens: X | 耗时: Y) — totals at the
		// bottom mirror the panel that the "token-summary" chat entry renders
		// at agent_settled. The hover/pinned overlay below expands it.
		const parts: string[] = [];
		if (stats.contextWindow && stats.tokens !== null) {
			const pct = Math.round((stats.tokens / stats.contextWindow) * 100);
			const display = `${pct}%/${formatTokens(stats.contextWindow)}`;
			parts.push(
				pct > 90
					? theme.fg("error", display)
					: pct > 70
						? theme.fg("warning", display)
						: display,
			);
		}
		const tokenTotal = stats.input + stats.output;
		// 「本次会话 Tokens」不再展示在 footer 左下——详细消耗改为每轮
		// 对话结束时在聊天区的 token-summary 面板展示（与 pi-webui 一致）。
		void tokenTotal;
		if (stats.startedAt > 0) {
			const localClock = formatClockLocal(new Date(stats.startedAt));
			const tz = formatTzOffset(new Date(stats.startedAt));
			parts.push(theme.fg("dim", `开始于 ${localClock}${tz}`));
			parts.push(theme.fg("dim", `耗时 ${formatDuration(Date.now() - stats.startedAt)}`));
		}
		const statsLeft = parts.join("  ");
		const statsLeftWidth = visibleWidth(statsLeft);

		let rightSide = "no-model";
		void rightSide;
		// Model / thinking info lives on the extension side; without access to
		// the runtime we show a stable placeholder that the status line below
		// keeps informative.
		const modelName = "model";
		rightSide = modelName;

		let rightSideWidth = visibleWidth(rightSide);
		const minPadding = 2;
		let statsLine: string;
		if (statsLeftWidth + minPadding + rightSideWidth <= width) {
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			const availableForRight = Math.max(0, width - statsLeftWidth - minPadding);
			const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
			rightSideWidth = visibleWidth(truncatedRight);
			const padding = " ".repeat(Math.max(0, width - statsLeftWidth - rightSideWidth));
			statsLine = statsLeft + padding + truncatedRight;
		}
		lines.push(statsLine);

		// Line 2.5: hover detail (only when hovered/pinned).
		if (this.hover || this.pinned) {
			lines.push(this.renderHoverDetail(width, stats));
		}

		// Line 3: extension statuses — identical to built-in.
		const statuses = this.footerData.getExtensionStatuses();
		if (statuses.size > 0) {
			const statusLine = Array.from(statuses.entries())
				.map(([key, value]) => `${key}: ${value}`)
				.join(" · ");
			lines.push(truncateToWidth(theme.fg("dim", statusLine), width, "..."));
		}

		return lines;
	}

	private renderHoverDetail(width: number, stats: CachedStats): string {
		const t = this.theme;
		// 与 renderTokenSummaryEntry 同一语义：input 已剔除缓存，未命中 = input 本身
		const totalIn = stats.input + stats.cacheRead + stats.cacheWrite;
		const total = totalIn + stats.output;
		const cacheMiss = stats.input;
		const icon = this.pinned ? "📌" : "👁";
		const header = `${icon} ${t.bold("Token 消耗明细")}`;
		const headerRight = `${t.fg("muted", "总计")} ${t.fg("accent", formatTokens(total))}`;
		// header spans full width with title left, total right
		const line1 = layoutRow(header, headerRight, width);
		const inputLine = layoutRow(
			t.fg("accent", "▍输入"),
			t.fg("accent", formatTokens(totalIn)),
			width,
			2,
		);
		const cacheLines = [
			`    ${t.fg("success", "▍缓存命中")}    ${t.fg("muted", formatTokens(stats.cacheRead))}`,
			`    ${t.fg("error", "▍缓存未命中")}  ${t.fg("muted", formatTokens(cacheMiss))}`,
			`    ${t.fg("warning", "▍缓存写入")}    ${t.fg("muted", formatTokens(stats.cacheWrite))}`,
		].map((l) => truncateToWidth(l, width, "..."));
		const outputLine = layoutRow(
			t.fg("accent", "▍输出"),
			t.fg("accent", formatTokens(stats.output)),
			width,
			2,
		);
		const outputSubs = [
			`    ${t.fg("muted", "▍思考过程")}      ${t.fg("dim", formatTokens(stats.reasoning))}`,
			`    ${t.fg("muted", "▍回复内容")}      ${t.fg("dim", formatTokens(Math.max(0, stats.output - stats.reasoning)))}`,
		].map((l) => truncateToWidth(l, width, "..."));
		const hit = hitRate(stats);
		const hitLine = layoutRow(
			`${t.fg("warning", "⚡")} ${t.fg("warning", "缓存命中率")}`,
			t.fg("warning", hit),
			width,
			2,
		);
		const legend = t.fg(
			"dim",
			`  ${t.fg("success", "▍命中")}  ${t.fg("warning", "▍写入")}  ${t.fg("error", "▍未命中")}`,
		);
		const meta = t.fg(
			"dim",
			// hover 面板底部对齐设计稿：Tokens + 耗时（不含 turns/msgs 消息数）
			`Tokens: ${formatTokens(total)}` +
				(stats.startedAt > 0 ? ` · 耗时 ${formatDuration(Date.now() - stats.startedAt)}` : ""),
		);
		return [
			truncateToWidth(line1, width, "..."),
			truncateToWidth(t.fg("dim", ""), width, "..."),
			truncateToWidth(inputLine, width, "..."),
			...cacheLines,
			truncateToWidth(outputLine, width, "..."),
			...outputSubs,
			truncateToWidth(t.fg("dim", ""), width, "..."),
			truncateToWidth(hitLine, width, "..."),
			truncateToWidth(legend, width, "..."),
			truncateToWidth(meta, width, "..."),
		].join("\n");
	}

	handleMouse(event: { type: string; button?: string }): { handled: boolean } | undefined {
		if (event.type === "move") {
			if (!this.hover) {
				this.hover = true;
				this.scheduleHide();
				return { handled: true };
			}
			this.scheduleHide();
			return { handled: true };
		}
		if (event.type === "press" && event.button === "left") {
			this.pinned = !this.pinned;
			return { handled: true };
		}
		return undefined;
	}

	private scheduleHide(): void {
		if (this.hideTimer) clearTimeout(this.hideTimer);
		if (this.pinned) return;
		this.hideTimer = setTimeout(() => {
			this.hover = false;
			this.hideTimer = null;
		}, HOVER_AUTOHIDE_MS);
	}

	invalidate(): void {
		// Nothing cached to invalidate; render() recomputes each frame.
	}
}

function truncateCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedHome = home.replace(/\\/g, "/");
	const resolvedCwd = cwd.replace(/\\/g, "/");
	if (resolvedCwd.toLowerCase().startsWith(resolvedHome.toLowerCase())) {
		return `~${resolvedCwd.slice(resolvedHome.length)}`;
	}
	return cwd;
}

function hitRate(stats: CachedStats): string {
	const denom = stats.input + stats.cacheRead + stats.cacheWrite;
	if (denom <= 0) return "0.0%";
	return `${((stats.cacheRead / denom) * 100).toFixed(1)}%`;
}

/** Format milliseconds as compact duration: "1.2s", "2.5m", "1h 3m". */
function formatDuration(ms: number): string {
	if (ms <= 0) return "0s";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	if (sec < 3600) {
		const m = Math.floor(sec / 60);
		const s = sec % 60;
		return s === 0 ? `${m}m` : `${m}m ${s}s`;
	}
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Format a Date as wall-clock HH:MM:SS in the *local* timezone, e.g.
 * "15:33:25". Pure function so it can be unit-tested.
 */
export function formatClockLocal(d: Date): string {
	const HH = String(d.getHours()).padStart(2, "0");
	const MM = String(d.getMinutes()).padStart(2, "0");
	const SS = String(d.getSeconds()).padStart(2, "0");
	return `${HH}:${MM}:${SS}`;
}

/** Offset suffix like "+08:00" or "Z" if UTC. Pure for tests. */
export function formatTzOffset(d: Date): string {
	const offsetMin = -d.getTimezoneOffset();
	if (offsetMin === 0) return "Z";
	const sign = offsetMin >= 0 ? "+" : "-";
	const abs = Math.abs(offsetMin);
	const offHH = String(Math.floor(abs / 60)).padStart(2, "0");
	const offMM = String(abs % 60).padStart(2, "0");
	return `${sign}${offHH}:${offMM}`;
}

/** Pad a row so the right cell aligns on the right side, with `gap` leading spaces. */
function layoutRow(left: string, right: string, width: number, gap = 4): string {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	const inner = Math.max(0, width - lw - rw - gap);
	if (inner <= 0) return (left + " " + right).slice(0, width);
	return left + " ".repeat(inner + gap) + right;
}

/** Data attached to the "token-summary" custom entry. */
interface TokenSummaryData {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	turns: number;
	messages: number;
	tokens: number;
	contextWindow: number;
	durationMs: number;
}

const TOKEN_SUMMARY_TYPE = "token-summary" as const;

/** Module-level renderer for the chat-embedded "Token 消耗明细" panel. */
function renderTokenSummaryEntry(entry: { data?: TokenSummaryData }, _options: { expanded: boolean }, theme: Theme) {
	const data = entry.data;
	if (!data) return undefined;
	const t = theme;
	// pi 的 usage 语义（OpenAI 兼容 provider，见 parseChunkUsage）：
	//   input     = prompt_tokens − cached_tokens − cache_write_tokens（未走缓存的输入）
	//   cacheRead = cached_tokens（缓存命中）
	//   cacheWrite= cache_write_tokens（多数 provider 不上报 → 0 = 未报告）
	// 因此「未命中」就是 input 本身；真实总输入 = input + cacheRead + cacheWrite。
	const cacheMiss = data.input;
	const totalIn = data.input + data.cacheRead + data.cacheWrite;
	const total = totalIn + data.output;
	const hit = totalIn > 0
		? `${((data.cacheRead / totalIn) * 100).toFixed(1)}%`
		: "0.0%";

	// Try to render with a Box background; fall back to plain Text if the
	// theme doesn't have a customMessageBackground colour.
	let box: Box;
	try {
		box = new Box(1, 1, (text) => t.bg("customMessageBg", text));
	} catch {
		box = new Box(1, 1, (text) => text);
	}
	box.addChild(new Text(
		`${t.fg("accent", "Token 消耗明细")}    ${t.fg("muted", "总计")} ${t.fg("accent", formatTokens(total))}`,
		0, 0,
	));
	box.addChild(new Text("", 0, 0));
	box.addChild(new Text(
		`${t.fg("accent", "▍输入")}    ${t.fg("muted", formatTokens(totalIn))}`,
		0, 0,
	));
	box.addChild(new Text(
		`  ${t.fg("success", "▍缓存命中")}    ${t.fg("muted", formatTokens(data.cacheRead))}`,
		0, 0,
	));
	box.addChild(new Text(
		`  ${t.fg("error", "▍缓存未命中")}  ${t.fg("muted", formatTokens(cacheMiss))}`,
		0, 0,
	));
	box.addChild(new Text(
		`  ${t.fg("warning", "▍缓存写入")}    ${t.fg("muted", formatTokens(data.cacheWrite))}`,
		0, 0,
	));
	box.addChild(new Text(
		`${t.fg("accent", "▍输出")}    ${t.fg("muted", formatTokens(data.output))}`,
		0, 0,
	));
	box.addChild(new Text(
		`  ${t.fg("muted", "▍思考过程")}      ${t.fg("dim", formatTokens(data.reasoning))}`,
		0, 0,
	));
	box.addChild(new Text(
		`  ${t.fg("muted", "▍回复内容")}      ${t.fg("dim", formatTokens(Math.max(0, data.output - data.reasoning)))}`,
		0, 0,
	));
	box.addChild(new Text("", 0, 0));
	box.addChild(new Text(
		`${t.fg("warning", "⚡ 缓存命中率")}    ${t.fg("warning", hit)}`,
		0, 0,
	));
	box.addChild(new Text(
		`  ${t.fg("success", "▍命中")}  ${t.fg("warning", "▍写入")}  ${t.fg("error", "▍未命中")}`,
		0, 0,
	));
	box.addChild(new Text(
		t.fg(
			"dim",
			// 底部一行对齐设计稿：Tokens + 耗时（不含 turns/msgs/积分）
			`Tokens: ${formatTokens(total)} · 耗时 ${formatDuration(data.durationMs)}`,
		),
		0, 0,
	));
	return box;
}

export const _internal = { TOKEN_SUMMARY_TYPE, renderTokenSummaryEntry, formatTokens, formatDuration };

export default function footerOverrideExtension(pi: ExtensionAPI): void {
	createFooterOverrideExtension()(pi);
}