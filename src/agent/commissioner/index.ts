import { createAgent } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import drafterBalanced from '../drafter-balanced';
import drafterBold from '../drafter-bold';
import drafterZeroRb from '../drafter-zero-rb';
import drafterQbFirst from '../drafter-qb-first';
import drafterStudRb from '../drafter-stud-rb';
import drafterValueHunter from '../drafter-value-hunter';
import drafterStackBuilder from '../drafter-stack-builder';
import drafterTePremium from '../drafter-te-premium';
import drafterYouthMovement from '../drafter-youth-movement';
import drafterContrarian from '../drafter-contrarian';
import drafterRiskAverse from '../drafter-risk-averse';
import drafterReactive from '../drafter-reactive';
import { assignPersonas, KV_PERSONA_ASSIGNMENTS, type PersonaAssignment } from '../../lib/persona-assignment';
import { analyzeBoardState } from '../../lib/board-analysis';
import { recordPick } from '../../lib/record-pick';
import { DRAFTER_MODEL_NAMES } from '../../lib/drafter-models';
import {
	type Player,
	type Roster,
	type BoardState,
	type DraftSettings,
	type Pick,
	type CurrentPick,
	type ReasoningSummary,
	PickSchema,
	BoardStateSchema,
	getSnakeDraftPick,
	canDraftPosition,
	assignRosterSlot,
	KV_DRAFT_STATE,
	KV_TEAM_ROSTERS,
	KV_AGENT_STRATEGIES,
	KV_PICK_REASONING,
	KEY_BOARD_STATE,
	KEY_AVAILABLE_PLAYERS,
	KEY_SETTINGS,
	NUM_TEAMS,
	NUM_ROUNDS,
	TOTAL_PICKS,
	TEAM_NAMES,
} from '../../lib/types';

// --- Drafter agent lookup map ---

const DRAFTER_AGENTS: Record<string, typeof drafterBalanced> = {
	'drafter-balanced': drafterBalanced,
	'drafter-bold': drafterBold,
	'drafter-zero-rb': drafterZeroRb,
	'drafter-qb-first': drafterQbFirst,
	'drafter-stud-rb': drafterStudRb,
	'drafter-value-hunter': drafterValueHunter,
	'drafter-stack-builder': drafterStackBuilder,
	'drafter-te-premium': drafterTePremium,
	'drafter-youth-movement': drafterYouthMovement,
	'drafter-contrarian': drafterContrarian,
	'drafter-risk-averse': drafterRiskAverse,
	'drafter-reactive': drafterReactive,
};

// --- Schemas ---

const CommissionerInputSchema = s.object({
	action: s.enum(['start', 'advance', 'pick']).describe('The action to perform'),
	humanTeamIndex: s.optional(s.number()).describe('Which team the human controls (0-11), used with start action'),
	playerId: s.optional(s.string()).describe('Player ID for the human pick, used with pick action'),
});

const CommissionerOutputSchema = s.object({
	success: s.boolean().describe('Whether the action succeeded'),
	message: s.string().describe('Description of what happened'),
	pick: s.optional(PickSchema).describe('The pick that was just made'),
	boardState: BoardStateSchema.describe('Current board state'),
	draftComplete: s.boolean().describe('Whether the draft is complete'),
});

// --- Helpers ---

function createEmptyRoster(teamIndex: number): Roster {
	return {
		teamIndex,
		teamName: TEAM_NAMES[teamIndex] ?? `Team ${teamIndex + 1}`,
	};
}

function createInitialBoardState(humanTeamIndex: number): BoardState {
	return {
		picks: [],
		currentPick: {
			pickNumber: 1,
			round: 1,
			teamIndex: 0,
			isHuman: humanTeamIndex === 0,
		},
		settings: {
			numTeams: NUM_TEAMS,
			numRounds: NUM_ROUNDS,
			humanTeamIndex,
		},
		draftComplete: false,
	};
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

// --- Agent ---

const agent = createAgent('commissioner', {
	description: 'Orchestrates the fantasy draft: manages pick order, validates picks, updates board state, routes picks to persona-specific drafter agents. Pure logic, no LLM calls.',
	schema: {
		input: CommissionerInputSchema,
		output: CommissionerOutputSchema,
	},
	handler: async (ctx, input) => {
		const { action } = input;

		// =====================
		// ACTION: start
		// =====================
		if (action === 'start') {
			const humanTeamIndex = input.humanTeamIndex ?? 0;

			if (humanTeamIndex < 0 || humanTeamIndex >= NUM_TEAMS) {
				const emptyBoard = createInitialBoardState(0);
				return {
					success: false,
					message: `Invalid humanTeamIndex: ${humanTeamIndex}. Must be 0-${NUM_TEAMS - 1}.`,
					boardState: emptyBoard,
					draftComplete: false,
				};
			}

			const boardState = createInitialBoardState(humanTeamIndex);
			const settings: DraftSettings = boardState.settings;

			// Assign personas to AI teams (weighted random, duplicates allowed)
			const personaAssignments = assignPersonas(NUM_TEAMS, humanTeamIndex);

			ctx.logger.info('Personas assigned', {
				assignments: personaAssignments.map((a) => `Team ${a.teamIndex}: ${a.persona}`),
			});

			// Initialize all 12 team rosters, persona assignments, board state, and settings in parallel
			await Promise.all([
				...Array.from({ length: NUM_TEAMS }, (_, i) =>
					ctx.kv.set(KV_TEAM_ROSTERS, `team-${i}`, createEmptyRoster(i), { ttl: null }),
				),
				ctx.kv.set(KV_AGENT_STRATEGIES, KV_PERSONA_ASSIGNMENTS, personaAssignments, { ttl: null }),
				ctx.kv.set(KV_DRAFT_STATE, KEY_BOARD_STATE, boardState, { ttl: null }),
				ctx.kv.set(KV_DRAFT_STATE, KEY_SETTINGS, settings, { ttl: null }),
			]);

			ctx.logger.info('Draft initialized', {
				numTeams: NUM_TEAMS,
				numRounds: NUM_ROUNDS,
				totalPicks: TOTAL_PICKS,
				humanTeamIndex,
				firstPick: boardState.currentPick,
			});

			return {
				success: true,
				message: `Draft started. ${NUM_TEAMS} teams, ${NUM_ROUNDS} rounds, ${TOTAL_PICKS} total picks. Human is ${TEAM_NAMES[humanTeamIndex]}. Personas assigned.`,
				boardState,
				draftComplete: false,
			};
		}

		// =====================
		// ACTION: advance (AI pick)
		// =====================
		if (action === 'advance') {
			// Read current board state
			const boardResult = await ctx.kv.get<BoardState>(KV_DRAFT_STATE, KEY_BOARD_STATE);
			if (!boardResult.exists) {
				return {
					success: false,
					message: 'No draft in progress. Use action "start" first.',
					boardState: createInitialBoardState(0),
					draftComplete: false,
				};
			}

			const boardState = boardResult.data;

			if (boardState.draftComplete) {
				return {
					success: false,
					message: 'Draft is already complete.',
					boardState,
					draftComplete: true,
				};
			}

			const { currentPick } = boardState;

			// Block if it's the human's turn
			if (currentPick.isHuman) {
				return {
					success: false,
					message: `It is the human player's turn (${TEAM_NAMES[currentPick.teamIndex]}, pick #${currentPick.pickNumber}). Use action "pick" instead.`,
					boardState,
					draftComplete: false,
				};
			}

			// Read persona assignments to determine which drafter to call
			const personaResult = await ctx.kv.get<PersonaAssignment[]>(KV_AGENT_STRATEGIES, KV_PERSONA_ASSIGNMENTS);
			const personaAssignments = personaResult.exists ? personaResult.data : [];
			const teamPersona = personaAssignments.find((a) => a.teamIndex === currentPick.teamIndex);
			const personaName = teamPersona?.persona ?? 'drafter-balanced';
			const drafterAgent = DRAFTER_AGENTS[personaName] ?? drafterBalanced;

			ctx.logger.info('Advancing draft - AI pick', {
				pickNumber: currentPick.pickNumber,
				round: currentPick.round,
				teamIndex: currentPick.teamIndex,
				teamName: TEAM_NAMES[currentPick.teamIndex],
				persona: personaName,
			});

			// Read team roster (lazily create if missing)
			const rosterResult = await ctx.kv.get<Roster>(KV_TEAM_ROSTERS, `team-${currentPick.teamIndex}`);
			const roster: Roster = rosterResult.exists
				? rosterResult.data
				: createEmptyRoster(currentPick.teamIndex);

			// Read available players
			const playersResult = await ctx.kv.get<Player[]>(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS);
			if (!playersResult.exists || playersResult.data.length === 0) {
				return {
					success: false,
					message: 'No available players found. Was the draft seeded?',
					boardState,
					draftComplete: false,
				};
			}
			const availablePlayers = playersResult.data;

			// Run board analysis before the pick
			const boardAnalysis = analyzeBoardState(
				boardState.picks,
				availablePlayers,
				currentPick.pickNumber,
			);

			ctx.logger.info('Board analysis', {
				positionRuns: boardAnalysis.positionRuns.length,
				valueDrops: boardAnalysis.valueDrops.length,
				scarcity: boardAnalysis.scarcity.length,
				summary: boardAnalysis.summary,
			});

			// Call the drafter agent with board analysis context
			const drafterInput = {
				teamIndex: currentPick.teamIndex,
				teamName: TEAM_NAMES[currentPick.teamIndex] ?? `Team ${currentPick.teamIndex + 1}`,
				roster,
				availablePlayers,
				round: currentPick.round,
				pickNumber: currentPick.pickNumber,
				allPicks: boardState.picks,
				boardAnalysis: boardAnalysis.summary,
			};

			ctx.logger.info('Calling drafter agent', {
				persona: personaName,
				teamIndex: currentPick.teamIndex,
				round: currentPick.round,
				pickNumber: currentPick.pickNumber,
				availableCount: availablePlayers.length,
			});

			let drafterResult: Awaited<ReturnType<typeof drafterAgent.run>>;
			try {
				drafterResult = await drafterAgent.run(drafterInput);
			} catch (err) {
				ctx.logger.error('Drafter agent call failed, using fallback pick', {
					persona: personaName,
					error: String(err),
				});

				// Fallback: pick best available by rank that fits roster
				const sorted = [...availablePlayers].sort((a, b) => a.rank - b.rank);
				const fb = sorted.find((p) => canDraftPosition(roster, p.position));
				if (!fb) {
					return {
						success: false,
						message: `Drafter (${personaName}) failed and no fallback player available.`,
						boardState,
						draftComplete: false,
					};
				}

				drafterResult = {
					playerId: fb.playerId,
					playerName: fb.name,
					position: fb.position,
					reasoning: `Fallback pick after agent error: ${fb.name} is the highest-ranked available player (Rank ${fb.rank}).`,
					confidence: 0.3,
					toolsUsed: [],
				};
			}

			// Validate the drafter's pick
			const pickedPlayer = availablePlayers.find((p) => p.playerId === drafterResult.playerId);
			if (!pickedPlayer) {
				ctx.logger.error('Drafter selected an unavailable player', {
					playerId: drafterResult.playerId,
					playerName: drafterResult.playerName,
					persona: personaName,
				});
				return {
					success: false,
					message: `Drafter (${personaName}) selected player ${drafterResult.playerName} (${drafterResult.playerId}) who is not available.`,
					boardState,
					draftComplete: false,
				};
			}

			if (!canDraftPosition(roster, pickedPlayer.position)) {
				ctx.logger.error('Drafter selected a position that cannot be rostered', {
					position: pickedPlayer.position,
					roster,
					persona: personaName,
				});
				return {
					success: false,
					message: `Cannot draft ${pickedPlayer.position} - no available roster slot for ${TEAM_NAMES[currentPick.teamIndex]}.`,
					boardState,
					draftComplete: false,
				};
			}

			const recordResult = await recordPick(ctx.kv, {
				boardState,
				roster,
				availablePlayers,
				pickedPlayer,
				reasoning: drafterResult.reasoning,
				confidence: drafterResult.confidence,
				personaName,
				boardAnalysis,
			});

			if (!recordResult.success || !recordResult.pick) {
				ctx.logger.warn('AI pick failed to record', {
					persona: personaName,
					pickNumber: currentPick.pickNumber,
					teamIndex: currentPick.teamIndex,
					message: recordResult.message,
				});
				return {
					success: false,
					message: recordResult.message,
					boardState: recordResult.boardState,
					draftComplete: recordResult.draftComplete,
				};
			}

			// Write reasoning summary to KV so getDraftIntel tool has data
			const reasoningSummary: ReasoningSummary = {
				pickNumber: currentPick.pickNumber,
				teamIndex: currentPick.teamIndex,
				persona: personaName,
				model: DRAFTER_MODEL_NAMES[personaName] ?? 'unknown',
				playerId: pickedPlayer.playerId,
				playerName: pickedPlayer.name,
				position: pickedPlayer.position,
				summary: drafterResult.reasoning.slice(0, 500),
				toolsUsed: drafterResult.toolsUsed,
				confidence: drafterResult.confidence,
				timestamp: Date.now(),
			};
			await ctx.kv.set(KV_PICK_REASONING, `pick-${currentPick.pickNumber}`, reasoningSummary, { ttl: null });

			ctx.logger.info('AI pick recorded', {
				pick: recordResult.pick.pickNumber,
				team: TEAM_NAMES[recordResult.pick.teamIndex],
				player: recordResult.pick.playerName,
				position: recordResult.pick.position,
				persona: personaName,
				strategyShift: !!recordResult.strategyShift,
				draftComplete: recordResult.draftComplete,
			});

			return {
				success: true,
				message: `${TEAM_NAMES[recordResult.pick.teamIndex]} (${personaName}) selects ${recordResult.pick.playerName} (${recordResult.pick.position}) with pick #${recordResult.pick.pickNumber}.`,
				pick: recordResult.pick,
				boardState: recordResult.boardState,
				draftComplete: recordResult.draftComplete,
			};
		}

		// =====================
		// ACTION: pick (Human pick)
		// =====================
		if (action === 'pick') {
			const { playerId } = input;

			if (!playerId) {
				return {
					success: false,
					message: 'playerId is required for the "pick" action.',
					boardState: createInitialBoardState(0),
					draftComplete: false,
				};
			}

			// Read current board state
			const boardResult = await ctx.kv.get<BoardState>(KV_DRAFT_STATE, KEY_BOARD_STATE);
			if (!boardResult.exists) {
				return {
					success: false,
					message: 'No draft in progress. Use action "start" first.',
					boardState: createInitialBoardState(0),
					draftComplete: false,
				};
			}

			const boardState = boardResult.data;

			if (boardState.draftComplete) {
				return {
					success: false,
					message: 'Draft is already complete.',
					boardState,
					draftComplete: true,
				};
			}

			const { currentPick, settings } = boardState;

			// Verify it's the human's turn
			if (!currentPick.isHuman) {
				return {
					success: false,
					message: `It is not the human's turn. ${TEAM_NAMES[currentPick.teamIndex]} (AI) is on the clock at pick #${currentPick.pickNumber}. Use action "advance" instead.`,
					boardState,
					draftComplete: false,
				};
			}

			ctx.logger.info('Human pick', {
				pickNumber: currentPick.pickNumber,
				round: currentPick.round,
				teamIndex: currentPick.teamIndex,
				playerId,
			});

			// Read available players
			const playersResult = await ctx.kv.get<Player[]>(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS);
			if (!playersResult.exists || playersResult.data.length === 0) {
				return {
					success: false,
					message: 'No available players found.',
					boardState,
					draftComplete: false,
				};
			}
			const availablePlayers = playersResult.data;

			// Find the player
			const pickedPlayer = availablePlayers.find((p) => p.playerId === playerId);
			if (!pickedPlayer) {
				return {
					success: false,
					message: `Player ${playerId} is not available. They may have already been drafted.`,
					boardState,
					draftComplete: false,
				};
			}

			// Read team roster (lazily create if missing)
			const rosterResult = await ctx.kv.get<Roster>(KV_TEAM_ROSTERS, `team-${currentPick.teamIndex}`);
			const roster: Roster = rosterResult.exists
				? rosterResult.data
				: createEmptyRoster(currentPick.teamIndex);

			// Validate position fits a roster slot
			if (!canDraftPosition(roster, pickedPlayer.position)) {
				return {
					success: false,
					message: `Cannot draft ${pickedPlayer.name} (${pickedPlayer.position}) - no available roster slot. Check your roster for open slots.`,
					boardState,
					draftComplete: false,
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
				reasoning: 'Human selection',
				confidence: 1.0,
			};

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
				ctx.kv.set(KV_TEAM_ROSTERS, `team-${currentPick.teamIndex}`, roster, { ttl: null }),
				ctx.kv.set(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS, updatedAvailable, { ttl: null }),
				ctx.kv.set(KV_DRAFT_STATE, KEY_BOARD_STATE, boardState, { ttl: null }),
			]);

			ctx.logger.info('Human pick recorded', {
				pick: pick.pickNumber,
				team: TEAM_NAMES[currentPick.teamIndex],
				player: pickedPlayer.name,
				position: pickedPlayer.position,
				slot,
				draftComplete: boardState.draftComplete,
			});

			return {
				success: true,
				message: `${TEAM_NAMES[currentPick.teamIndex]} selects ${pickedPlayer.name} (${pickedPlayer.position}) with pick #${currentPick.pickNumber}.`,
				pick,
				boardState,
				draftComplete: boardState.draftComplete,
			};
		}

		// Unknown action fallback
		return {
			success: false,
			message: `Unknown action: ${action}. Valid actions are: start, advance, pick.`,
			boardState: createInitialBoardState(0),
			draftComplete: false,
		};
	},
});

export default agent;
