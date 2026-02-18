/**
 * Persona assignment system for the fantasy draft.
 * Randomly assigns weighted personas to AI team slots,
 * allowing duplicates (realistic: multiple teams may share a strategy archetype).
 */

export const KV_PERSONA_ASSIGNMENTS = 'persona-assignments';

export interface PersonaAssignment {
	teamIndex: number;
	persona: string;
}

export const PERSONA_POOL = [
	{ agentName: 'drafter-balanced', weight: 2 },
	{ agentName: 'drafter-bold', weight: 1 },
	{ agentName: 'drafter-zero-rb', weight: 1 },
	{ agentName: 'drafter-qb-first', weight: 1 },
	{ agentName: 'drafter-stud-rb', weight: 1 },
	{ agentName: 'drafter-value-hunter', weight: 1.5 },
	{ agentName: 'drafter-stack-builder', weight: 1 },
	{ agentName: 'drafter-te-premium', weight: 0.5 },
	{ agentName: 'drafter-youth-movement', weight: 1 },
	{ agentName: 'drafter-contrarian', weight: 0.5 },
	{ agentName: 'drafter-risk-averse', weight: 1.5 },
] as const;

/**
 * Pick a random persona from the pool using weighted selection.
 * Higher weight = more likely to be selected.
 */
function weightedRandomPick(): string {
	const totalWeight = PERSONA_POOL.reduce((sum, p) => sum + p.weight, 0);
	let roll = Math.random() * totalWeight;

	for (const persona of PERSONA_POOL) {
		roll -= persona.weight;
		if (roll <= 0) {
			return persona.agentName;
		}
	}

	// Fallback (should not be reached due to floating-point, but safe)
	return PERSONA_POOL[0].agentName;
}

/**
 * Assign personas to all teams in the draft.
 *
 * @param numTeams - Total number of teams (typically 8)
 * @param humanTeamIndex - The index of the human-controlled team (0-based)
 * @returns Array of PersonaAssignment, one per team. The human slot has persona 'human'.
 */
export function assignPersonas(numTeams: number, humanTeamIndex: number): PersonaAssignment[] {
	const assignments: PersonaAssignment[] = [];

	// Collect AI slot indices (everything except the human)
	const aiIndices: number[] = [];
	for (let i = 0; i < numTeams; i++) {
		if (i === humanTeamIndex) {
			assignments.push({ teamIndex: i, persona: 'human' });
		} else {
			assignments.push({ teamIndex: i, persona: '' }); // placeholder
			aiIndices.push(i);
		}
	}

	// Fisher-Yates shuffle the AI indices
	for (let i = aiIndices.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[aiIndices[i], aiIndices[j]] = [aiIndices[j]!, aiIndices[i]!];
	}

	// Guarantee exactly 2 Reactive slots
	const reactiveCount = Math.min(2, aiIndices.length);
	for (let i = 0; i < reactiveCount; i++) {
		assignments[aiIndices[i]!]!.persona = 'drafter-reactive';
	}

	// Fill remaining AI slots with weighted random picks
	for (let i = reactiveCount; i < aiIndices.length; i++) {
		assignments[aiIndices[i]!]!.persona = weightedRandomPick();
	}

	return assignments;
}
