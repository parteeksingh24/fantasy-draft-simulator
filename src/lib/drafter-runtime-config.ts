// Shared runtime limits for drafter prompting and generation loops.
// Keep these values dependency-free to avoid import cycles.
export const TOOL_BUDGET = 4;
export const MAX_STEPS = TOOL_BUDGET + 3; // 7 total agentic steps
