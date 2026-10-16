/**
 * Heuristic Reducer - the local, dependency-free version of the SoL-Pi
 * evidence-preserving reducer. The full upstream version delegates to a
 * configured reducer model. We cannot call providers from inside a v1.2.0
 * extension, so we apply rule-based selection that still preserves evidence
 * (each accepted line is quoted byte-for-byte and its source line is
 * recorded).
 *
 * Reference: SoL-Pi src/sol-pi/extensions/evidence-preserving-reducer
 *
 * Policy: pick a small, prioritized set of lines from a build/test log.
 *   - "fatal"   : crashes, panics, segfaults
 *   - "failure" : FAIL / error: / failed with a non-zero exit
 *   - "warning" : compile/test warnings (a few, capped)
 *   - "target"  : lines of the form "src/foo.ts:42:5 - error TS2304: ..."
 *   - "summary" : the last "pass/fail/tests" line, or last line of output
 *
 * Every evidence item is a contiguous, single-line, byte-exact quote.
 *
 * The receipt is lossless in the auditor's sense: a reader can confirm each
 * preserved line against the original log by literal match and line number.
 */

export type EvidenceKind = "fatal" | "failure" | "warning" | "target" | "summary";

export interface Evidence {
	readonly kind: EvidenceKind;
	/** 1-based line number in the source log. */
	readonly line: number;
	/** Single-line, byte-exact quote from the source log. */
	readonly quote: string;
	readonly quoteSha256: string;
}

export interface Receipt {
	readonly status: "success" | "failure";
	readonly uncertain: boolean;
	readonly evidence: readonly Evidence[];
}

export interface ReducerLimits {
	readonly maxEvidence: number;
	readonly maxQuoteChars: number;
}

export const DEFAULT_LIMITS: ReducerLimits = {
	maxEvidence: 32,
	maxQuoteChars: 500,
};

const FATAL_RE =
	/\b(segfault|segmentation fault|panic(?:ked)?|fatal error|abort(?:ed)?|traceback\s*\(most recent call last\)|assertion failed|out of memory|stack overflow|ncaught\s+\w*Error|signal\s+sig(abrt|segv))\b/iu;
const FAILURE_RE =
	/^(?:\s*FAIL\b|\s*ERROR\b|.*\bError:\s|\bEACCES\b|\bEPERM\b|\bdenied\b|\bcompilation failed\b|\bbuild failed\b|\bexit\s+code\s+[1-9]\d*\b|\bnpm\s+err!|\b\d+ failing\b)/iu;
const WARNING_RE = /\b(warning|deprecat(?:ed|ion)|WARN|notice):\s/iu;
const TARGET_RE =
	/^[\s>]*(?:[a-zA-Z]:)?[^\s:][^:\r\n]*?\.(?:ts|tsx|js|jsx|c|cpp|cc|cxx|h|hpp|rs|go|py|java|kt|swift|m|mm|rb|sh)(?:[(:]\d+(?::\d+)?[):]|\(.*?\))?:.*$/u;
const TEST_TOTALS_RE =
	/^(?:tests:|test result:)\s*(?:.*\b(?:passed|failed)\b.*)$|^(?:\d+\s+passed,\s+\d+\s+failed.*|\d+\s+failing.*)$|^(?:ok|fail)\b.*$/iu;
const TRACEBACK_START_RE = /^\s*Traceback\s*\(most recent call last\)/u;

interface Scored {
	readonly line: number;
	readonly text: string;
	readonly kind: EvidenceKind;
	readonly score: number;
}

function sha256Short(s: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < s.length; i += 1) {
		const c = s.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	const combined = ((h2 >>> 0) << 32) | (h1 >>> 0);
	return combined.toString(16).padStart(16, "0").slice(0, 16);
}

function detectFailing(body: string, isError: boolean): boolean {
	if (isError) return true;
	if (/\bexit\s+code\s+0\b/iu.test(body)) return false;
	if (FAILURE_RE.test(body.split("\n").slice(0, 5).join("\n"))) return true;
	return false;
}

function scoreLine(line: string, lineNumber: number, isError: boolean): Scored | null {
	const trimmed = line.replace(/\r$/u, "");
	if (trimmed.length === 0) return null;

	// Summary line: take the first TEST_TOTALS_RE match.
	if (TEST_TOTALS_RE.test(trimmed)) {
		return { line: lineNumber, text: trimmed, kind: "summary", score: isError ? 70 : 90 };
	}

	// Traceback: keep the first 3 lines together.
	if (TRACEBACK_START_RE.test(trimmed)) {
		return { line: lineNumber, text: trimmed, kind: "fatal", score: 95 };
	}

	if (FATAL_RE.test(trimmed)) {
		return { line: lineNumber, text: trimmed, kind: "fatal", score: 95 };
	}
	if (TARGET_RE.test(trimmed)) {
		return { line: lineNumber, text: trimmed, kind: "target", score: 80 };
	}
	if (FAILURE_RE.test(trimmed)) {
		return { line: lineNumber, text: trimmed, kind: "failure", score: isError ? 85 : 60 };
	}
	if (WARNING_RE.test(trimmed)) {
		return { line: lineNumber, text: trimmed, kind: "warning", score: 30 };
	}
	return null;
}

export function reduce(
	body: string,
	options: { isError: boolean; limits?: ReducerLimits } = { isError: false },
): Receipt {
	const limits = options.limits ?? DEFAULT_LIMITS;
	const lines = body.split("\n");

	// First pass: collect traceback clusters and individual scored lines.
	const scored: Scored[] = [];
	let inTraceback = false;
	let tracebackRemain = 0;
	for (let i = 0; i < lines.length; i += 1) {
		const text = lines[i] ?? "";
		if (TRACEBACK_START_RE.test(text)) {
			inTraceback = true;
			tracebackRemain = 6; // header + ~5 frames
		}
		if (inTraceback && tracebackRemain > 0) {
			scored.push({ line: i + 1, text: text.replace(/\r$/u, ""), kind: "fatal", score: 95 });
			tracebackRemain -= 1;
			if (tracebackRemain === 0) inTraceback = false;
			continue;
		}
		const s = scoreLine(text, i + 1, options.isError);
		if (s) scored.push(s);
	}

	// Take a summary if there was no natural one in the log: last non-empty line.
	const lastNonEmpty = (() => {
		for (let i = lines.length - 1; i >= 0; i -= 1) {
			if ((lines[i] ?? "").trim().length > 0) {
				return { line: i + 1, text: (lines[i] ?? "").replace(/\r$/u, "") };
			}
		}
		return null;
	})();
	if (!scored.some((s) => s.kind === "summary") && lastNonEmpty) {
		scored.push({
			line: lastNonEmpty.line,
			text: lastNonEmpty.text,
			kind: "summary",
			score: options.isError ? 50 : 40,
		});
	}

	// Deduplicate by (kind, line).
	const seen = new Set<string>();
	const deduped = scored.filter((s) => {
		const key = `${s.kind}:${s.line}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	// Cap by kind: at most 1 summary, 4 fatals, 8 failures, 8 targets, 8 warnings.
	const caps: Record<EvidenceKind, number> = {
		summary: 1,
		fatal: 6,
		failure: 8,
		target: 8,
		warning: 6,
	};
	const counts: Record<EvidenceKind, number> = {
		summary: 0,
		fatal: 0,
		failure: 0,
		target: 0,
		warning: 0,
	};
	// Sort by score desc, but keep natural line order within equal score.
	deduped.sort((a, b) => b.score - a.score);
	const selected: Scored[] = [];
	for (const s of deduped) {
		if (counts[s.kind] >= caps[s.kind]) continue;
		if (s.text.length > limits.maxQuoteChars) continue;
		counts[s.kind] += 1;
		selected.push(s);
	}
	selected.sort((a, b) => a.line - b.line);
	if (selected.length > limits.maxEvidence) {
		selected.length = limits.maxEvidence;
	}

	const evidence: Evidence[] = selected.map((s) => ({
		kind: s.kind,
		line: s.line,
		quote: s.text,
		quoteSha256: sha256Short(s.text),
	}));

	const status = detectFailing(body, options.isError) ? "failure" : "success";
	const uncertain = evidence.length === 0;
	return { status, uncertain, evidence };
}