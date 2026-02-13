/**
 * Shared tool factory for drafter agents.
 *
 * createDrafterTools(deps) returns 5 AI SDK tools that let drafter agents
 * research players, analyze the board, inspect rosters, gather intel from
 * prior rounds, and write private scouting notes.
 *
 * Tool surface:
 *   getTopAvailable    - rank-sorted available players
 *   analyzeBoardTrends - position runs, value drops, scarcity
 *   getTeamRoster      - any team's roster and open slots
 *   getDraftIntel      - merged read: own scouting notes + recent global reasoning + optional synthesis
 *   writeScoutingNote  - save an observation for future rounds
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { KeyValueStorage } from '@agentuity/core';
import { analyzeBoardState } from './board-analysis';
import {
	type Player,
	type Pick,
	type Roster,
	type ScoutingNote,
	type ReasoningSummary,
	type StrategyShift,
	KV_TEAM_ROSTERS,
	KV_SCOUTING_NOTES,
	KV_AGENT_STRATEGIES,
	KV_PICK_REASONING,
	MAX_NOTES_PER_TEAM,
	MAX_NOTE_LENGTH,
	canDraftPosition,
	getAvailableSlots,
} from './types';

// ---------------------------------------------------------------------------
// Dependencies interface
// ---------------------------------------------------------------------------

export interface DrafterToolsDeps {
	kv: KeyValueStorage;
	availablePlayers: Player[];
	roster: Roster;
	picks: Pick[];
	pickNumber: number;
	teamIndex: number;
	round: number;
}

// ---------------------------------------------------------------------------
// Shared result type for player data returned by tools
// ---------------------------------------------------------------------------

interface PlayerResult {
	playerId: string;
	name: string;
	position: string;
	team: string;
	rank: number;
	tier: number;
	age: number;
	value: number;
}

// ---------------------------------------------------------------------------
// getDraftIntel payload types
// ---------------------------------------------------------------------------

interface IntelNote {
	id: string;
	round: number;
	pickNumber: number;
	text: string;
	tags: string[];
	type: 'general' | 'shift';
}

interface IntelReasoningItem {
	pickNumber: number;
	teamIndex: number;
	persona: string;
	playerName: string;
	position: string;
	summary: string;
	confidence: number;
}

interface IntelShiftItem {
	pickNumber: number;
	category: StrategyShift['category'];
	severity: StrategyShift['severity'];
	trigger: string;
}

interface DraftIntelResult {
	yourNotes: IntelNote[];
	recentReasoning: IntelReasoningItem[];
	recentTeamShifts: IntelShiftItem[];
	intelSummary?: string;
}

// ---------------------------------------------------------------------------
// createDrafterTools
// ---------------------------------------------------------------------------

export function createDrafterTools(deps: DrafterToolsDeps) {
	return {
		getTopAvailable: tool({
			description:
				'Get the top available players sorted by rank (lower rank = better). Use this to see who is available before making a pick. Optionally filter by position.',
			inputSchema: z.object({
				position: z
					.enum(['QB', 'RB', 'WR', 'TE'])
					.optional()
					.describe('Filter to a specific position'),
				limit: z
					.number()
					.optional()
					.default(15)
					.describe('Max results to return (default 15)'),
			}),
			execute: async ({ position, limit }): Promise<PlayerResult[]> => {
				let candidates = deps.availablePlayers;

				// Optional position filter
				if (position) {
					candidates = candidates.filter((p) => p.position === position);
				}

				// Filter by roster eligibility
				candidates = candidates.filter((p) => canDraftPosition(deps.roster, p.position));

				// Sort by rank ascending (lower = better)
				candidates = [...candidates].sort((a, b) => a.rank - b.rank);

				// Slice to limit
				candidates = candidates.slice(0, limit ?? 15);

				return candidates.map((p) => ({
					playerId: p.playerId,
					name: p.name,
					position: p.position,
					team: p.team,
					rank: p.rank,
					tier: p.tier,
					age: p.age,
					value: deps.pickNumber - p.rank,
				}));
			},
		}),

		analyzeBoardTrends: tool({
			description:
				'Analyze recent draft trends including position runs, value drops, and scarcity alerts. Use this to understand board dynamics before making a pick.',
			inputSchema: z.object({}),
			execute: async () => {
				const analysis = analyzeBoardState(deps.picks, deps.availablePlayers, deps.pickNumber);

				return {
					positionRuns: analysis.positionRuns,
					valueDrops: analysis.valueDrops.slice(0, 5),
					scarcity: analysis.scarcity,
					summary: analysis.summary,
				};
			},
		}),

		getTeamRoster: tool({
			description:
				'Get any team\'s current roster to see what positions they have filled and what slots remain open. Useful for predicting what other teams might draft.',
			inputSchema: z.object({
				teamIndex: z
					.number()
					.min(0)
					.max(11)
					.describe('Team index (0-11)'),
			}),
			execute: async ({ teamIndex }) => {
				const result = await deps.kv.get<Roster>(KV_TEAM_ROSTERS, `team-${teamIndex}`);

				if (!result.exists) {
					return {
						teamIndex,
						roster: null,
						openSlots: ['QB', 'RB', 'WR', 'TE', 'SUPERFLEX'],
					};
				}

				const roster = result.data;
				const openSlots = getAvailableSlots(roster);

				return {
					teamIndex,
					roster,
					openSlots,
				};
			},
		}),

		getDraftIntel: tool({
				description:
					'Get combined draft intelligence in one call: your private scouting notes from prior rounds, structured reasoning summaries of recent global picks, and your recent strategy shifts. Use this early each turn to recall your observations and understand what other teams are doing.',
				inputSchema: z.object({
					noteLimit: z
						.number()
						.min(1)
						.max(10)
						.optional()
						.default(5)
						.describe('Max scouting notes to return (default 5, max 10)'),
					noteTag: z
						.string()
						.optional()
						.describe('Filter notes by tag'),
				}),
				execute: async ({ noteLimit, noteTag }): Promise<DraftIntelResult> => {
					// --- Parallel KV reads: notes, reasoning summaries, and shifts ---
					const REASONING_CAP = 3;
					const reasoningKeys: string[] = [];
					for (let i = deps.pickNumber - 1; i >= Math.max(1, deps.pickNumber - REASONING_CAP); i--) {
						reasoningKeys.push(`pick-${i}`);
					}

					const [notesResult, shiftsResult, ...reasoningResults] = await Promise.all([
						deps.kv.get<ScoutingNote[]>(KV_SCOUTING_NOTES, `team-${deps.teamIndex}`),
						deps.kv.get<StrategyShift[]>(KV_AGENT_STRATEGIES, 'strategy-shifts'),
						...reasoningKeys.map((key) => deps.kv.get<ReasoningSummary>(KV_PICK_REASONING, key)),
					]);

					// --- Your scouting notes ---
					let rawNotes: ScoutingNote[] = notesResult.exists ? notesResult.data : [];

					// Optional tag filter
					if (noteTag) {
						rawNotes = rawNotes.filter((n) => n.tags.includes(noteTag));
					}

					// Most recent first, limited
					const cap = Math.min(Math.max(noteLimit ?? 5, 1), 10);
					const yourNotes: IntelNote[] = rawNotes.slice(-cap).reverse().map((n) => ({
						id: n.id,
						round: n.round,
						pickNumber: n.pickNumber,
						text: n.text,
						tags: n.tags,
						type: n.type ?? 'general',
					}));

					// --- Recent global reasoning ---
					const recentReasoning: IntelReasoningItem[] = [];
					for (const result of reasoningResults) {
						if (result.exists) {
							recentReasoning.push({
								pickNumber: result.data.pickNumber,
								teamIndex: result.data.teamIndex,
								persona: result.data.persona,
								playerName: result.data.playerName,
								position: result.data.position,
								summary: result.data.summary,
								confidence: result.data.confidence,
							});
						}
					}

					// --- Recent team strategy shifts (fixed cap of 2) ---
					const recentTeamShifts: IntelShiftItem[] = (shiftsResult.exists ? shiftsResult.data : [])
						.filter((shift) => shift.teamIndex === deps.teamIndex)
						.slice(-2)
						.reverse()
						.map((shift) => ({
							pickNumber: shift.pickNumber,
							category: shift.category ?? 'positional-pivot',
							severity: shift.severity ?? 'minor',
							trigger: shift.trigger,
						}));

					// --- Optional intel summary ---
					let intelSummary: string | undefined;
					if (yourNotes.length > 0 || recentReasoning.length > 0 || recentTeamShifts.length > 0) {
						const parts: string[] = [];
						if (yourNotes.length > 0) {
							parts.push(`You have ${yourNotes.length} scouting note(s) from prior rounds.`);
						}
						if (recentReasoning.length > 0) {
							const positions = recentReasoning.map((r) => r.position);
							const positionCounts = positions.reduce<Record<string, number>>((acc, pos) => {
								acc[pos] = (acc[pos] ?? 0) + 1;
								return acc;
							}, {});
							parts.push(
								`Last ${recentReasoning.length} picks: ${Object.entries(positionCounts).map(([pos, count]) => `${count} ${pos}`).join(', ')}.`,
							);
						}
						if (recentTeamShifts.length > 0) {
							const shifts = recentTeamShifts.map((s) => `${s.category} (${s.severity})`).join(', ');
							parts.push(`Recent strategy shifts: ${shifts}.`);
						}
						intelSummary = parts.join(' ');
					}

					return { yourNotes, recentReasoning, recentTeamShifts, intelSummary };
				},
			}),

		writeScoutingNote: tool({
			description:
				'Save an observation for future rounds. Use this when you notice something worth remembering (e.g. a position run forming, a rival team\'s strategy, a value player to target later).',
			inputSchema: z.object({
				note: z.string().describe('Your observation (max 300 characters)'),
				tags: z
					.array(z.string())
					.optional()
					.describe('Optional tags for categorizing the note (e.g. ["rb-run", "value"])'),
			}),
			execute: async ({ note, tags }): Promise<{ status: 'ok'; noteCount: number }> => {
				const key = `team-${deps.teamIndex}`;
				const existing = await deps.kv.get<ScoutingNote[]>(KV_SCOUTING_NOTES, key);
				const notes: ScoutingNote[] = existing.exists ? existing.data : [];

				const newNote: ScoutingNote = {
					id: `note-${deps.pickNumber}-${Date.now()}`,
					round: deps.round,
					pickNumber: deps.pickNumber,
					text: note.slice(0, MAX_NOTE_LENGTH),
					tags: tags ?? [],
					timestamp: Date.now(),
					type: 'general',
				};

				notes.push(newNote);

				// FIFO truncation: keep only the most recent notes
				const trimmed = notes.length > MAX_NOTES_PER_TEAM
					? notes.slice(notes.length - MAX_NOTES_PER_TEAM)
					: notes;

				await deps.kv.set(KV_SCOUTING_NOTES, key, trimmed, { ttl: null });

				return { status: 'ok', noteCount: trimmed.length };
			},
		}),
	};
}
