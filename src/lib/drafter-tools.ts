/**
 * Shared tool factory for drafter agents.
 *
 * createDrafterTools(deps) returns 4 AI SDK tools that let drafter agents
 * actively research players via Vector search, inspect the board, and
 * examine other teams' rosters, rather than receiving a pre-built candidate list.
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { VectorStorage } from '@agentuity/core';
import type { KeyValueStorage } from '@agentuity/core';
import { analyzeBoardState } from './board-analysis';
import {
	type Player,
	type Pick,
	type Roster,
	type PlayerMetadata,
	VECTOR_PLAYERS,
	KV_TEAM_ROSTERS,
	canDraftPosition,
	getAvailableSlots,
} from './types';

// ---------------------------------------------------------------------------
// Dependencies interface
// ---------------------------------------------------------------------------

export interface DrafterToolsDeps {
	vector: VectorStorage;
	kv: KeyValueStorage;
	availablePlayers: Player[];
	roster: Roster;
	picks: Pick[];
	pickNumber: number;
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

interface SearchPlayersResult {
	status: 'ok' | 'vector_not_ready';
	query: string;
	position?: string;
	results: PlayerResult[];
	source: 'vector' | 'rank-fallback';
	message?: string;
}

// ---------------------------------------------------------------------------
// createDrafterTools
// ---------------------------------------------------------------------------

export function createDrafterTools(deps: DrafterToolsDeps) {
	// Build a Set for O(1) lookups of available player IDs
	const availableSet = new Set(deps.availablePlayers.map((p) => p.playerId));

	return {
		searchPlayers: tool({
			description:
				'Semantic search for players via Vector storage. Use this to find players matching a natural language query (e.g. "elite young wide receiver", "safe veteran quarterback"). Returns { status, results, source } and falls back to rank-based results if Vector is unavailable.',
			inputSchema: z.object({
				query: z.string().describe('Natural language search query'),
				position: z
					.enum(['QB', 'RB', 'WR', 'TE'])
					.optional()
					.describe('Filter results to a specific position'),
				limit: z
					.number()
					.optional()
					.default(10)
					.describe('Max results to return (default 10)'),
			}),
			execute: async ({ query, position, limit }): Promise<SearchPlayersResult> => {
				const normalizedLimit = limit ?? 10;
				const rankFallback = deps.availablePlayers
					.filter((p) => !position || p.position === position)
					.filter((p) => canDraftPosition(deps.roster, p.position))
					.sort((a, b) => a.rank - b.rank)
					.slice(0, normalizedLimit)
					.map((p) => ({
						playerId: p.playerId,
						name: p.name,
						position: p.position,
						team: p.team,
						rank: p.rank,
						tier: p.tier,
						age: p.age,
						value: deps.pickNumber - p.rank,
					}));

				try {
					const results = await deps.vector.search<PlayerMetadata>(VECTOR_PLAYERS, {
						query,
						limit: normalizedLimit,
					});

					const players: PlayerResult[] = [];

					for (const result of results) {
						if (!result.metadata) continue;
						const meta = result.metadata;

						// Only include players still on the board
						if (!availableSet.has(meta.playerId)) continue;

						// Optional position filter
						if (position && meta.position !== position) continue;

						// Check roster eligibility
						if (!canDraftPosition(deps.roster, meta.position)) continue;

						players.push({
							playerId: meta.playerId,
							name: meta.name,
							position: meta.position,
							team: meta.team,
							rank: meta.rank,
							tier: meta.tier,
							age: meta.age,
							value: deps.pickNumber - meta.rank,
						});
					}

					return {
						status: 'ok',
						query,
						...(position ? { position } : {}),
						results: players,
						source: 'vector',
					};
				} catch (err) {
					return {
						status: 'vector_not_ready',
						query,
						...(position ? { position } : {}),
						results: rankFallback,
						source: 'rank-fallback',
						message: `Vector search unavailable, using deterministic rank fallback: ${String(err)}`,
					};
				}
			},
		}),

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
	};
}
