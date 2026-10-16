/**
 * Plan representation for online context compact.
 *
 * A plan is an ordered list of steps the agent commits to. The
 * `update_plan` tool is the agent's interface for recording progress.
 *
 * We don't require agents to use it. Boundary detection also works
 * heuristically: any turn that ends with a successful non-`update_plan`
 * tool result after we saw at least one `update_plan` call counts as a
 * boundary.
 *
 * Reference: SoL-Pi src/sol-pi/extensions/online-context-compact/plan.ts
 */

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
	readonly id: string;
	readonly goal: string;
	readonly status: PlanStepStatus;
}

export interface PlanSnapshot {
	readonly steps: readonly PlanStep[];
	readonly updatedAt: number;
}

export function emptyPlan(): PlanSnapshot {
	return { steps: [], updatedAt: 0 };
}

export function parsePlanSteps(input: unknown): PlanStep[] | null {
	if (!Array.isArray(input)) return null;
	const steps: PlanStep[] = [];
	for (const raw of input) {
		if (!raw || typeof raw !== "object") return null;
		const r = raw as Record<string, unknown>;
		if (typeof r.id !== "string" || typeof r.goal !== "string") return null;
		const status: PlanStepStatus =
			r.status === "completed" || r.status === "in_progress" ? r.status : "pending";
		steps.push({ id: r.id, goal: r.goal, status });
	}
	if (steps.length === 0) return null;
	return steps;
}

export function formatPlanSnapshot(snapshot: PlanSnapshot): string {
	if (snapshot.steps.length === 0) return "(empty plan)";
	return snapshot.steps
		.map((s, i) => {
			const mark =
				s.status === "completed" ? "✓" : s.status === "in_progress" ? "…" : " ";
			return `${i + 1}. [${mark}] ${s.id}: ${s.goal}`;
		})
		.join("\n");
}

export function analyzePlanTransition(
	previous: PlanSnapshot,
	next: readonly PlanStep[],
): {
	completedSteps: PlanStep[];
	advice: string[];
} {
	const previousById = new Map(previous.steps.map((s) => [s.id, s]));
	const completedSteps: PlanStep[] = [];
	for (const nextStep of next) {
		const before = previousById.get(nextStep.id);
		if (!before) continue;
		if (before.status !== "completed" && nextStep.status === "completed") {
			completedSteps.push(nextStep);
		}
	}
	const advice: string[] = [];
	if (completedSteps.length > 0) {
		advice.push(
			`${completedSteps.length} step(s) marked completed: ${completedSteps.map((s) => s.id).join(", ")}.`,
		);
		advice.push("Online context compact may trigger on the next boundary.");
	}
	return { completedSteps, advice };
}

export function firstIncompleteStep(snapshot: PlanSnapshot): PlanStep | undefined {
	for (const step of snapshot.steps) {
		if (step.status !== "completed") return step;
	}
	return undefined;
}