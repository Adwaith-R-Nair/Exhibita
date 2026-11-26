// Which Jira work type a new dispute becomes. A dispute is one standard work item: never an epic
// (hierarchy level 1 and above) and never a subtask.

export interface WorkTypeOption {
  id: string;
  name: string;
  subtask: boolean;
  hierarchyLevel?: number;
}

/** Preferred names, best first. Matching ignores case. */
export const PREFERRED_WORK_TYPES = ['dispute', 'service request', 'task', 'support', 'request'] as const;

export function chooseWorkType(options: readonly WorkTypeOption[]): WorkTypeOption | null {
  const standard = options.filter((t) => !t.subtask && (t.hierarchyLevel ?? 0) === 0);
  for (const name of PREFERRED_WORK_TYPES) {
    const hit = standard.find((t) => t.name.toLowerCase() === name);
    if (hit) return hit;
  }
  return standard[0] ?? null;
}
