/**
 * Shared drafter logic extracted from drafter-balanced.
 * All drafter agents use the createDrafterHandler() factory to get a handler function,
 * then call createAgent() directly at the file level (required for build tool detection).
 */
import { s } from '@agentuity/schema';
import { generateObject } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import {
	type Player,
	type PlayerMetadata,
	type Pick,
	type Position,
	type Roster,
	type RosterSlot,
	PlayerSchema,
	PickSchema,
	PositionSchema,
	RosterSchema,
	VECTOR_PLAYERS,
	POSITIONS,
	getAvailableSlots,
	canDraftPosition,
} from './types';

// ---------------------------------------------------------------------------
// Schemas (shared by all drafter agents)
// ---------------------------------------------------------------------------

export const DrafterInputSchema = s.object({
	teamIndex: s.number().describe('Team index (0-11)'),
	teamName: s.string().describe('Team display name'),
	roster: RosterSchema.describe('Current team roster'),
	availablePlayers: s.array(PlayerSchema).describe('Players still available'),
	round: s.number().describe('Current draft round'),
	pickNumber: s.number().describe('Overall pick number'),
	allPicks: s.array(PickSchema).describe('All picks made so far'),
	boardAnalysis: s.optional(s.string()).describe('Board analysis summary from Phase 2 analysis'),
});

export const DrafterOutputSchema = s.object({
	playerId: s.string().describe('Selected player ID'),
	playerName: s.string().describe('Selected player name'),
	position: PositionSchema.describe('Selected player position'),
	reasoning: s.string().describe('Why this player was selected'),
	confidence: s.number().describe('Confidence score 0-1'),
});

// Inferred types for convenience
export type DrafterInput = s.infer<typeof DrafterInputSchema>;
export type DrafterOutput = s.infer<typeof DrafterOutputSchema>;

// ---------------------------------------------------------------------------
// buildUserPrompt - assembles all context the LLM needs
// ---------------------------------------------------------------------------

export function buildUserPrompt(
	teamName: string,
	roster: Roster,
	availableSlots: RosterSlot[],
	candidatePlayers: Player[],
	allPicks: Pick[],
	round: number,
	pickNumber: number,
	boardAnalysis?: string,
): string {
	// Format current roster
	const rosterLines: string[] = [];
	if (roster.qb) rosterLines.push(`  QB: ${roster.qb.name} (${roster.qb.team})`);
	if (roster.rb) rosterLines.push(`  RB: ${roster.rb.name} (${roster.rb.team})`);
	if (roster.wr) rosterLines.push(`  WR: ${roster.wr.name} (${roster.wr.team})`);
	if (roster.te) rosterLines.push(`  TE: ${roster.te.name} (${roster.te.team})`);
	if (roster.superflex) rosterLines.push(`  SUPERFLEX: ${roster.superflex.name} (${roster.superflex.team})`);
	const rosterDisplay = rosterLines.length > 0 ? rosterLines.join('\n') : '  (empty)';

	// Format available slots, noting that SUPERFLEX accepts any position
	const slotsDisplay = availableSlots
		.map((slot) => (slot === 'SUPERFLEX' ? 'SUPERFLEX (QB/RB/WR/TE)' : slot))
		.join(', ');

	// Format candidate players
	const candidateLines = candidatePlayers.map((p) => {
		const value = pickNumber - p.adp;
		const valueLabel = value > 0 ? `+${value} value` : `${value} value`;
		return `  - ID: ${p.playerId} | ${p.name} | ${p.position} | ${p.team} | ADP: ${p.adp} | Tier: ${p.tier} | Age: ${p.age} | Bye: ${p.byeWeek} | ${valueLabel}`;
	});

	// Format recent picks (last 12, roughly the last round)
	const recentPicks = allPicks.slice(-12);
	const recentPickLines = recentPicks.map(
		(p) => `  Pick ${p.pickNumber} (Team ${p.teamIndex + 1}): ${p.playerName} (${p.position})`,
	);
	const recentPicksDisplay = recentPickLines.length > 0 ? recentPickLines.join('\n') : '  (none yet)';

	// Build the board analysis section if provided
	const boardAnalysisSection = boardAnalysis
		? `\n${boardAnalysis}\n`
		: '';

	return `Team: ${teamName}
Round: ${round}, Overall Pick: ${pickNumber}

Current Roster:
${rosterDisplay}

Open Slots: ${slotsDisplay}

Candidate Players (pick ONE from this list):
${candidateLines.join('\n')}

Recent Picks by Other Teams:
${recentPicksDisplay}
${boardAnalysisSection}
Select the best available player for ${teamName}. You MUST pick a player whose position fits one of the open slots. Return your choice as JSON with fields: playerId, playerName, position, reasoning, confidence.`;
}

// ---------------------------------------------------------------------------
// buildCandidates - vector search + ADP merge + dedup
// ---------------------------------------------------------------------------

/**
 * Build the candidate player list by combining vector search results with
 * top available players by ADP, filtered to positions that fit the roster.
 *
 * @param ctx - Agent context (used for vector search)
 * @param availablePlayers - All players still on the board
 * @param roster - Current team roster (for slot eligibility)
 * @param neededPositions - Positions that can fill an open roster slot
 * @returns Deduplicated, ADP-sorted list of up to 25 candidates
 */
export async function buildCandidates(
	ctx: { vector: { search: <T extends Record<string, unknown>>(namespace: string, options: { query: string; limit: number }) => Promise<{ key: string; metadata?: T; similarity: number }[]> }; logger: { info: (msg: string, data?: Record<string, unknown>) => void; warn: (msg: string, data?: Record<string, unknown>) => void } },
	availablePlayers: Player[],
	roster: Roster,
	neededPositions: Position[],
): Promise<Player[]> {
	// Query Vector storage for semantic search
	const searchQuery = `best available ${neededPositions.join(' or ')} football player for fantasy draft`;
	ctx.logger.info('Searching vector storage', { query: searchQuery });

	let vectorResults: { key: string; metadata?: PlayerMetadata; similarity: number }[] = [];
	try {
		vectorResults = await ctx.vector.search<PlayerMetadata>(VECTOR_PLAYERS, {
			query: searchQuery,
			limit: 20,
		});
		ctx.logger.info('Vector search returned results', { count: vectorResults.length });
	} catch (err) {
		ctx.logger.warn('Vector search failed, falling back to available players list', {
			error: String(err),
		});
	}

	// Build a set of available player IDs for fast lookup
	const availableSet = new Set(availablePlayers.map((p) => p.playerId));

	// Collect candidates from vector results that are still available AND fit a roster slot
	const candidateIds = new Set<string>();
	for (const result of vectorResults) {
		const playerId = result.metadata?.playerId;
		if (playerId && availableSet.has(playerId)) {
			const player = availablePlayers.find((p) => p.playerId === playerId);
			if (player && canDraftPosition(roster, player.position)) {
				candidateIds.add(playerId);
			}
		}
	}

	// Also add top available players by ADP that fit roster needs (in case vector missed them)
	const topAvailable = [...availablePlayers]
		.filter((p) => canDraftPosition(roster, p.position))
		.sort((a, b) => a.adp - b.adp)
		.slice(0, 15);

	for (const player of topAvailable) {
		candidateIds.add(player.playerId);
	}

	// Build final candidate list, sorted by ADP, capped at 25
	const candidates = availablePlayers
		.filter((p) => candidateIds.has(p.playerId))
		.sort((a, b) => a.adp - b.adp)
		.slice(0, 25);

	ctx.logger.info('Candidate players for LLM', { count: candidates.length });
	return candidates;
}

// ---------------------------------------------------------------------------
// fallbackPick - deterministic safety net
// ---------------------------------------------------------------------------

/**
 * Fallback: pick the highest-ranked available player that fits an open roster slot.
 * Sorted by ADP ascending (lower ADP = better player).
 */
export function fallbackPick(availablePlayers: Player[], roster: Roster): Player | null {
	const sorted = [...availablePlayers].sort((a, b) => a.adp - b.adp);
	for (const player of sorted) {
		if (canDraftPosition(roster, player.position)) {
			return player;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// createDrafterHandler - handler factory for drafter agents
// ---------------------------------------------------------------------------

/**
 * Create a handler function for a drafter agent with a specific persona, system prompt, and model.
 * All drafters share the same candidate building, validation, and fallback logic.
 * They differ only in their system prompt and model choice.
 *
 * Each agent file calls createAgent() directly at the top level (required for build tool
 * detection) and passes this handler to it.
 */
export function createDrafterHandler(config: {
	name: string;
	systemPrompt: string;
	model: LanguageModel;
}) {
	return async (ctx: { vector: { search: <T extends Record<string, unknown>>(namespace: string, options: { query: string; limit: number }) => Promise<{ key: string; metadata?: T; similarity: number }[]> }; logger: { info: (msg: string, data?: Record<string, unknown>) => void; warn: (msg: string, data?: Record<string, unknown>) => void; error: (msg: string, data?: Record<string, unknown>) => void } }, input: DrafterInput): Promise<DrafterOutput> => {
		const { teamName, roster, availablePlayers, round, pickNumber, allPicks, boardAnalysis } = input;

		ctx.logger.info(`${config.name} on the clock`, {
			teamName,
			round,
			pickNumber,
			availableCount: availablePlayers.length,
			hasBoardAnalysis: !!boardAnalysis,
		});

		// 1. Determine available roster slots
		const availableSlots = getAvailableSlots(roster);
		ctx.logger.info('Available roster slots', { slots: availableSlots });

		if (availableSlots.length === 0) {
			ctx.logger.error('No available roster slots, roster is full');
			const best = availablePlayers[0];
			if (!best) {
				throw new Error('No available players and no roster slots');
			}
			return {
				playerId: best.playerId,
				playerName: best.name,
				position: best.position,
				reasoning: 'Roster is full, picking best available as fallback.',
				confidence: 0.1,
			};
		}

		// 2. Determine which positions can fill our open slots
		const neededPositions: Position[] = [];
		for (const slot of availableSlots) {
			if (slot === 'SUPERFLEX') {
				for (const pos of POSITIONS) {
					if (!neededPositions.includes(pos)) {
						neededPositions.push(pos);
					}
				}
			} else {
				if (!neededPositions.includes(slot as Position)) {
					neededPositions.push(slot as Position);
				}
			}
		}

		// 3. Build candidate list via vector search + ADP merge
		const candidatePlayers = await buildCandidates(ctx, availablePlayers, roster, neededPositions);

		if (candidatePlayers.length === 0) {
			ctx.logger.warn('No candidate players found, using fallback');
			const fb = fallbackPick(availablePlayers, roster);
			if (!fb) {
				throw new Error('No available players fit any open roster slot');
			}
			return {
				playerId: fb.playerId,
				playerName: fb.name,
				position: fb.position,
				reasoning: 'No candidates from vector search; picked highest-ranked available player by ADP.',
				confidence: 0.3,
			};
		}

		// 4. Build the prompt (includes board analysis if provided)
		const userPrompt = buildUserPrompt(
			teamName,
			roster,
			availableSlots,
			candidatePlayers,
			allPicks,
			round,
			pickNumber,
			boardAnalysis,
		);

		// 5. Augment system prompt with board analysis context if available
		let systemPrompt = config.systemPrompt;
		if (boardAnalysis) {
			systemPrompt += `\n\nIMPORTANT - Board dynamics detected. Factor the board analysis into your decision. You may shift your strategy if the situation calls for it. If you do shift strategy, explain why in your reasoning.`;
		}

		// 6. Call the LLM via Vercel AI SDK
		ctx.logger.info('Calling LLM for pick decision', { model: config.name });

		let llmPick: {
			playerId: string;
			playerName: string;
			position: Position;
			reasoning: string;
			confidence: number;
		} | null = null;

		try {
			const result = await generateObject({
				model: config.model,
				system: systemPrompt,
				prompt: userPrompt,
				schema: z.object({
					playerId: z.string(),
					playerName: z.string(),
					position: z.enum(['QB', 'RB', 'WR', 'TE']),
					reasoning: z.string(),
					confidence: z.number(),
				}),
			});

			llmPick = {
				playerId: result.object.playerId,
				playerName: result.object.playerName,
				position: result.object.position as Position,
				reasoning: result.object.reasoning,
				confidence: result.object.confidence,
			};
		} catch (err) {
			ctx.logger.error('LLM call failed', { error: String(err) });
		}

		// 7. Validate the LLM's pick
		const availableSet = new Set(availablePlayers.map((p) => p.playerId));

		if (llmPick) {
			const isAvailable = availableSet.has(llmPick.playerId);
			const player = availablePlayers.find((p) => p.playerId === llmPick!.playerId);
			const fitsRoster = player ? canDraftPosition(roster, player.position) : false;

			if (isAvailable && fitsRoster) {
				ctx.logger.info('LLM pick validated', {
					player: llmPick.playerName,
					position: llmPick.position,
					confidence: llmPick.confidence,
				});

				// Detect strategy shift: if board analysis was provided and the reasoning
				// mentions adapting or shifting, log it
				if (boardAnalysis && llmPick.reasoning) {
					const shiftKeywords = ['shift', 'adapt', 'pivot', 'change', 'adjust', 'deviate', 'instead'];
					const hasShift = shiftKeywords.some((kw) =>
						llmPick!.reasoning.toLowerCase().includes(kw),
					);
					if (hasShift) {
						ctx.logger.info('Strategy shift detected in reasoning', {
							agent: config.name,
							reasoning: llmPick.reasoning,
						});
					}
				}

				return {
					playerId: llmPick.playerId,
					playerName: llmPick.playerName,
					position: llmPick.position,
					reasoning: llmPick.reasoning,
					confidence: Math.max(0, Math.min(1, llmPick.confidence)),
				};
			}

			ctx.logger.warn('LLM picked unavailable or ineligible player, using fallback', {
				llmPlayerId: llmPick.playerId,
				llmPlayerName: llmPick.playerName,
				isAvailable,
				fitsRoster,
			});
		}

		// 8. Fallback: highest-ranked available player that fits
		const fb = fallbackPick(availablePlayers, roster);
		if (!fb) {
			throw new Error('No available players fit any open roster slot');
		}

		ctx.logger.info('Using fallback pick', {
			player: fb.name,
			position: fb.position,
			adp: fb.adp,
		});

		return {
			playerId: fb.playerId,
			playerName: fb.name,
			position: fb.position,
			reasoning: `Fallback pick: ${fb.name} is the highest-ranked available player (ADP ${fb.adp}) that fits an open roster slot.`,
			confidence: 0.5,
		};
	};
}
