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

export interface PersonaAssignment {
	teamIndex: number;
	persona: string;
}

export interface StrategyShift {
	pickNumber: number;
	teamIndex: number;
	persona: string;
	trigger: string;
	reasoning: string;
	playerPicked: string;
	position: Position;
}

export const NUM_TEAMS = 12;
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
	'Team 9', 'Team 10', 'Team 11', 'Team 12',
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
}

export interface ToolResultEvent {
	name: string;
	result: unknown;
}

export interface ToolCallRecord {
	name: string;
	args: Record<string, unknown>;
	result?: unknown;
	timestamp: number;
}

// Color mapping for tool call cards in ThinkingPanel
export const TOOL_COLORS: Record<string, { text: string; bg: string; border: string }> = {
	searchPlayers: { text: 'text-cyan-400', bg: 'bg-cyan-500/20', border: 'border-cyan-500/30' },
	getTopAvailable: { text: 'text-blue-400', bg: 'bg-blue-500/20', border: 'border-blue-500/30' },
	analyzeBoardTrends: { text: 'text-yellow-400', bg: 'bg-yellow-500/20', border: 'border-yellow-500/30' },
	getTeamRoster: { text: 'text-green-400', bg: 'bg-green-500/20', border: 'border-green-500/30' },
};

// Model names for each persona
export const PERSONA_MODELS: Record<string, string> = {
	'drafter-balanced': 'claude-sonnet-4-5',
	'drafter-bold': 'gpt-5-mini',
	'drafter-zero-rb': 'claude-haiku-4-5',
	'drafter-qb-first': 'grok-3-fast',
	'drafter-stud-rb': 'gpt-5-nano',
	'drafter-value-hunter': 'claude-haiku-4-5',
	'drafter-stack-builder': 'deepseek-chat',
	'drafter-te-premium': 'kimi-k2.5',
	'drafter-youth-movement': 'claude-haiku-4-5',
	'drafter-contrarian': 'grok-4-1-fast-reasoning',
	'drafter-risk-averse': 'grok-4-1-fast-reasoning',
	'drafter-reactive': 'gpt-5-mini',
};
