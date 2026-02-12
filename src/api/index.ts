import { createRouter } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import commissioner from '../agent/commissioner';
import { seedPlayers } from '../lib/seed-players';
import {
	type BoardState,
	type Player,
	type Roster,
	KV_DRAFT_STATE,
	KV_TEAM_ROSTERS,
	KEY_BOARD_STATE,
	KEY_AVAILABLE_PLAYERS,
	NUM_TEAMS,
} from '../lib/types';

const api = createRouter();

// Health check
api.get('/health', (c) => c.json({ status: 'ok' }));

// POST /draft/start - Initialize a new draft
api.post('/draft/start', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const humanTeamIndex = typeof body.humanTeamIndex === 'number' ? body.humanTeamIndex : 0;

	c.var.logger.info('Starting new draft', { humanTeamIndex });

	// Seed player data into Vector + KV
	const players = await seedPlayers(c.var.kv, c.var.vector);
	c.var.logger.info('Players seeded', { count: players.length });

	// Initialize the draft via commissioner
	const result = await commissioner.run({
		action: 'start' as const,
		humanTeamIndex,
	});

	return c.json(result);
});

// GET /draft/board - Get current board state
api.get('/draft/board', async (c) => {
	const boardResult = await c.var.kv.get<BoardState>(KV_DRAFT_STATE, KEY_BOARD_STATE);

	if (!boardResult.exists) {
		return c.json({ error: 'No draft in progress. POST /draft/start first.' }, 404);
	}

	const board = boardResult.data;

	// Also fetch all team rosters
	const rosters: Roster[] = [];
	for (let i = 0; i < NUM_TEAMS; i++) {
		const rosterResult = await c.var.kv.get<Roster>(KV_TEAM_ROSTERS, `team-${i}`);
		if (rosterResult.exists) {
			rosters.push(rosterResult.data);
		}
	}

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

// POST /draft/advance - Trigger next AI pick
api.post('/draft/advance', async (c) => {
	const result = await commissioner.run({
		action: 'advance' as const,
	});

	return c.json(result);
});

export default api;
