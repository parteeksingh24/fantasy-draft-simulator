/**
 * Shared pick-recording logic used by both the commissioner agent
 * and the SSE streaming endpoint.
 *
 * Validates a pick, updates roster, removes player from available list,
 * advances the board state, and writes everything to KV.
 */
import {
	type Player,
	type Roster,
	type BoardState,
	type DraftSettings,
	type Pick,
	type CurrentPick,
	canDraftPosition,
	assignRosterSlot,
	getSnakeDraftPick,
	KV_DRAFT_STATE,
	KV_TEAM_ROSTERS,
	KV_AGENT_STRATEGIES,
	KEY_BOARD_STATE,
	KEY_AVAILABLE_PLAYERS,
	TOTAL_PICKS,
	TEAM_NAMES,
} from './types';
import { detectPersonaShift, type BoardAnalysis } from './board-analysis';

export interface RecordPickInput {
	boardState: BoardState;
	roster: Roster;
	availablePlayers: Player[];
	pickedPlayer: Player;
	reasoning: string;
	confidence: number;
	personaName?: string;
	boardAnalysis?: BoardAnalysis;
}

export interface RecordPickResult {
	success: boolean;
	message: string;
	pick?: Pick;
	boardState: BoardState;
	roster: Roster;
	availablePlayers: Player[];
	draftComplete: boolean;
}

interface KVAdapter {
	set: (namespace: string, key: string, value: unknown, options?: { ttl: null }) => Promise<void>;
}

function advanceCurrentPick(currentPickNumber: number, settings: DraftSettings): CurrentPick {
	const nextPickNumber = currentPickNumber + 1;
	const { round, teamIndex } = getSnakeDraftPick(nextPickNumber);
	return {
		pickNumber: nextPickNumber,
		round,
		teamIndex,
		isHuman: teamIndex === settings.humanTeamIndex,
	};
}

/**
 * Record a pick: validate, update roster, remove from available, advance board, write to KV.
 */
export async function recordPick(
	kv: KVAdapter,
	input: RecordPickInput,
): Promise<RecordPickResult> {
	const { boardState, roster, availablePlayers, pickedPlayer, reasoning, confidence, personaName, boardAnalysis } = input;
	const { currentPick, settings } = boardState;

	// Validate position fits a roster slot
	if (!canDraftPosition(roster, pickedPlayer.position)) {
		return {
			success: false,
			message: `Cannot draft ${pickedPlayer.name} (${pickedPlayer.position}) - no available roster slot.`,
			boardState,
			roster,
			availablePlayers,
			draftComplete: boardState.draftComplete,
		};
	}

	// Record the pick
	const pick: Pick = {
		pickNumber: currentPick.pickNumber,
		round: currentPick.round,
		teamIndex: currentPick.teamIndex,
		playerId: pickedPlayer.playerId,
		playerName: pickedPlayer.name,
		position: pickedPlayer.position,
		reasoning,
		confidence,
	};

	// Detect behavior-based strategy shifts
	if (personaName && boardAnalysis) {
		const shiftTrigger = detectPersonaShift(personaName, pick, boardAnalysis, availablePlayers);

		if (shiftTrigger) {
			const strategyShift = {
				pickNumber: currentPick.pickNumber,
				teamIndex: currentPick.teamIndex,
				persona: personaName,
				trigger: shiftTrigger,
				reasoning,
				playerPicked: pickedPlayer.name,
				position: pickedPlayer.position,
			};

			await kv.set(KV_AGENT_STRATEGIES, `shift-${currentPick.pickNumber}`, strategyShift, { ttl: null });
		}
	}

	// Update roster
	const slot = assignRosterSlot(roster, pickedPlayer.position);
	if (slot) {
		const slotKey = slot === 'SUPERFLEX' ? 'superflex' : slot.toLowerCase() as 'qb' | 'rb' | 'wr' | 'te';
		(roster as Record<string, unknown>)[slotKey] = pickedPlayer;
	}

	// Remove player from available list
	const updatedAvailable = availablePlayers.filter((p) => p.playerId !== pickedPlayer.playerId);

	// Update board state
	boardState.picks.push(pick);

	const isLastPick = currentPick.pickNumber >= TOTAL_PICKS;
	if (isLastPick) {
		boardState.draftComplete = true;
		boardState.currentPick = currentPick;
	} else {
		boardState.currentPick = advanceCurrentPick(currentPick.pickNumber, settings);
	}

	// Write all updated state to KV in parallel
	await Promise.all([
		kv.set(KV_TEAM_ROSTERS, `team-${currentPick.teamIndex}`, roster, { ttl: null }),
		kv.set(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS, updatedAvailable, { ttl: null }),
		kv.set(KV_DRAFT_STATE, KEY_BOARD_STATE, boardState, { ttl: null }),
	]);

	return {
		success: true,
		message: `${TEAM_NAMES[currentPick.teamIndex]} selects ${pickedPlayer.name} (${pickedPlayer.position}) with pick #${currentPick.pickNumber}.`,
		pick,
		boardState,
		roster,
		availablePlayers: updatedAvailable,
		draftComplete: boardState.draftComplete,
	};
}
