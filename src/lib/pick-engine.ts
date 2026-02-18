/**
 * Shared pick validation and recording logic used by both
 * the commissioner agent path (generateText) and the SSE
 * streaming path (streamText).
 *
 * Centralises the duplicated id-match -> name-match -> roster-fit
 * validation, fallback reasoning text, and reasoning-summary KV write
 * so both paths stay in sync.
 */
import type { Player, Roster, ReasoningSummary } from './types';
import { KV_PICK_REASONING, canDraftPosition } from './types';
import { DRAFTER_MODEL_NAMES } from './drafter-models';

// ---------------------------------------------------------------------------
// validateStructuredPick
// ---------------------------------------------------------------------------

export interface ValidatedPick {
	player: Player;
	matchType: 'id' | 'name';
}

/**
 * Validate a structured LLM pick against the available player list and roster.
 *
 * Resolution order:
 *   1. Exact playerId match
 *   2. Case-insensitive playerName match
 *   3. Roster-fit check (position must fit an open slot)
 *
 * Returns the matched Player and how it was matched, or null if invalid.
 */
export function validateStructuredPick(
	pick: { playerId: string; playerName: string },
	availablePlayers: Player[],
	roster: Roster,
): ValidatedPick | null {
	const idMatch = availablePlayers.find((p) => p.playerId === pick.playerId);
	const nameMatch = idMatch
		? null
		: availablePlayers.find(
			(p) => p.name.toLowerCase() === pick.playerName.toLowerCase(),
		);
	const selectedPlayer = idMatch ?? nameMatch ?? null;

	if (!selectedPlayer) return null;

	const isAvailable = availablePlayers.some((p) => p.playerId === selectedPlayer.playerId);
	const fitsRoster = canDraftPosition(roster, selectedPlayer.position);

	if (!isAvailable || !fitsRoster) return null;

	return {
		player: selectedPlayer,
		matchType: idMatch ? 'id' : 'name',
	};
}

// ---------------------------------------------------------------------------
// buildFallbackReasoning
// ---------------------------------------------------------------------------

/**
 * Build consistent fallback reasoning text for a deterministic pick.
 * Used by both the commissioner path and the SSE streaming path so
 * the UI/debug output is identical regardless of which path ran.
 */
export function buildFallbackReasoning(
	player: Player,
	errorContext?: string,
): string {
	const suffix = errorContext ? ` ${errorContext}` : '';
	return `Fallback pick: ${player.name} is the highest-ranked available player (Rank ${player.rank}) that fits an open roster slot.${suffix}`;
}

// ---------------------------------------------------------------------------
// finalizeAndRecordPick
// ---------------------------------------------------------------------------

interface KVWriter {
	set: (namespace: string, key: string, value: unknown, options?: { ttl: null }) => Promise<void>;
}

export interface FinalizePickOpts {
	pickNumber: number;
	teamIndex: number;
	personaName: string;
	player: Player;
	reasoning: string;
	toolsUsed: string[];
	confidence: number;
	streamId?: string;
	streamUrl?: string;
}

/**
 * Write a ReasoningSummary to KV for the getDraftIntel tool.
 * Called after recordPick() succeeds, by both the commissioner
 * and the SSE streaming endpoint.
 */
export async function finalizeAndRecordPick(
	kv: KVWriter,
	opts: FinalizePickOpts,
): Promise<ReasoningSummary> {
	const reasoningSummary: ReasoningSummary = {
		pickNumber: opts.pickNumber,
		teamIndex: opts.teamIndex,
		persona: opts.personaName,
		model: DRAFTER_MODEL_NAMES[opts.personaName] ?? 'unknown',
		playerId: opts.player.playerId,
		playerName: opts.player.name,
		position: opts.player.position,
		summary: opts.reasoning.slice(0, 500),
		toolsUsed: opts.toolsUsed,
		confidence: opts.confidence,
		timestamp: Date.now(),
		...(opts.streamId ? { streamId: opts.streamId, streamUrl: opts.streamUrl } : {}),
	};

	await kv.set(KV_PICK_REASONING, `pick-${opts.pickNumber}`, reasoningSummary, { ttl: null });

	return reasoningSummary;
}
