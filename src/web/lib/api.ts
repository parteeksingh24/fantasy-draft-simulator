import type { BoardState, Player, Position, Roster, PersonaAssignment, StrategyShift } from './types';

const BASE_URL = '/api';

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE_URL}${url}`, {
		headers: { 'Content-Type': 'application/json' },
		...options,
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: res.statusText }));
		const errorMsg = typeof body.error === 'string' ? body.error
			: typeof body.message === 'string' ? body.message
			: `API error: ${res.status}`;
		throw new Error(errorMsg);
	}
	return res.json();
}

export interface SeedResponse {
	seeded: boolean;
	cached: boolean;
	count: number;
}

export interface StartResponse {
	success: boolean;
	message: string;
	boardState: BoardState;
	draftComplete: boolean;
	players: Player[];
	rosters: Roster[];
	personas: PersonaAssignment[];
}

export interface BoardResponse {
	board: BoardState;
	rosters: Roster[];
	availableCount: number;
}

export interface PlayersResponse {
	players: Player[];
}

export interface AdvanceResponse {
	success: boolean;
	message: string;
	pick?: {
		pickNumber: number;
		round: number;
		teamIndex: number;
		playerId: string;
		playerName: string;
		position: Position;
		reasoning: string;
		confidence: number;
	};
	boardState: BoardState;
	draftComplete: boolean;
}

export interface PickResponse {
	success: boolean;
	message: string;
	pick?: {
		pickNumber: number;
		round: number;
		teamIndex: number;
		playerId: string;
		playerName: string;
		position: Position;
		reasoning: string;
		confidence: number;
	};
	boardState: BoardState;
	draftComplete: boolean;
}

export interface StrategiesResponse {
	personas: PersonaAssignment[] | null;
	shifts: StrategyShift[];
}

export const api = {
	seedPlayers: () =>
		fetchJSON<SeedResponse>('/draft/seed', { method: 'POST' }),

	startDraft: (humanTeamIndex: number) =>
		fetchJSON<StartResponse>('/draft/start', {
			method: 'POST',
			body: JSON.stringify({ humanTeamIndex }),
		}),

	getBoard: () =>
		fetchJSON<BoardResponse>('/draft/board'),

	getPlayers: () =>
		fetchJSON<PlayersResponse>('/draft/players'),

	makePick: (playerId: string) =>
		fetchJSON<PickResponse>('/draft/pick', {
			method: 'POST',
			body: JSON.stringify({ playerId }),
		}),

	advance: () =>
		fetchJSON<AdvanceResponse>('/draft/advance', { method: 'POST' }),

	getStrategies: () =>
		fetchJSON<StrategiesResponse>('/draft/strategies'),
};
