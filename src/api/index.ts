import { createRouter, sse } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import { streamText, stepCountIs } from 'ai';
import commissioner from '../agent/commissioner';
import { seedPlayers } from '../lib/seed-players';
import { buildToolOrientedPrompt, fallbackPick } from '../lib/drafter-common';
import { createDrafterTools } from '../lib/drafter-tools';
import { DRAFTER_MODELS, DRAFTER_MODEL_NAMES, getDrafterPrompt } from '../lib/drafter-models';
import { recordPick } from '../lib/record-pick';
import { analyzeBoardState } from '../lib/board-analysis';
import type { PersonaAssignment } from '../lib/persona-assignment';
import {
	type BoardState,
	type Player,
	type Roster,
	KV_DRAFT_STATE,
	KV_TEAM_ROSTERS,
	KV_AGENT_STRATEGIES,
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

const api = createRouter();

// In-flight seed promise to deduplicate concurrent seed calls
let seedPromise: Promise<Player[]> | null = null;

async function ensureSeeded(kv: Parameters<typeof seedPlayers>[0], vector: Parameters<typeof seedPlayers>[1], logger: { info: (msg: string, meta?: Record<string, unknown>) => void }): Promise<{ players: Player[]; cached: boolean }> {
	const existing = await kv.get<Player[]>(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS);
	if (existing.exists && existing.data.length > 0) {
		return { players: existing.data, cached: true };
	}

	// Deduplicate: if a seed is already in-flight, join it
	if (!seedPromise) {
		logger.info('Seeding player data');
		seedPromise = seedPlayers(kv, vector).finally(() => { seedPromise = null; });
	}

	const players = await seedPromise;
	return { players, cached: false };
}

// Health check
api.get('/health', (c) => c.json({ status: 'ok' }));

// POST /draft/seed - Seed player data (Vector + KV). Skips if already seeded.
api.post('/draft/seed', async (c) => {
	const { players, cached } = await ensureSeeded(c.var.kv, c.var.vector, c.var.logger);
	c.var.logger.info(cached ? 'Players already seeded, skipping' : 'Players seeded', { count: players.length });
	return c.json({ seeded: true, cached, count: players.length });
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
	await ensureSeeded(c.var.kv, c.var.vector, c.var.logger);

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
				teamIndex: currentPick.teamIndex,
				teamName: TEAM_NAMES[currentPick.teamIndex],
				pickNumber: currentPick.pickNumber,
				round: currentPick.round,
			}),
		});

		// 4. Run board analysis
		const boardAnalysis = analyzeBoardState(boardState.picks, availablePlayers, currentPick.pickNumber);

		// 5. Check roster eligibility; if no positions fit, use fallback
		const availableSlots = getAvailableSlots(roster);

		if (availableSlots.length === 0) {
			// Use fallback pick - roster is full
			const fb = fallbackPick(availablePlayers, roster);
			if (!fb) {
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
		const systemPrompt = getDrafterPrompt(personaName, !!boardAnalysis.summary);
		const model = DRAFTER_MODELS[personaName] ?? DRAFTER_MODELS['drafter-balanced']!;

		const tools = createDrafterTools({
			vector: c.var.vector,
			kv: c.var.kv,
			availablePlayers,
			roster,
			picks: boardState.picks,
			pickNumber: currentPick.pickNumber,
		});

		const toolOrientedPrompt = buildToolOrientedPrompt(
			TEAM_NAMES[currentPick.teamIndex] ?? `Team ${currentPick.teamIndex + 1}`,
			roster,
			availableSlots,
			boardState.picks,
			currentPick.round,
			currentPick.pickNumber,
			boardAnalysis.summary,
		);

		const combinedPrompt = toolOrientedPrompt + `\n\nThink step-by-step about your pick choice, then output your final decision as a JSON code block:\n\n\`\`\`json\n{"playerId": "...", "playerName": "...", "position": "QB|RB|WR|TE", "reasoning": "one sentence summary", "confidence": 0.0-1.0}\n\`\`\`\n\nIMPORTANT: The JSON block MUST appear at the end of your response.`;

		logger.info('Starting SSE stream for AI pick with tools', {
			persona: personaName,
			model: modelName,
			pickNumber: currentPick.pickNumber,
		});

		let fullText = '';
		let streamError: string | null = null;

		try {
			const result = streamText({
				model,
				system: systemPrompt,
				prompt: combinedPrompt,
				tools,
				stopWhen: stepCountIs(4),
			});

			for await (const part of result.fullStream) {
				switch (part.type) {
					case 'text-delta':
						fullText += part.text;
						await stream.writeSSE({ event: 'thinking', data: part.text });
						break;

					case 'tool-call':
						await stream.writeSSE({
							event: 'tool-call',
							data: JSON.stringify({ name: part.toolName, args: part.input }),
						});
						break;

					case 'tool-result':
						await stream.writeSSE({
							event: 'tool-result',
							data: JSON.stringify({
								name: part.toolName,
								result: summarizeToolResult(part.toolName, part.output),
							}),
						});
						break;
				}
			}
		} catch (err) {
			streamError = String(err);
			logger.warn('Streaming failed for model', { persona: personaName, model: modelName, error: streamError });
			await stream.writeSSE({ event: 'thinking', data: `\n\n[Model error: ${streamError}]` });
		}

		// Parse JSON from the streamed text
		let pickedPlayer: Player | null = null;
		let pickReasoning = fullText || 'AI reasoning unavailable.';
		let pickConfidence = 0.7;
		let parseStage = 'none';

		// Stage 1: Try code block format: ```json ... ```
		const jsonMatch = fullText.match(/```json\s*([\s\S]*?)```/);
		if (jsonMatch?.[1]) {
			try {
				const parsed = JSON.parse(jsonMatch[1].trim());
				// Coerce numeric playerId to string for matching
				const parsedId = String(parsed.playerId);
				const foundPlayer = availablePlayers.find((p) => p.playerId === parsedId);
				if (foundPlayer && canDraftPosition(roster, foundPlayer.position)) {
					pickedPlayer = foundPlayer;
					pickReasoning = fullText.split('```json')[0]?.trim() || parsed.reasoning || fullText;
					pickConfidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.7));
					parseStage = 'code-block-id';
				} else if (!foundPlayer && parsed.playerName) {
					// Stage 1b: playerId didn't match, try matching by playerName
					const nameMatch = availablePlayers.find(
						(p) => p.name.toLowerCase() === String(parsed.playerName).toLowerCase() && canDraftPosition(roster, p.position),
					);
					if (nameMatch) {
						pickedPlayer = nameMatch;
						pickReasoning = fullText.split('```json')[0]?.trim() || parsed.reasoning || fullText;
						pickConfidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.7));
						parseStage = 'code-block-name';
						logger.info('Matched by playerName instead of playerId', {
							parsedId,
							parsedName: parsed.playerName,
							matchedId: nameMatch.playerId,
						});
					}
				}
			} catch { /* JSON parse failed, try next format */ }
		}

		// Stage 2: Try raw JSON format: {"playerId": ...} (handles both quoted and numeric values)
		if (!pickedPlayer) {
			const rawJsonMatch = fullText.match(/\{[\s\S]*?"playerId"\s*:\s*(?:"[^"]*?"|[0-9]+)[\s\S]*?\}/);
			if (rawJsonMatch) {
				try {
					const parsed = JSON.parse(rawJsonMatch[0]);
					const parsedId = String(parsed.playerId);
					const foundPlayer = availablePlayers.find((p) => p.playerId === parsedId);
					if (foundPlayer && canDraftPosition(roster, foundPlayer.position)) {
						pickedPlayer = foundPlayer;
						pickReasoning = parsed.reasoning || fullText.split(rawJsonMatch[0])[0]?.trim() || fullText;
						pickConfidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.7));
						parseStage = 'raw-json-id';
					} else if (!foundPlayer && parsed.playerName) {
						// Stage 2b: playerId didn't match, try matching by playerName
						const nameMatch = availablePlayers.find(
							(p) => p.name.toLowerCase() === String(parsed.playerName).toLowerCase() && canDraftPosition(roster, p.position),
						);
						if (nameMatch) {
							pickedPlayer = nameMatch;
							pickReasoning = parsed.reasoning || fullText.split(rawJsonMatch[0])[0]?.trim() || fullText;
							pickConfidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.7));
							parseStage = 'raw-json-name';
							logger.info('Matched by playerName instead of playerId (raw JSON)', {
								parsedId,
								parsedName: parsed.playerName,
								matchedId: nameMatch.playerId,
							});
						}
					}
				} catch { /* raw JSON parse also failed */ }
			}
		}

		// Stage 3: No JSON found at all, try to find a player name mentioned in the text
		if (!pickedPlayer && fullText.length > 0) {
			// Sort available players by rank (best first), then check if any name appears in the text
			const sortedByRank = [...availablePlayers]
				.filter((p) => canDraftPosition(roster, p.position))
				.sort((a, b) => a.rank - b.rank);
			for (const player of sortedByRank) {
				if (fullText.includes(player.name)) {
					pickedPlayer = player;
					pickReasoning = fullText;
					pickConfidence = 0.5;
					parseStage = 'text-name-match';
					logger.info('Matched player by name found in LLM text', {
						player: player.name,
						playerId: player.playerId,
					});
					break;
				}
			}
		}

		// Log parsing result before fallback
		if (!pickedPlayer) {
			logger.warn('LLM pick parsing failed, entering fallback', {
				fullTextLength: fullText.length,
				hasCodeBlock: !!jsonMatch,
				hasRawJson: !!fullText.match(/\{[\s\S]*?"playerId"\s*:\s*(?:"[^"]*?"|[0-9]+)[\s\S]*?\}/),
				firstFewChars: fullText.substring(0, 200),
				streamError,
				parseStage,
			});
		} else {
			logger.info('LLM pick parsed successfully', {
				parseStage,
				player: pickedPlayer.name,
				playerId: pickedPlayer.playerId,
			});
		}

		// Stage 4: Deterministic fallback (best available by rank)
		if (!pickedPlayer) {
			pickedPlayer = fallbackPick(availablePlayers, roster);
			if (!pickedPlayer) {
				await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'No valid pick possible' }) });
				stream.close();
				return;
			}
			const errorContext = streamError ? ` (model error: ${streamError})` : '';
			pickReasoning = `Fallback: ${pickedPlayer.name} is the highest-ranked available (Rank ${pickedPlayer.rank}).${errorContext}`;
			pickConfidence = 0.3;
			parseStage = 'fallback';
			logger.warn('Using fallback pick', { persona: personaName, model: modelName, player: pickedPlayer.name, streamError, parseStage });
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
			await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: result.message }) });
			stream.close();
			return;
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

		// 9. Send pick event with full data
		await stream.writeSSE({
			event: 'pick',
			data: JSON.stringify({
				pick: result.pick,
				boardState: result.boardState,
				...(rosters.length > 0 ? { rosters } : {}),
				draftComplete: result.draftComplete,
			}),
		});

		// 10. Done
		await stream.writeSSE({ event: 'done', data: '' });
		stream.close();

		logger.info('SSE stream complete', {
			persona: personaName,
			player: pickedPlayer.name,
			pickNumber: currentPick.pickNumber,
		});
	} catch (err) {
		logger.error('SSE handler error', { error: String(err) });
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
		const personasResult = await c.var.kv.get(KV_AGENT_STRATEGIES, 'persona-assignments');
		const shiftsResult = await c.var.kv.get(KV_AGENT_STRATEGIES, 'strategy-shifts');
		return c.json({
			personas: personasResult.exists ? personasResult.data : null,
			shifts: shiftsResult.exists ? shiftsResult.data : [],
		});
	} catch (err) {
		c.var.logger.warn('KV read failed in /draft/strategies', { error: String(err) });
		return c.json({ personas: null, shifts: [] });
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
	};

	// Append to existing shifts
	const existingShifts = await c.var.kv.get<typeof fakeShift[]>(KV_AGENT_STRATEGIES, 'strategy-shifts');
	const allShifts = existingShifts.exists ? [...existingShifts.data, fakeShift] : [fakeShift];
	await c.var.kv.set(KV_AGENT_STRATEGIES, 'strategy-shifts', allShifts, { ttl: null });

	c.var.logger.info('Test strategy shift injected', { teamIndex, persona: personaName });

	return c.json({ success: true, shift: fakeShift, totalShifts: allShifts.length });
});

export default api;
