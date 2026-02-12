import { s } from '@agentuity/schema';

// Position types
export const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
export const ROSTER_SLOTS = ['QB', 'RB', 'WR', 'TE', 'SUPERFLEX'] as const;

export const PositionSchema = s.enum(POSITIONS);
export const RosterSlotSchema = s.enum(ROSTER_SLOTS);

export type Position = s.infer<typeof PositionSchema>;
export type RosterSlot = s.infer<typeof RosterSlotSchema>;

// Player data (from Sleeper API, stored in Vector)
export const PlayerSchema = s.object({
	playerId: s.string().describe('Unique player identifier from Sleeper'),
	name: s.string().describe('Full player name'),
	position: PositionSchema.describe('Player position'),
	team: s.string().describe('NFL team abbreviation'),
	adp: s.number().describe('Average draft position'),
	tier: s.number().describe('Player tier (1 = elite, 5 = deep)'),
	age: s.number().describe('Player age'),
	byeWeek: s.number().describe('Bye week number'),
});

export type Player = s.infer<typeof PlayerSchema>;

// Player metadata for Vector storage
export interface PlayerMetadata extends Record<string, unknown> {
	playerId: string;
	name: string;
	position: Position;
	team: string;
	adp: number;
	tier: number;
	age: number;
	byeWeek: number;
}

// Draft pick record
export const PickSchema = s.object({
	pickNumber: s.number().describe('Overall pick number (1-60)'),
	round: s.number().describe('Draft round (1-5)'),
	teamIndex: s.number().describe('Team index (0-11)'),
	playerId: s.string().describe('Selected player ID'),
	playerName: s.string().describe('Selected player name'),
	position: PositionSchema.describe('Selected player position'),
	reasoning: s.string().describe('Why this player was selected'),
	confidence: s.number().describe('Confidence score 0-1'),
});

export type Pick = s.infer<typeof PickSchema>;

// Team roster tracking
export const RosterSchema = s.object({
	teamIndex: s.number().describe('Team index (0-11)'),
	teamName: s.string().describe('Team display name'),
	qb: s.optional(PlayerSchema).describe('Quarterback slot'),
	rb: s.optional(PlayerSchema).describe('Running back slot'),
	wr: s.optional(PlayerSchema).describe('Wide receiver slot'),
	te: s.optional(PlayerSchema).describe('Tight end slot'),
	superflex: s.optional(PlayerSchema).describe('Superflex slot (any position)'),
});

export type Roster = s.infer<typeof RosterSchema>;

// Current pick info
export const CurrentPickSchema = s.object({
	pickNumber: s.number().describe('Overall pick number'),
	round: s.number().describe('Current round (1-5)'),
	teamIndex: s.number().describe('Team on the clock'),
	isHuman: s.boolean().describe('Whether the current pick is human'),
});

export type CurrentPick = s.infer<typeof CurrentPickSchema>;

// Draft settings
export const DraftSettingsSchema = s.object({
	numTeams: s.number().describe('Number of teams in the draft'),
	numRounds: s.number().describe('Number of rounds'),
	humanTeamIndex: s.number().describe('Which team the human controls (0-11)'),
});

export type DraftSettings = s.infer<typeof DraftSettingsSchema>;

// Full board state stored in KV
export const BoardStateSchema = s.object({
	picks: s.array(PickSchema).describe('All picks made so far'),
	currentPick: CurrentPickSchema.describe('Current pick info'),
	settings: DraftSettingsSchema.describe('Draft configuration'),
	draftComplete: s.boolean().describe('Whether all rounds are done'),
});

export type BoardState = s.infer<typeof BoardStateSchema>;

// KV namespace constants
export const KV_DRAFT_STATE = 'draft-state';
export const KV_TEAM_ROSTERS = 'team-rosters';
export const KV_AGENT_STRATEGIES = 'agent-strategies';

// KV key constants
export const KEY_BOARD_STATE = 'board';
export const KEY_AVAILABLE_PLAYERS = 'available-players';
export const KEY_SETTINGS = 'settings';

// Vector namespace
export const VECTOR_PLAYERS = 'players';

// Draft constants
export const NUM_TEAMS = 12;
export const NUM_ROUNDS = 5;
export const TOTAL_PICKS = NUM_TEAMS * NUM_ROUNDS;

// Team names for display
export const TEAM_NAMES = [
	'Team 1', 'Team 2', 'Team 3', 'Team 4',
	'Team 5', 'Team 6', 'Team 7', 'Team 8',
	'Team 9', 'Team 10', 'Team 11', 'Team 12',
] as const;

/**
 * Calculate snake draft order.
 * Odd rounds (1, 3, 5): picks go 0→11
 * Even rounds (2, 4): picks go 11→0
 */
export function getSnakeDraftPick(pickNumber: number): { round: number; teamIndex: number } {
	const round = Math.ceil(pickNumber / NUM_TEAMS);
	const pickInRound = ((pickNumber - 1) % NUM_TEAMS);
	const isEvenRound = round % 2 === 0;
	const teamIndex = isEvenRound ? (NUM_TEAMS - 1 - pickInRound) : pickInRound;
	return { round, teamIndex };
}

/**
 * Get available roster slots for a team based on what they've already filled.
 */
export function getAvailableSlots(roster: Roster): RosterSlot[] {
	const slots: RosterSlot[] = [];
	if (!roster.qb) slots.push('QB');
	if (!roster.rb) slots.push('RB');
	if (!roster.wr) slots.push('WR');
	if (!roster.te) slots.push('TE');
	if (!roster.superflex) slots.push('SUPERFLEX');
	return slots;
}

/**
 * Check if a position can fill one of the team's available roster slots.
 */
export function canDraftPosition(roster: Roster, position: Position): boolean {
	// Check if the dedicated slot for this position is open
	const slotKey = position.toLowerCase() as 'qb' | 'rb' | 'wr' | 'te';
	if (!roster[slotKey]) return true;

	// Check if superflex is open (any position can fill it)
	if (!roster.superflex) return true;

	return false;
}

/**
 * Determine which roster slot a pick fills.
 */
export function assignRosterSlot(roster: Roster, position: Position): RosterSlot | null {
	const slotKey = position.toLowerCase() as 'qb' | 'rb' | 'wr' | 'te';
	if (!roster[slotKey]) return position;
	if (!roster.superflex) return 'SUPERFLEX';
	return null;
}
