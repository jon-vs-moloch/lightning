import type { BranchRecord, BranchTemperature } from "./types.js";

export interface SchedulerInput {
  branches: BranchRecord[];
  activeBranchIds?: string[];
  maxHotBranches?: number;
}

export interface SchedulerDecision {
  branchId: string;
  from: BranchTemperature;
  to: BranchTemperature;
  reason: string;
}

export function planThermalTransitions(input: SchedulerInput): SchedulerDecision[] {
  const maxHotBranches = Math.max(1, input.maxHotBranches ?? 3);
  const active = new Set(input.activeBranchIds ?? []);

  const ranked = [...input.branches].sort((a, b) => {
    const activeDelta = Number(active.has(b.id)) - Number(active.has(a.id));
    if (activeDelta !== 0) return activeDelta;
    return b.priority - a.priority;
  });

  return ranked.map((branch, index) => {
    const nextTemperature: BranchTemperature =
      branch.temperature === "frozen"
        ? "frozen"
        : index < maxHotBranches
          ? "hot"
          : index < maxHotBranches + 3
            ? "warm"
            : "cold";

    return {
      branchId: branch.id,
      from: branch.temperature,
      to: nextTemperature,
      reason:
        nextTemperature === branch.temperature
          ? "No thermal change needed."
          : active.has(branch.id)
            ? "Active branch remains prioritized."
            : "Rebalanced thermal budget across the branch set."
    };
  });
}
