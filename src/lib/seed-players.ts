import type { KeyValueStorage } from '@agentuity/core';
import type { VectorStorage } from '@agentuity/core';
import {
	type Player,
	KV_DRAFT_STATE,
	KEY_AVAILABLE_PLAYERS,
	VECTOR_PLAYERS,
} from './types';

// Sleeper API types
interface SleeperPlayer {
	player_id: string;
	full_name: string;
	position: string;
	team: string | null;
	age: number | null;
	search_rank: number;
	active: boolean;
	status?: string;
	years_exp?: number;
}

type SleeperResponse = Record<string, SleeperPlayer>;

// NFL team bye weeks for 2025 (approximated)
const BYE_WEEKS: Record<string, number> = {
	ARI: 11, ATL: 12, BAL: 14, BUF: 12,
	CAR: 11, CHI: 7, CIN: 12, CLE: 10,
	DAL: 7, DEN: 14, DET: 9, GB: 10,
	HOU: 14, IND: 14, JAX: 12, KC: 6,
	LAC: 5, LAR: 6, LV: 10, MIA: 6,
	MIN: 6, NE: 14, NO: 12, NYG: 11,
	NYJ: 12, PHI: 7, PIT: 9, SEA: 10,
	SF: 9, TB: 11, TEN: 5, WAS: 14,
};

const DEFAULT_BYE_WEEK = 8;
const SLEEPER_API_URL = 'https://api.sleeper.app/v1/players/nfl';
const VALID_POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
const TOP_N_PLAYERS = 150;

/**
 * Fetch all players from Sleeper API and filter to fantasy-relevant players.
 */
async function fetchSleeperPlayers(): Promise<SleeperPlayer[]> {
	const response = await fetch(SLEEPER_API_URL);

	if (!response.ok) {
		throw new Error(`Sleeper API error: ${response.status} ${response.statusText}`);
	}

	const data: SleeperResponse = await response.json();

	const players = Object.values(data)
		.filter((p) => {
			// Must be a valid fantasy position
			if (!VALID_POSITIONS.includes(p.position as any)) return false;

			// Must be active
			if (!p.active) return false;

			// Check status if available
			if (p.status && p.status !== 'Active') return false;

			// Must have a search rank (for sorting)
			if (!p.search_rank || p.search_rank === 999999) return false;

			// Must have a current NFL team (filter out free agents and retired)
			if (!p.team || p.team === '') return false;

			// Must have recent experience (filter out long-retired players)
			if (p.years_exp !== undefined && p.years_exp > 15) return false;

			return true;
		})
		.sort((a, b) => a.search_rank - b.search_rank)
		.slice(0, TOP_N_PLAYERS);

	return players;
}

/**
 * Calculate player tier based on search rank.
 * Tier 1 = top 30, Tier 2 = 31-60, Tier 3 = 61-90, Tier 4 = 91-120, Tier 5 = 121+
 */
function calculateTier(searchRank: number): number {
	if (searchRank <= 30) return 1;
	if (searchRank <= 60) return 2;
	if (searchRank <= 90) return 3;
	if (searchRank <= 120) return 4;
	return 5;
}

/**
 * Map a Sleeper player to our Player type.
 */
function mapSleeperToPlayer(sleeperPlayer: SleeperPlayer, index: number): Player {
	const team = sleeperPlayer.team || 'FA';
	const byeWeek = BYE_WEEKS[team] || DEFAULT_BYE_WEEK;
	const rank = sleeperPlayer.search_rank;
	const tier = calculateTier(sleeperPlayer.search_rank);

	return {
		playerId: sleeperPlayer.player_id,
		name: sleeperPlayer.full_name,
		position: sleeperPlayer.position as any,
		team,
		rank,
		tier,
		age: sleeperPlayer.age || 25,
		byeWeek,
	};
}

/**
 * Seed Vector storage in batches (embedding is slow).
 * Runs in the background; callers should fire-and-forget.
 */
async function seedVector(vector: VectorStorage, players: Player[]): Promise<void> {
	const BATCH_SIZE = 30;
	const vectorDocs = players.map((player) => ({
		key: player.playerId,
		document: `${player.name}, ${player.position} for ${player.team}. Age ${player.age}, Rank ${player.rank}, Tier ${player.tier}. Bye week ${player.byeWeek}.`,
		metadata: {
			playerId: player.playerId,
			name: player.name,
			position: player.position,
			team: player.team,
			rank: player.rank,
			tier: player.tier,
			age: player.age,
			byeWeek: player.byeWeek,
		},
		ttl: null as null,
	}));

	// Batch into smaller chunks to avoid timeouts
	for (let i = 0; i < vectorDocs.length; i += BATCH_SIZE) {
		const batch = vectorDocs.slice(i, i + BATCH_SIZE);
		await vector.upsert(VECTOR_PLAYERS, ...batch);
	}
}

/**
 * Seed players into KV and Vector storage.
 *
 * KV stores the available player list (source of truth for availability).
 * Vector stores each player as an embedded document for semantic search.
 * Vector seeding runs in the background (fire-and-forget) because it requires
 * embedding 150 documents and is only needed when agents use the searchPlayers
 * tool. Agents fall back to getTopAvailable (KV-based) if Vector isn't ready.
 *
 * @param kv - KeyValue storage interface
 * @param vector - Vector storage interface
 * @returns Array of seeded players
 */
export async function seedPlayers(kv: KeyValueStorage, vector: VectorStorage): Promise<Player[]> {
	// Fetch players from Sleeper API
	const sleeperPlayers = await fetchSleeperPlayers();

	if (sleeperPlayers.length === 0) {
		throw new Error('No players fetched from Sleeper API');
	}

	// Map to our Player type
	const players = sleeperPlayers.map((sp, index) => mapSleeperToPlayer(sp, index));

	// Store available player list in KV (primary source of truth, fast)
	await kv.set(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS, players, { ttl: null });

	// Seed Vector storage in the background (slow - embedding 150 docs).
	// AI agents have getTopAvailable (KV) as a fallback if Vector isn't ready yet.
	seedVector(vector, players).catch(() => {});

	return players;
}
