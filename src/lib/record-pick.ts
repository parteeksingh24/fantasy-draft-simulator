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
	type ScoutingNote,
	type StrategyShift,
	canDraftPosition,
	assignRosterSlot,
	getSnakeDraftPick,
	KV_DRAFT_STATE,
	KV_TEAM_ROSTERS,
	KV_AGENT_STRATEGIES,
	KV_SCOUTING_NOTES,
	KEY_BOARD_STATE,
	KEY_AVAILABLE_PLAYERS,
	TOTAL_PICKS,
	TEAM_NAMES,
	MAX_NOTE_LENGTH,
	MAX_NOTES_PER_TEAM,
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
	strategyShift?: {
		pickNumber: number;
		teamIndex: number;
		persona: string;
		trigger: string;
		reasoning: string;
		playerPicked: string;
		position: StrategyShift['position'];
		category: StrategyShift['category'];
		severity: StrategyShift['severity'];
	};
}

interface KVAdapter {
	get: <T = unknown>(namespace: string, key: string) => Promise<{ exists: boolean; data: T }>;
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
	const expectedPick = boardState.currentPick;

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

	// Optimistic concurrency check: verify board + availability against latest KV state.
	const [latestBoardResult, latestPlayersResult] = await Promise.all([
		kv.get<BoardState>(KV_DRAFT_STATE, KEY_BOARD_STATE),
		kv.get<Player[]>(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS),
	]);

	if (!latestBoardResult.exists) {
		return {
			success: false,
			message: 'No draft in progress. Board state was not found.',
			boardState,
			roster,
			availablePlayers,
			draftComplete: boardState.draftComplete,
		};
	}

	const latestBoardState = latestBoardResult.data;
	if (latestBoardState.draftComplete) {
		return {
			success: false,
			message: 'Draft is already complete.',
			boardState: latestBoardState,
			roster,
			availablePlayers: latestPlayersResult.exists ? latestPlayersResult.data : availablePlayers,
			draftComplete: true,
		};
	}

	const latestCurrentPick = latestBoardState.currentPick;
	const pickMismatch = (
		latestCurrentPick.pickNumber !== expectedPick.pickNumber
		|| latestCurrentPick.teamIndex !== expectedPick.teamIndex
	);
	if (pickMismatch) {
		return {
			success: false,
			message: `Pick conflict: expected pick #${expectedPick.pickNumber} (${TEAM_NAMES[expectedPick.teamIndex]}), but board is at pick #${latestCurrentPick.pickNumber} (${TEAM_NAMES[latestCurrentPick.teamIndex]}). Refresh and retry.`,
			boardState: latestBoardState,
			roster,
			availablePlayers: latestPlayersResult.exists ? latestPlayersResult.data : availablePlayers,
			draftComplete: latestBoardState.draftComplete,
		};
	}

	if (!latestPlayersResult.exists) {
		return {
			success: false,
			message: 'No available players found in draft state. Refresh and retry.',
			boardState: latestBoardState,
			roster,
			availablePlayers,
			draftComplete: latestBoardState.draftComplete,
		};
	}

	const latestAvailablePlayers = latestPlayersResult.data;
	const latestPickedPlayer = latestAvailablePlayers.find((p) => p.playerId === pickedPlayer.playerId);
	if (!latestPickedPlayer) {
		return {
			success: false,
			message: `Player ${pickedPlayer.name} (${pickedPlayer.playerId}) is no longer available. Refresh and retry.`,
			boardState: latestBoardState,
			roster,
			availablePlayers: latestAvailablePlayers,
			draftComplete: latestBoardState.draftComplete,
		};
	}

	// Re-check with the latest player view in case stale input had outdated position data.
	if (!canDraftPosition(roster, latestPickedPlayer.position)) {
		return {
			success: false,
			message: `Cannot draft ${latestPickedPlayer.name} (${latestPickedPlayer.position}) - no available roster slot.`,
			boardState: latestBoardState,
			roster,
			availablePlayers: latestAvailablePlayers,
			draftComplete: latestBoardState.draftComplete,
		};
	}

	const currentPick = latestCurrentPick;
	const settings = latestBoardState.settings;

	// Record the pick
	const pick: Pick = {
		pickNumber: currentPick.pickNumber,
		round: currentPick.round,
		teamIndex: currentPick.teamIndex,
		playerId: latestPickedPlayer.playerId,
		playerName: latestPickedPlayer.name,
		position: latestPickedPlayer.position,
		reasoning,
		confidence,
	};

	// Detect behavior-based strategy shifts
	let detectedShift: RecordPickResult['strategyShift'] | undefined;
	if (personaName && boardAnalysis) {
		const shiftDetection = detectPersonaShift(personaName, pick, boardAnalysis, latestAvailablePlayers);

		if (shiftDetection) {
			const strategyShift: StrategyShift = {
				pickNumber: currentPick.pickNumber,
				teamIndex: currentPick.teamIndex,
				persona: personaName,
				trigger: shiftDetection.trigger,
				reasoning,
				playerPicked: latestPickedPlayer.name,
				position: latestPickedPlayer.position,
				category: shiftDetection.category,
				severity: shiftDetection.severity,
			};

			detectedShift = strategyShift;

			// Read existing shifts and scouting notes in parallel
			const [existingShifts, existingNotes] = await Promise.all([
				kv.get<StrategyShift[]>(KV_AGENT_STRATEGIES, 'strategy-shifts'),
				kv.get<ScoutingNote[]>(KV_SCOUTING_NOTES, `team-${currentPick.teamIndex}`),
			]);

			const allShifts = existingShifts.exists ? [...existingShifts.data, strategyShift] : [strategyShift];

			const shiftNote: ScoutingNote = {
				id: `shift-note-${currentPick.pickNumber}-${Date.now()}`,
				round: currentPick.round,
				pickNumber: currentPick.pickNumber,
				text: `Pick #${currentPick.pickNumber}: ${strategyShift.category} (${strategyShift.severity}) - ${strategyShift.trigger}`.slice(0, MAX_NOTE_LENGTH),
				tags: ['shift', `category:${strategyShift.category}`, `severity:${strategyShift.severity}`],
				timestamp: Date.now(),
				type: 'shift',
			};

			const notes = existingNotes.exists ? existingNotes.data : [];
			const nextNotes = [...notes, shiftNote];
			const trimmedNotes = nextNotes.length > MAX_NOTES_PER_TEAM
				? nextNotes.slice(nextNotes.length - MAX_NOTES_PER_TEAM)
				: nextNotes;

			// Write per-pick key, cumulative array, and scouting note in one batch
			await Promise.all([
				kv.set(KV_AGENT_STRATEGIES, `shift-${currentPick.pickNumber}`, strategyShift, { ttl: null }),
				kv.set(KV_AGENT_STRATEGIES, 'strategy-shifts', allShifts, { ttl: null }),
				kv.set(KV_SCOUTING_NOTES, `team-${currentPick.teamIndex}`, trimmedNotes, { ttl: null }),
			]);
		}
	}

	// Update roster
	const updatedRoster: Roster = { ...roster };
	const slot = assignRosterSlot(updatedRoster, latestPickedPlayer.position);
	if (slot) {
		const slotKey = slot === 'SUPERFLEX' ? 'superflex' : slot.toLowerCase() as 'qb' | 'rb' | 'wr' | 'te';
		(updatedRoster as Record<string, unknown>)[slotKey] = latestPickedPlayer;
	}

	// Remove player from available list
	const updatedAvailable = latestAvailablePlayers.filter((p) => p.playerId !== latestPickedPlayer.playerId);

	// Update board state
	const updatedBoardState: BoardState = {
		...latestBoardState,
		picks: [...latestBoardState.picks, pick],
		currentPick: latestCurrentPick,
	};

	const isLastPick = currentPick.pickNumber >= TOTAL_PICKS;
	if (isLastPick) {
		updatedBoardState.draftComplete = true;
		updatedBoardState.currentPick = currentPick;
	} else {
		updatedBoardState.currentPick = advanceCurrentPick(currentPick.pickNumber, settings);
	}

	// Write all updated state to KV in parallel
	await Promise.all([
		kv.set(KV_TEAM_ROSTERS, `team-${currentPick.teamIndex}`, updatedRoster, { ttl: null }),
		kv.set(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS, updatedAvailable, { ttl: null }),
		kv.set(KV_DRAFT_STATE, KEY_BOARD_STATE, updatedBoardState, { ttl: null }),
	]);

	return {
		success: true,
		message: `${TEAM_NAMES[currentPick.teamIndex]} selects ${latestPickedPlayer.name} (${latestPickedPlayer.position}) with pick #${currentPick.pickNumber}.`,
		pick,
		boardState: updatedBoardState,
		roster: updatedRoster,
		availablePlayers: updatedAvailable,
		draftComplete: updatedBoardState.draftComplete,
		strategyShift: detectedShift,
	};
}
