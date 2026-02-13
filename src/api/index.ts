import { createRouter, sse } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import { Output, streamText, stepCountIs } from 'ai';
import commissioner from '../agent/commissioner';
import { seedPlayers } from '../lib/seed-players';
import { DrafterOutputZodSchema, buildToolOrientedPrompt, fallbackPick, parseDrafterOutputFromText } from '../lib/drafter-common';
import { getDrafterGenerationMode } from '../lib/drafter-capabilities';
import { createDrafterTools } from '../lib/drafter-tools';
import { DRAFTER_MODELS, DRAFTER_MODEL_NAMES, getDrafterPrompt } from '../lib/drafter-models';
import { recordPick } from '../lib/record-pick';
import { analyzeBoardState } from '../lib/board-analysis';
import type { PersonaAssignment } from '../lib/persona-assignment';
import {
	type BoardState,
	type Player,
	type Roster,
	type ReasoningSummary,
	type StrategyShift,
	type TeamShiftSummary,
	KV_DRAFT_STATE,
	KV_TEAM_ROSTERS,
	KV_AGENT_STRATEGIES,
	KV_PICK_REASONING,
	KEY_BOARD_STATE,
	KEY_AVAILABLE_PLAYERS,
	NUM_TEAMS,
	TEAM_NAMES,
	getAvailableSlots,
	canDraftPosition,
} from '../lib/types';

/**
 * Truncate large tool results for SSE transmission.
 * Arrays longer than 5 items are sliced with a count annotation.
 */
function summarizeToolResult(toolName: string, result: unknown): unknown {
	if (Array.isArray(result)) {
		if (result.length <= 5) return result;
		return { items: result.slice(0, 5), total: result.length, truncated: true };
	}
	return result;
}

function normalizeShift(shift: Partial<StrategyShift>): StrategyShift {
	return {
		pickNumber: shift.pickNumber ?? 0,
		teamIndex: shift.teamIndex ?? 0,
		persona: shift.persona ?? 'drafter-balanced',
		trigger: shift.trigger ?? 'Strategy shift detected.',
		reasoning: shift.reasoning ?? '',
		playerPicked: shift.playerPicked ?? 'Unknown',
		position: (shift.position ?? 'QB') as StrategyShift['position'],
		category: shift.category ?? 'positional-pivot',
		severity: shift.severity ?? 'minor',
	};
}

function buildTeamShiftSummary(shifts: StrategyShift[], picks: BoardState['picks']): TeamShiftSummary[] {
	return Array.from({ length: NUM_TEAMS }, (_, teamIndex) => {
		const teamShifts = shifts.filter((shift) => shift.teamIndex === teamIndex);
		const totalShifts = teamShifts.length;
		const majorShiftCount = teamShifts.filter((shift) => shift.severity === 'major').length;

		const categoryCounts = new Map<StrategyShift['category'], number>();
		for (const shift of teamShifts) {
			categoryCounts.set(shift.category, (categoryCounts.get(shift.category) ?? 0) + 1);
		}

		let topCategory: StrategyShift['category'] | null = null;
		let topCount = 0;
		for (const [category, count] of categoryCounts.entries()) {
			if (count > topCount || (count === topCount && topCategory !== null && category < topCategory)) {
				topCategory = category;
				topCount = count;
			} else if (topCategory === null) {
				topCategory = category;
				topCount = count;
			}
		}

		const last3TeamPickNumbers = picks
			.filter((pick) => pick.teamIndex === teamIndex)
			.slice(-3)
			.map((pick) => pick.pickNumber);
		const teamShiftPickNumbers = new Set(teamShifts.map((shift) => shift.pickNumber));
		const last3TeamPicksShiftCount = last3TeamPickNumbers
			.filter((pickNumber) => teamShiftPickNumbers.has(pickNumber))
			.length;

		return {
			teamIndex,
			totalShifts,
			last3TeamPicksShiftCount,
			majorShiftCount,
			topCategory,
		};
	});
}

const api = createRouter();

// In-flight seed promise to deduplicate concurrent seed calls
let seedPromise: Promise<Player[]> | null = null;

type SeedStatus = 'cached' | 'seeded' | 'joined_inflight';

async function ensureSeeded(kv: Parameters<typeof seedPlayers>[0], logger: { info: (msg: string, meta?: Record<string, unknown>) => void }): Promise<{ players: Player[]; status: SeedStatus }> {
	const existing = await kv.get<Player[]>(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS);
	if (existing.exists && existing.data.length > 0) {
		return { players: existing.data, status: 'cached' };
	}

	const startedHere = !seedPromise;

	// Deduplicate: if a seed is already in-flight, join it
	if (startedHere) {
		logger.info('Seeding player data');
		seedPromise = seedPlayers(kv).finally(() => { seedPromise = null; });
	}

	const inFlightSeed = seedPromise;
	if (!inFlightSeed) {
		throw new Error('Seed promise missing while seeding players');
	}
	const players = await inFlightSeed;
	return { players, status: startedHere ? 'seeded' : 'joined_inflight' };
}

// Health check
api.get('/health', (c) => c.json({ status: 'ok' }));

// POST /draft/seed - Seed player data into KV. Skips if already seeded.
api.post('/draft/seed', async (c) => {
	const { players, status } = await ensureSeeded(c.var.kv, c.var.logger);
	if (status === 'cached') {
		c.var.logger.debug('Players already seeded, skipping', { count: players.length });
	} else if (status === 'joined_inflight') {
		c.var.logger.debug('Player seeding in progress, joined existing operation', { count: players.length });
	} else {
		c.var.logger.info('Players seeded', { count: players.length });
	}
	return c.json({ seeded: true, cached: status === 'cached', status, count: players.length });
});

// POST /draft/start - Initialize a new draft
api.post('/draft/start', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const humanTeamIndex = typeof body.humanTeamIndex === 'number' ? body.humanTeamIndex : 0;

	if (humanTeamIndex < 0 || humanTeamIndex >= NUM_TEAMS) {
		return c.json({ error: `humanTeamIndex must be 0-${NUM_TEAMS - 1}` }, 400);
	}

	c.var.logger.info('Starting new draft', { humanTeamIndex });

	// Ensure player data is seeded (deduplicates with concurrent /draft/seed calls)
	await ensureSeeded(c.var.kv, c.var.logger);

	// Initialize the draft via commissioner
	const result = await commissioner.run({
		action: 'start' as const,
		humanTeamIndex,
	});

	// Read full state to return in a single response (avoids 3 follow-up API calls)
	const [playersResult, rostersResults, personasResult] = await Promise.all([
		c.var.kv.get<Player[]>(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS),
		Promise.all(
			Array.from({ length: NUM_TEAMS }, (_, i) =>
				c.var.kv.get<Roster>(KV_TEAM_ROSTERS, `team-${i}`),
			),
		),
		c.var.kv.get<PersonaAssignment[]>(KV_AGENT_STRATEGIES, 'persona-assignments'),
	]);

	return c.json({
		...result,
		players: playersResult.exists ? playersResult.data : [],
		rosters: rostersResults.filter((r) => r.exists).map((r) => r.data),
		personas: personasResult.exists ? personasResult.data : [],
	});
});

// GET /draft/board - Get current board state
api.get('/draft/board', async (c) => {
	const boardResult = await c.var.kv.get<BoardState>(KV_DRAFT_STATE, KEY_BOARD_STATE);

	if (!boardResult.exists) {
		return c.json({ error: 'No draft in progress. POST /draft/start first.' }, 404);
	}

	const board = boardResult.data;

	// Fetch all team rosters in parallel
	const rosterResults = await Promise.all(
		Array.from({ length: NUM_TEAMS }, (_, i) =>
			c.var.kv.get<Roster>(KV_TEAM_ROSTERS, `team-${i}`),
		),
	);
	const rosters: Roster[] = rosterResults
		.filter((r) => r.exists)
		.map((r) => r.data);

	// Get available players count
	const playersResult = await c.var.kv.get<Player[]>(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS);
	const availableCount = playersResult.exists ? playersResult.data.length : 0;

	return c.json({
		board,
		rosters,
		availableCount,
	});
});

// POST /draft/pick - Human makes a pick
api.post('/draft/pick', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const playerId = typeof body.playerId === 'string' ? body.playerId : undefined;

	if (!playerId) {
		return c.json({ error: 'playerId is required' }, 400);
	}

	const result = await commissioner.run({
		action: 'pick' as const,
		playerId,
	});

	return c.json(result);
});

// POST /draft/advance - Trigger next AI pick (non-streaming fallback)
api.post('/draft/advance', async (c) => {
	const result = await commissioner.run({
		action: 'advance' as const,
	});

	return c.json(result);
});

// GET /draft/advance/stream - SSE streaming endpoint for AI pick with live thinking
api.get('/draft/advance/stream', sse(async (c, stream) => {
	const logger = c.var.logger;
	let durableStream: { id: string; url: string; write: (chunk: object) => Promise<void>; close: () => Promise<void> } | null = null;

	try {
		// 1. Read board state
		const boardResult = await c.var.kv.get<BoardState>(KV_DRAFT_STATE, KEY_BOARD_STATE);
		if (!boardResult.exists) {
			await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'No draft in progress' }) });
			stream.close();
			return;
		}

		const boardState = boardResult.data;

		if (boardState.draftComplete) {
			await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'Draft is already complete' }) });
			stream.close();
			return;
		}

		const { currentPick, settings } = boardState;

		if (currentPick.isHuman) {
			await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'It is the human player\'s turn' }) });
			stream.close();
			return;
		}

		// 2. Read persona assignments
		const personaResult = await c.var.kv.get<PersonaAssignment[]>(KV_AGENT_STRATEGIES, 'persona-assignments');
		const personaAssignments = personaResult.exists ? personaResult.data : [];
			const teamPersona = personaAssignments.find((a) => a.teamIndex === currentPick.teamIndex);
			const personaName = teamPersona?.persona ?? 'drafter-balanced';
			const modelName = DRAFTER_MODEL_NAMES[personaName] ?? 'unknown';
			const generationMode = getDrafterGenerationMode(personaName);

		// 3. Read roster and available players
		const rosterResult = await c.var.kv.get<Roster>(KV_TEAM_ROSTERS, `team-${currentPick.teamIndex}`);
		const roster: Roster = rosterResult.exists
			? rosterResult.data
			: { teamIndex: currentPick.teamIndex, teamName: TEAM_NAMES[currentPick.teamIndex] ?? `Team ${currentPick.teamIndex + 1}` };

		const playersResult = await c.var.kv.get<Player[]>(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS);
		if (!playersResult.exists || playersResult.data.length === 0) {
			await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'No available players' }) });
			stream.close();
			return;
		}
		const availablePlayers = playersResult.data;

		// Send initial metadata
			await stream.writeSSE({
				event: 'metadata',
				data: JSON.stringify({
					persona: personaName,
					model: modelName,
					generationMode,
					teamIndex: currentPick.teamIndex,
					teamName: TEAM_NAMES[currentPick.teamIndex],
					pickNumber: currentPick.pickNumber,
				round: currentPick.round,
			}),
		});

		// 4. Create durable stream for pick replay (best-effort, non-blocking)
		try {
			const created = await c.var.stream.create('pick-reasoning', {
				contentType: 'application/x-ndjson',
				metadata: {
					pickNumber: String(currentPick.pickNumber),
					teamIndex: String(currentPick.teamIndex),
					persona: personaName,
				},
				ttl: null,
			});
			durableStream = created;
		} catch (err) {
			logger.warn('Failed to create durable stream, continuing without replay recording', { error: String(err) });
		}

		// Track tool names used during this pick for the reasoning summary
		const toolsUsed: string[] = [];

		// 5. Run board analysis
		const boardAnalysis = analyzeBoardState(boardState.picks, availablePlayers, currentPick.pickNumber);

		// Emit board context so ThinkingPanel shows trends before reasoning
		if (boardAnalysis.positionRuns.length > 0 || boardAnalysis.valueDrops.length > 0 || boardAnalysis.scarcity.length > 0) {
			await stream.writeSSE({
				event: 'board-context',
				data: JSON.stringify({
					positionRuns: boardAnalysis.positionRuns,
					valueDrops: boardAnalysis.valueDrops.slice(0, 3).map((d) => ({
						playerName: d.player.name,
						position: d.player.position,
						adpDiff: d.adpDiff,
					})),
					scarcity: boardAnalysis.scarcity,
					summary: boardAnalysis.summary,
				}),
			});
		}

		// 5. Check roster eligibility; if no positions fit, use fallback
		const availableSlots = getAvailableSlots(roster);

		if (availableSlots.length === 0) {
			// Use fallback pick - roster is full
			const fb = fallbackPick(availablePlayers, roster);
			if (!fb) {
				try { await durableStream?.close(); } catch {}
				await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'No players fit roster' }) });
				stream.close();
				return;
			}

			const result = await recordPick(c.var.kv, {
				boardState,
				roster,
				availablePlayers,
				pickedPlayer: fb,
				reasoning: 'Fallback pick: best available by rank.',
				confidence: 0.3,
				personaName,
			});

			// Fetch updated rosters
			const rosterResults = await Promise.all(
				Array.from({ length: NUM_TEAMS }, (_, i) =>
					c.var.kv.get<Roster>(KV_TEAM_ROSTERS, `team-${i}`),
				),
			);
			const rosters: Roster[] = rosterResults.filter((r) => r.exists).map((r) => r.data);

			await stream.writeSSE({
				event: 'pick',
				data: JSON.stringify({
					pick: result.pick,
					boardState: result.boardState,
					rosters,
					draftComplete: result.draftComplete,
				}),
			});
			await stream.writeSSE({ event: 'done', data: '' });
			stream.close();
			return;
		}

		// 6. Build tools and prompt for tool-calling LLM flow
		const hasMeaningfulBoardSignals = boardAnalysis.positionRuns.length > 0
			|| boardAnalysis.valueDrops.length > 0
			|| boardAnalysis.scarcity.length > 0;
		const systemPrompt = getDrafterPrompt(personaName, hasMeaningfulBoardSignals);
		const model = DRAFTER_MODELS[personaName] ?? DRAFTER_MODELS['drafter-balanced']!;

		const tools = createDrafterTools({
			kv: c.var.kv,
			availablePlayers,
			roster,
			picks: boardState.picks,
			pickNumber: currentPick.pickNumber,
			teamIndex: currentPick.teamIndex,
			round: currentPick.round,
		});

		const toolOrientedPrompt = buildToolOrientedPrompt(
			TEAM_NAMES[currentPick.teamIndex] ?? `Team ${currentPick.teamIndex + 1}`,
			roster,
			availableSlots,
			boardState.picks,
			currentPick.round,
			currentPick.pickNumber,
			hasMeaningfulBoardSignals ? boardAnalysis.summary : undefined,
		);

			logger.info('Starting SSE stream for AI pick with tools', {
				persona: personaName,
				model: modelName,
				generationMode,
				pickNumber: currentPick.pickNumber,
				hasMeaningfulBoardSignals,
			});

		let fullText = '';
		let streamError: string | null = null;
			let structuredPick: {
				playerId: string;
				playerName: string;
				position: 'QB' | 'RB' | 'WR' | 'TE';
				reasoning: string;
				confidence: number;
			} | null = null;
			let fallbackReason: 'model_error' | 'no_output' | 'invalid_json' | 'invalid_output' | null = null;

			try {
				const result = generationMode === 'structured_with_tools'
					? streamText({
						model,
						system: systemPrompt,
						prompt: toolOrientedPrompt,
						tools,
						output: Output.object({
							schema: DrafterOutputZodSchema,
							name: 'draft_pick',
							description: 'Final fantasy draft pick selection.',
						}),
						// Keep demo picks responsive while still allowing a short tool loop.
						stopWhen: stepCountIs(5),
					})
					: streamText({
						model,
						system: systemPrompt,
						prompt: toolOrientedPrompt,
						tools,
						// Keep demo picks responsive while still allowing a short tool loop.
						stopWhen: stepCountIs(5),
					});

				for await (const part of result.fullStream) {
				switch (part.type) {
					case 'text-delta':
						fullText += part.text;
						await stream.writeSSE({ event: 'thinking', data: part.text });
						try { await durableStream?.write({ type: 'thinking', text: part.text, ts: Date.now() }); } catch {}
						break;

					case 'tool-call':
						if (!toolsUsed.includes(part.toolName)) toolsUsed.push(part.toolName);
						await stream.writeSSE({
							event: 'tool-call',
							data: JSON.stringify({
								toolCallId: part.toolCallId,
								name: part.toolName,
								args: part.input,
							}),
						});
						try { await durableStream?.write({ type: 'tool-call', name: part.toolName, args: part.input, ts: Date.now() }); } catch {}
						break;

					case 'tool-result':
						await stream.writeSSE({
							event: 'tool-result',
							data: JSON.stringify({
								toolCallId: part.toolCallId,
								name: part.toolName,
								result: summarizeToolResult(part.toolName, part.output),
							}),
						});
						try { await durableStream?.write({ type: 'tool-result', name: part.toolName, result: summarizeToolResult(part.toolName, part.output), ts: Date.now() }); } catch {}
						break;
					}
				}

				const output = await result.output;
				if (typeof output === 'string') {
					if (fullText.length === 0) {
						fullText = output;
					}
					structuredPick = parseDrafterOutputFromText(fullText);
					if (!structuredPick) {
						fallbackReason = fullText.trim().length > 0 ? 'invalid_json' : 'no_output';
					}
				} else {
					structuredPick = output;
				}
			} catch (err) {
				streamError = String(err);
				fallbackReason = 'model_error';
				logger.warn('Streaming failed for model', { persona: personaName, model: modelName, error: streamError });
				await stream.writeSSE({ event: 'thinking', data: `\n\n[Model error: ${streamError}]` });
			}

		// Validate structured output against current board constraints
		let pickedPlayer: Player | null = null;
		let pickReasoning = structuredPick?.reasoning || fullText || 'AI reasoning unavailable.';
		let pickConfidence = Math.max(0, Math.min(1, structuredPick?.confidence ?? 0.7));
		let parseStage = 'none';

		if (structuredPick) {
			const idMatch = availablePlayers.find((p) => p.playerId === structuredPick.playerId);
			const nameMatch = idMatch
				? null
				: availablePlayers.find((p) => p.name.toLowerCase() === structuredPick.playerName.toLowerCase());
			const selectedPlayer = idMatch ?? nameMatch ?? null;
			const fitsRoster = selectedPlayer ? canDraftPosition(roster, selectedPlayer.position) : false;

				if (selectedPlayer && fitsRoster) {
					pickedPlayer = selectedPlayer;
					parseStage = idMatch ? 'structured-output-id' : 'structured-output-name';
				logger.info('LLM structured output validated', {
					parseStage,
					player: selectedPlayer.name,
					playerId: selectedPlayer.playerId,
				});
				} else {
					fallbackReason = 'invalid_output';
					logger.warn('LLM structured output did not map to an eligible available player', {
						playerId: structuredPick.playerId,
						playerName: structuredPick.playerName,
						matchedByName: !!nameMatch,
						generationMode,
					});
				}
			} else {
				logger.warn('No structured pick output from model, entering fallback', {
					streamError,
					fullTextLength: fullText.length,
					generationMode,
					fallbackReason,
				});
			}

		// 7. Deterministic fallback (best available by rank)
		if (!pickedPlayer) {
			pickedPlayer = fallbackPick(availablePlayers, roster);
			if (!pickedPlayer) {
				try { await durableStream?.close(); } catch {}
				await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'No valid pick possible' }) });
				stream.close();
				return;
			}
			const errorContext = streamError ? ` (model error: ${streamError})` : '';
				pickReasoning = `Fallback: ${pickedPlayer.name} is the highest-ranked available (Rank ${pickedPlayer.rank}).${errorContext}`;
				pickConfidence = 0.3;
				parseStage = 'fallback';
				logger.warn('Using fallback pick', {
					persona: personaName,
					model: modelName,
					player: pickedPlayer.name,
					streamError,
					parseStage,
					generationMode,
					fallbackReason: fallbackReason ?? 'invalid_output',
				});
			}

		// 8. Record the pick
		const result = await recordPick(c.var.kv, {
			boardState,
			roster,
			availablePlayers,
			pickedPlayer,
			reasoning: pickReasoning,
			confidence: pickConfidence,
			personaName,
			boardAnalysis,
		});

		if (!result.success) {
			try { await durableStream?.close(); } catch {}
			await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: result.message }) });
			stream.close();
			return;
		}

		// 9. Write reasoning summary to KV (critical path for getDraftIntel tool)
		// and close the durable stream (best-effort for replay)
		const reasoningSummary: ReasoningSummary = {
			pickNumber: currentPick.pickNumber,
			teamIndex: currentPick.teamIndex,
			persona: personaName,
			model: modelName,
			playerId: pickedPlayer.playerId,
			playerName: pickedPlayer.name,
			position: pickedPlayer.position,
			summary: pickReasoning.slice(0, 500),
			toolsUsed,
			confidence: pickConfidence,
			timestamp: Date.now(),
			...(durableStream ? { streamId: durableStream.id, streamUrl: durableStream.url } : {}),
		};

		// Best-effort: KV reasoning summary + durable stream close.
		// The pick is already committed via recordPick above, so failures
		// here should not surface as errors to the client.
		try {
			await c.var.kv.set(KV_PICK_REASONING, `pick-${currentPick.pickNumber}`, reasoningSummary, { ttl: null });
		} catch (err) {
			logger.warn('Failed to write reasoning summary to KV', { error: String(err), pickNumber: currentPick.pickNumber });
		}

		try {
			if (durableStream) {
				await durableStream.write({
					type: 'pick-summary',
					pickNumber: currentPick.pickNumber,
					persona: personaName,
					player: pickedPlayer.name,
					position: pickedPlayer.position,
					reasoning: pickReasoning,
					confidence: pickConfidence,
				});
				await durableStream.close();
			}
		} catch (err) {
			logger.warn('Failed to close durable stream', { error: String(err) });
		}

		// Emit strategy shift event if one was detected
		if (result.strategyShift) {
			await stream.writeSSE({
				event: 'strategy-shift',
				data: JSON.stringify(result.strategyShift),
			});
		}

		// Fetch updated rosters for the frontend (non-critical, frontend will refresh anyway)
		let rosters: Roster[] = [];
		try {
			const updatedRosterResults = await Promise.all(
				Array.from({ length: NUM_TEAMS }, (_, i) =>
					c.var.kv.get<Roster>(KV_TEAM_ROSTERS, `team-${i}`),
				),
			);
			rosters = updatedRosterResults.filter((r) => r.exists).map((r) => r.data);
		} catch (err) {
			logger.warn('Failed to fetch updated rosters after pick, sending pick without rosters', { error: String(err) });
		}

		// 10. Send pick event with full data (includes stream info for frontend replay)
		await stream.writeSSE({
			event: 'pick',
			data: JSON.stringify({
				pick: result.pick,
				boardState: result.boardState,
				...(rosters.length > 0 ? { rosters } : {}),
				draftComplete: result.draftComplete,
				...(durableStream ? { streamId: durableStream.id, streamUrl: durableStream.url } : {}),
			}),
		});

		// 11. Done
		await stream.writeSSE({ event: 'done', data: '' });
		stream.close();

		logger.info('SSE stream complete', {
			persona: personaName,
			player: pickedPlayer.name,
			pickNumber: currentPick.pickNumber,
			hasReplay: !!durableStream,
		});
	} catch (err) {
		logger.error('SSE handler error', { error: String(err) });
		try { await durableStream?.close(); } catch {}
		try {
			await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: String(err) }) });
		} catch {
			// Stream may already be closed
		}
		stream.close();
	}
}));

// GET /draft/players - Get available players list (for frontend pick interface)
api.get('/draft/players', async (c) => {
	const playersResult = await c.var.kv.get<Player[]>(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS);
	if (!playersResult.exists) {
		return c.json({ error: 'No players seeded. POST /draft/seed first.' }, 404);
	}
	return c.json({ players: playersResult.data });
});

// GET /draft/strategies - Get persona assignments and strategy shifts
api.get('/draft/strategies', async (c) => {
	try {
		const [personasResult, shiftsResult, boardResult] = await Promise.all([
			c.var.kv.get<PersonaAssignment[]>(KV_AGENT_STRATEGIES, 'persona-assignments'),
			c.var.kv.get<StrategyShift[]>(KV_AGENT_STRATEGIES, 'strategy-shifts'),
			c.var.kv.get<BoardState>(KV_DRAFT_STATE, KEY_BOARD_STATE),
		]);
		const normalizedShifts = shiftsResult.exists ? shiftsResult.data.map((shift) => normalizeShift(shift)) : [];
		const picks = boardResult.exists ? boardResult.data.picks : [];
		return c.json({
			personas: personasResult.exists ? personasResult.data : null,
			shifts: normalizedShifts,
			teamShiftSummary: buildTeamShiftSummary(normalizedShifts, picks),
		});
	} catch (err) {
		c.var.logger.warn('KV read failed in /draft/strategies', { error: String(err) });
		return c.json({ personas: null, shifts: [], teamShiftSummary: [] });
	}
});

// POST /draft/test/trigger-shift - Inject a fake strategy shift for UI testing
api.post('/draft/test/trigger-shift', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const teamIndex = typeof body.teamIndex === 'number' ? body.teamIndex : 0;

	if (teamIndex < 0 || teamIndex >= NUM_TEAMS) {
		return c.json({ error: `teamIndex must be 0-${NUM_TEAMS - 1}` }, 400);
	}

	// Read persona assignments to get the team's persona
	const personasResult = await c.var.kv.get<PersonaAssignment[]>(KV_AGENT_STRATEGIES, 'persona-assignments');
	const personaAssignments = personasResult.exists ? personasResult.data : [];
	const teamPersona = personaAssignments.find((a) => a.teamIndex === teamIndex);
	const personaName = teamPersona?.persona ?? 'drafter-balanced';

	const fakeShift = {
		pickNumber: 999,
		teamIndex,
		persona: personaName,
		trigger: 'TEST: Manually triggered strategy shift for UI testing.',
		reasoning: 'This is a test shift injected via the /draft/test/trigger-shift endpoint.',
		playerPicked: 'Test Player',
		position: 'QB' as const,
		category: 'strategy-break' as const,
		severity: 'major' as const,
	};

	// Append to existing shifts
	const existingShifts = await c.var.kv.get<typeof fakeShift[]>(KV_AGENT_STRATEGIES, 'strategy-shifts');
	const allShifts = existingShifts.exists ? [...existingShifts.data, fakeShift] : [fakeShift];
	await c.var.kv.set(KV_AGENT_STRATEGIES, 'strategy-shifts', allShifts, { ttl: null });

	c.var.logger.info('Test strategy shift injected', { teamIndex, persona: personaName });

	return c.json({ success: true, shift: fakeShift, totalShifts: allShifts.length });
});

export default api;
