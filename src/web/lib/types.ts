// Frontend-specific types. Duplicated from backend lib/types.ts
// to avoid importing from the backend directory in frontend code.

export type Position = 'QB' | 'RB' | 'WR' | 'TE';
export type RosterSlot = 'QB' | 'RB' | 'WR' | 'TE' | 'SUPERFLEX';

export interface Player {
	playerId: string;
	name: string;
	position: Position;
	team: string;
	rank: number;
	tier: number;
	age: number;
	byeWeek: number;
}

export interface Pick {
	pickNumber: number;
	round: number;
	teamIndex: number;
	playerId: string;
	playerName: string;
	position: Position;
	reasoning: string;
	confidence: number;
}

export interface CurrentPick {
	pickNumber: number;
	round: number;
	teamIndex: number;
	isHuman: boolean;
}

export interface DraftSettings {
	numTeams: number;
	numRounds: number;
	humanTeamIndex: number;
}

export interface BoardState {
	picks: Pick[];
	currentPick: CurrentPick;
	settings: DraftSettings;
	draftComplete: boolean;
}

export interface Roster {
	teamIndex: number;
	teamName: string;
	qb?: Player;
	rb?: Player;
	wr?: Player;
	te?: Player;
	superflex?: Player;
}

/** Check if a position can fill one of the team's available roster slots. */
export function canDraftPosition(roster: Roster, position: Position): boolean {
	const slotKey = position.toLowerCase() as 'qb' | 'rb' | 'wr' | 'te';
	if (!roster[slotKey]) return true;
	if (!roster.superflex) return true;
	return false;
}

export interface PersonaAssignment {
	teamIndex: number;
	persona: string;
}

export type ShiftCategory =
	| 'strategy-break'
	| 'value-deviation'
	| 'trend-follow'
	| 'trend-fade'
	| 'positional-pivot';

export type ShiftSeverity = 'minor' | 'major';

export interface StrategyShift {
	pickNumber: number;
	teamIndex: number;
	persona: string;
	trigger: string;
	reasoning: string;
	playerPicked: string;
	position: Position;
	category: ShiftCategory;
	severity: ShiftSeverity;
}

export interface TeamShiftSummary {
	teamIndex: number;
	totalShifts: number;
	last3TeamPicksShiftCount: number;
	majorShiftCount: number;
	topCategory: ShiftCategory | null;
}

export const NUM_TEAMS = 8;
export const NUM_ROUNDS = 5;

export const POSITION_COLORS: Record<Position, { text: string; bg: string; border: string }> = {
	QB: { text: 'text-red-400', bg: 'bg-red-500/20', border: 'border-red-500/30' },
	RB: { text: 'text-cyan-400', bg: 'bg-cyan-500/20', border: 'border-cyan-500/30' },
	WR: { text: 'text-green-400', bg: 'bg-green-500/20', border: 'border-green-500/30' },
	TE: { text: 'text-orange-400', bg: 'bg-orange-500/20', border: 'border-orange-500/30' },
};

export const TEAM_NAMES = [
	'Team 1', 'Team 2', 'Team 3', 'Team 4',
	'Team 5', 'Team 6', 'Team 7', 'Team 8',
];

export const PERSONA_DESCRIPTIONS: Record<string, string> = {
	'drafter-balanced': 'Picks the best player available while considering positional needs. Balanced approach.',
	'drafter-bold': 'Aggressive, swing-for-the-fences drafter. Prioritizes ceiling over floor, reaches for breakout candidates.',
	'drafter-zero-rb': 'Avoids RBs in early rounds. Prioritizes elite WRs, QBs, and TEs first.',
	'drafter-qb-first': 'Believes QBs are the most valuable SUPERFLEX asset. Reaches for elite QBs early.',
	'drafter-stud-rb': 'RB-first approach. Locks in a bellcow running back as early as possible.',
	'drafter-value-hunter': 'Pure value drafter. Picks whichever player has fallen the furthest past their expected rank.',
	'drafter-stack-builder': 'Builds QB/WR stacks from the same NFL team for correlated upside.',
	'drafter-te-premium': 'Reaches for elite TEs early, exploiting the massive drop-off after the top 3-5 tight ends.',
	'drafter-youth-movement': 'Dynasty-minded. Strongly prefers young players under 26 and avoids aging veterans.',
	'drafter-contrarian': 'Does the opposite of the room. If everyone drafts RBs, pivots to WR. Exploits positional runs.',
	'drafter-risk-averse': 'Conservative, floor-based drafter. Picks the safest, most consistent option every time.',
	'drafter-reactive': 'Panics on position runs and jumps on value drops. Always analyzes board trends first, then reacts emotionally.',
	'human': 'You!',
};

// Display names for persona agent types
export const PERSONA_DISPLAY_NAMES: Record<string, string> = {
	'drafter-balanced': 'Balanced',
	'drafter-bold': 'Bold',
	'drafter-zero-rb': 'Zero RB',
	'drafter-qb-first': 'QB First',
	'drafter-stud-rb': 'Stud RB',
	'drafter-value-hunter': 'Value Hunter',
	'drafter-stack-builder': 'Stack Builder',
	'drafter-te-premium': 'TE Premium',
	'drafter-youth-movement': 'Youth Move',
	'drafter-contrarian': 'Contrarian',
	'drafter-risk-averse': 'Risk Averse',
	'drafter-reactive': 'Reactive',
	'human': 'You',
};

// Tool call types for streaming
export interface ToolCallEvent {
	name: string;
	args: Record<string, unknown>;
	toolCallId?: string;
}

export interface ToolResultEvent {
	name: string;
	result: unknown;
	toolCallId?: string;
}

export interface ToolCallRecord {
	name: string;
	args: Record<string, unknown>;
	toolCallId?: string;
	result?: unknown;
	timestamp: number;
}

// Color mapping for tool call cards in ThinkingPanel
export const TOOL_COLORS: Record<string, { text: string; bg: string; border: string }> = {
	getTopAvailable: { text: 'text-blue-400', bg: 'bg-blue-500/20', border: 'border-blue-500/30' },
	analyzeBoardTrends: { text: 'text-yellow-400', bg: 'bg-yellow-500/20', border: 'border-yellow-500/30' },
	getTeamRoster: { text: 'text-green-400', bg: 'bg-green-500/20', border: 'border-green-500/30' },
	getDraftIntel: { text: 'text-cyan-400', bg: 'bg-cyan-500/20', border: 'border-cyan-500/30' },
	writeScoutingNote: { text: 'text-purple-400', bg: 'bg-purple-500/20', border: 'border-purple-500/30' },
};

// Model names for each persona
export const PERSONA_MODELS: Record<string, string> = {
	'drafter-balanced': 'claude-sonnet-4-5',
	'drafter-bold': 'gpt-5-mini',
	'drafter-zero-rb': 'claude-haiku-4-5',
	'drafter-qb-first': 'grok-4-fast-reasoning',
	'drafter-stud-rb': 'gpt-5-nano',
	'drafter-value-hunter': 'claude-haiku-4-5',
	'drafter-stack-builder': 'deepseek-reasoner',
	'drafter-te-premium': 'gpt-5-mini',
	'drafter-youth-movement': 'claude-haiku-4-5',
	'drafter-contrarian': 'grok-4-1-fast-reasoning',
	'drafter-risk-averse': 'grok-code-fast-1',
	'drafter-reactive': 'gpt-5-mini',
};

export const SHIFT_CATEGORY_LABELS: Record<ShiftCategory, string> = {
	'strategy-break': 'Strategy Break',
	'value-deviation': 'Value Deviation',
	'trend-follow': 'Trend Follow',
	'trend-fade': 'Trend Fade',
	'positional-pivot': 'Positional Pivot',
};
