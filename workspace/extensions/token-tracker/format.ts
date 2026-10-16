/**
 * Number / token formatting helpers.
 *
 * All numbers are emitted as human-friendly short forms (1.2K, 3.4M) with
 * a non-breaking space separating them from their label so the line
 * renders cleanly in monospace and proportional fonts alike.
 */

const NBSP = "\u202F";

export function formatInt(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (Math.abs(n) < 1_000) return String(Math.round(n));
	if (Math.abs(n) < 1_000_000) {
		const v = n / 1_000;
		return `${trimFloat(v)}${NBSP}K`;
	}
	const v = n / 1_000_000;
	return `${trimFloat(v)}${NBSP}M`;
}

function trimFloat(v: number): string {
	const abs = Math.abs(v);
	if (abs >= 100) return v.toFixed(0);
	if (abs >= 10) return v.toFixed(1);
	return v.toFixed(2).replace(/\.?0+$/, "");
}

export function pad(label: string, width: number): string {
	const visible = label.replace(/[\u202F\u00A0]/gu, " ");
	const padLen = Math.max(0, width - visible.length);
	return `${label}${" ".repeat(padLen)}`;
}