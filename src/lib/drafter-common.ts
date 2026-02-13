/**
 * Shared drafter logic extracted from drafter-balanced.
 * All drafter agents use the createDrafterHandler() factory to get a handler function,
 * then call createAgent() directly at the file level (required for build tool detection).
 */
import { s } from '@agentuity/schema';
import { generateText, stepCountIs } from 'ai';
import type { LanguageModel } from 'ai';
import type { VectorStorage } from '@agentuity/core';
import type { KeyValueStorage } from '@agentuity/core';
import {
	type Player,
	type Pick,
	type Position,
	type Roster,
	type RosterSlot,
	PlayerSchema,
	PickSchema,
	PositionSchema,
	RosterSchema,
	POSITIONS,
	getAvailableSlots,
	canDraftPosition,
} from './types';
import { createDrafterTools } from './drafter-tools';

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
		const value = pickNumber - p.rank;
		const valueLabel = value > 0 ? `+${value} value` : `${value} value`;
		return `  - ID: ${p.playerId} | ${p.name} | ${p.position} | ${p.team} | Rank: ${p.rank} | Tier: ${p.tier} | Age: ${p.age} | Bye: ${p.byeWeek} | ${valueLabel}`;
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
// buildCandidates - filter by roster eligibility + rank sort
// ---------------------------------------------------------------------------

/**
 * Build the candidate player list by filtering to positions that fit the
 * roster and sorting by rank. No Vector search needed; rank-sorting
 * produces equivalent results with less latency.
 *
 * @param availablePlayers - All players still on the board
 * @param roster - Current team roster (for slot eligibility)
 * @returns Rank-sorted list of up to 25 candidates
 */
export function buildCandidates(
	availablePlayers: Player[],
	roster: Roster,
): Player[] {
	return [...availablePlayers]
		.filter((p) => canDraftPosition(roster, p.position))
		.sort((a, b) => a.rank - b.rank)
		.slice(0, 25);
}

// ---------------------------------------------------------------------------
// buildToolOrientedPrompt - shorter prompt for tool-calling LLM flow
// ---------------------------------------------------------------------------

/**
 * Build a prompt that instructs the LLM to use its tools to research players
 * before making a pick, rather than receiving a pre-built candidate list.
 * Used by both createDrafterHandler() and the SSE streaming endpoint.
 */
export function buildToolOrientedPrompt(
	teamName: string,
	roster: Roster,
	availableSlots: RosterSlot[],
	allPicks: Pick[],
	round: number,
	pickNumber: number,
	boardAnalysis?: string,
): string {
	// Format current roster
	const rosterLines: string[] = [];
	rosterLines.push(`  QB: ${roster.qb ? `${roster.qb.name} (${roster.qb.team})` : '(empty)'}`);
	rosterLines.push(`  RB: ${roster.rb ? `${roster.rb.name} (${roster.rb.team})` : '(empty)'}`);
	rosterLines.push(`  WR: ${roster.wr ? `${roster.wr.name} (${roster.wr.team})` : '(empty)'}`);
	rosterLines.push(`  TE: ${roster.te ? `${roster.te.name} (${roster.te.team})` : '(empty)'}`);
	rosterLines.push(`  SUPERFLEX: ${roster.superflex ? `${roster.superflex.name} (${roster.superflex.team})` : '(empty)'}`);

	// Format available slots, noting that SUPERFLEX accepts any position
	const slotsDisplay = availableSlots
		.map((slot) => (slot === 'SUPERFLEX' ? 'SUPERFLEX (QB/RB/WR/TE)' : slot))
		.join(', ');

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

	return `You're on the clock. Team: ${teamName}, Round ${round}, Pick #${pickNumber}.

Current Roster:
${rosterLines.join('\n')}

Open Slots: ${slotsDisplay}

Recent Picks by Other Teams:
${recentPicksDisplay}
${boardAnalysisSection}
Use your tools to research the best pick for your team. Call getTopAvailable to see who's on the board, searchPlayers to find specific player profiles, analyzeBoardTrends to check for runs or value drops, and getTeamRoster to see what other teams have.

After researching, make your selection as JSON:
{"playerId":"...","playerName":"...","position":"QB|RB|WR|TE","reasoning":"...","confidence":0.0-1.0}`;
}

// ---------------------------------------------------------------------------
// fallbackPick - deterministic safety net
// ---------------------------------------------------------------------------

/**
 * Fallback: pick the highest-ranked available player that fits an open roster slot.
 * Sorted by rank ascending (lower rank = better player).
 */
export function fallbackPick(availablePlayers: Player[], roster: Roster): Player | null {
	const sorted = [...availablePlayers].sort((a, b) => a.rank - b.rank);
	for (const player of sorted) {
		if (canDraftPosition(roster, player.position)) {
			return player;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// prepareDrafterContext - builds everything needed for an LLM call
// ---------------------------------------------------------------------------

/**
 * Prepare all context needed for a drafter LLM call without actually calling the LLM.
 * Returns the system prompt, user prompt, and candidate list.
 * Used by both createDrafterHandler() and the SSE streaming endpoint.
 */
export async function prepareDrafterContext(
	ctx: { logger: { info: (msg: string, data?: Record<string, unknown>) => void; warn: (msg: string, data?: Record<string, unknown>) => void; error: (msg: string, data?: Record<string, unknown>) => void } },
	input: DrafterInput,
	config: { name: string; systemPrompt: string },
): Promise<{
	systemPrompt: string;
	userPrompt: string;
	candidatePlayers: Player[];
	availableSlots: RosterSlot[];
	neededPositions: Position[];
} | { fallbackPlayer: Player } | { error: string }> {
	const { teamName, roster, availablePlayers, round, pickNumber, allPicks, boardAnalysis } = input;

	// 1. Determine available roster slots
	const availableSlots = getAvailableSlots(roster);

	if (availableSlots.length === 0) {
		ctx.logger.error('No available roster slots, roster is full');
		const best = availablePlayers[0];
		if (!best) {
			return { error: 'No available players and no roster slots' };
		}
		return { fallbackPlayer: best };
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

	// 3. Build candidate list by rank
	const candidatePlayers = buildCandidates(availablePlayers, roster);

	if (candidatePlayers.length === 0) {
		ctx.logger.warn('No candidate players found, using fallback');
		const fb = fallbackPick(availablePlayers, roster);
		if (!fb) {
			return { error: 'No available players fit any open roster slot' };
		}
		return { fallbackPlayer: fb };
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

	return { systemPrompt, userPrompt, candidatePlayers, availableSlots, neededPositions };
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
	return async (
		ctx: {
			logger: {
				info: (msg: string, data?: Record<string, unknown>) => void;
				warn: (msg: string, data?: Record<string, unknown>) => void;
				error: (msg: string, data?: Record<string, unknown>) => void;
			};
			kv: KeyValueStorage;
			vector: VectorStorage;
		},
		input: DrafterInput,
	): Promise<DrafterOutput> => {
		const { teamName, roster, availablePlayers, round, pickNumber, allPicks, boardAnalysis } = input;

		ctx.logger.info(`${config.name} on the clock`, {
			teamName,
			round,
			pickNumber,
			availableCount: availablePlayers.length,
			hasBoardAnalysis: !!boardAnalysis,
		});

		// Use prepareDrafterContext for initial checks (available slots, fallback cases)
		const prepared = await prepareDrafterContext(ctx, input, config);

		// Handle fallback/error cases
		if ('error' in prepared) {
			throw new Error(prepared.error);
		}

		if ('fallbackPlayer' in prepared) {
			const fb = prepared.fallbackPlayer;
			return {
				playerId: fb.playerId,
				playerName: fb.name,
				position: fb.position,
				reasoning: fb === availablePlayers[0]
					? 'Roster is full, picking best available as fallback.'
					: 'No eligible candidates found; picked highest-ranked available player by rank.',
				confidence: fb === availablePlayers[0] ? 0.1 : 0.3,
			};
		}

		const { systemPrompt, availableSlots } = prepared;

		// Build tools for the LLM to research players
		const tools = createDrafterTools({
			vector: ctx.vector,
			kv: ctx.kv,
			availablePlayers,
			roster,
			picks: allPicks,
			pickNumber,
		});

		// Build the tool-oriented prompt (no pre-built candidate list)
		const toolOrientedPrompt = buildToolOrientedPrompt(
			teamName,
			roster,
			availableSlots,
			allPicks,
			round,
			pickNumber,
			boardAnalysis,
		);

		// Call LLM with tools via generateText
		ctx.logger.info('Calling LLM with tools for pick decision', { model: config.name });

		let llmPick: {
			playerId: string;
			playerName: string;
			position: Position;
			reasoning: string;
			confidence: number;
		} | null = null;

		try {
			const result = await generateText({
				model: config.model,
				system: systemPrompt,
				prompt: toolOrientedPrompt + '\n\nRespond with your pick as JSON: {"playerId":"...","playerName":"...","position":"QB|RB|WR|TE","reasoning":"...","confidence":0.0-1.0}',
				tools,
				stopWhen: stepCountIs(4),
			});

			const jsonMatch = result.text.match(/\{[\s\S]*"playerId"[\s\S]*\}/);
			if (jsonMatch) {
				try {
					const parsed = JSON.parse(jsonMatch[0]);
					llmPick = {
						playerId: String(parsed.playerId),
						playerName: parsed.playerName,
						position: parsed.position,
						reasoning: parsed.reasoning,
						confidence: parsed.confidence,
					};
				} catch { /* parse failed */ }
			}
		} catch (err) {
			ctx.logger.error('LLM call failed', { error: String(err) });
		}

		// Validate the LLM's pick
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

		// Fallback: highest-ranked available player that fits
		const fb = fallbackPick(availablePlayers, roster);
		if (!fb) {
			throw new Error('No available players fit any open roster slot');
		}

		ctx.logger.info('Using fallback pick', {
			player: fb.name,
			position: fb.position,
			rank: fb.rank,
		});

		return {
			playerId: fb.playerId,
			playerName: fb.name,
			position: fb.position,
			reasoning: `Fallback pick: ${fb.name} is the highest-ranked available player (Rank ${fb.rank}) that fits an open roster slot.`,
			confidence: 0.5,
		};
	};
}
