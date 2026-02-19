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
import { finalizeAndRecordPick, buildFallbackReasoning } from '../../lib/pick-engine';
import {
	type Player,
	type Roster,
	type BoardState,
	type DraftSettings,
	PickSchema,
	BoardStateSchema,
	canDraftPosition,
	KV_DRAFT_STATE,
	KV_TEAM_ROSTERS,
	KV_AGENT_STRATEGIES,
	KV_PICK_REASONING,
	KV_SCOUTING_NOTES,
	KEY_BOARD_STATE,
	KEY_AVAILABLE_PLAYERS,
	KEY_SETTINGS,
	NUM_TEAMS,
	NUM_ROUNDS,
	TOTAL_PICKS,
	TEAM_NAMES,
	DRAFT_KV_TTL,
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
	action: s.enum(['start', 'advance']).describe('The action to perform'),
	humanTeamIndex: s.optional(s.number()).describe('Which team the human controls (0-7), used with start action'),
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

			// Clean up stale data from previous drafts
			try {
				await Promise.all([
					ctx.kv.deleteNamespace(KV_PICK_REASONING),
					ctx.kv.deleteNamespace(KV_SCOUTING_NOTES),
					ctx.kv.delete(KV_AGENT_STRATEGIES, 'strategy-shifts'),
				]);
				ctx.logger.info('Cleaned up stale data from previous drafts');
			} catch (err) {
				ctx.logger.warn('Failed to clean up stale data, continuing with draft start', { error: String(err) });
			}

			// Initialize all team rosters, persona assignments, board state, and settings in parallel
			await Promise.all([
				...Array.from({ length: NUM_TEAMS }, (_, i) =>
					ctx.kv.set(KV_TEAM_ROSTERS, `team-${i}`, createEmptyRoster(i), { ttl: DRAFT_KV_TTL }),
				),
				ctx.kv.set(KV_AGENT_STRATEGIES, KV_PERSONA_ASSIGNMENTS, personaAssignments, { ttl: DRAFT_KV_TTL }),
				ctx.kv.set(KV_DRAFT_STATE, KEY_BOARD_STATE, boardState, { ttl: DRAFT_KV_TTL }),
				ctx.kv.set(KV_DRAFT_STATE, KEY_SETTINGS, settings, { ttl: DRAFT_KV_TTL }),
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
					message: `It is the human player's turn (${TEAM_NAMES[currentPick.teamIndex]}, pick #${currentPick.pickNumber}). Use POST /draft/pick instead.`,
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
					reasoning: buildFallbackReasoning(fb, '(agent error)'),
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
			await finalizeAndRecordPick(ctx.kv, {
				pickNumber: currentPick.pickNumber,
				teamIndex: currentPick.teamIndex,
				personaName,
				player: pickedPlayer,
				reasoning: drafterResult.reasoning,
				toolsUsed: drafterResult.toolsUsed,
				confidence: drafterResult.confidence,
			});

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

		// Unknown action fallback
		return {
			success: false,
			message: `Unknown action: ${action}. Valid actions are: start, advance.`,
			boardState: createInitialBoardState(0),
			draftComplete: false,
		};
	},
});

export default agent;
