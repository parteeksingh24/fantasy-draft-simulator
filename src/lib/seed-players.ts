import type { KeyValueStorage, VectorStorage } from '@agentuity/core';
import {
	type Player,
	type PlayerMetadata,
	VECTOR_PLAYERS,
	KV_DRAFT_STATE,
	KEY_AVAILABLE_PLAYERS,
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
	const adp = index + 1; // Use array index as ADP proxy (since we sorted by search_rank)
	const tier = calculateTier(sleeperPlayer.search_rank);

	return {
		playerId: sleeperPlayer.player_id,
		name: sleeperPlayer.full_name,
		position: sleeperPlayer.position as any,
		team,
		adp,
		tier,
		age: sleeperPlayer.age || 25,
		byeWeek,
	};
}

/**
 * Build a text document for Vector semantic search.
 * Example: "Patrick Mahomes QB Kansas City Chiefs - Elite quarterback, age 28, ADP 5, Tier 1"
 */
function buildPlayerDocument(player: Player): string {
	const tierLabel = player.tier === 1 ? 'Elite' : player.tier === 2 ? 'High-end' : player.tier === 3 ? 'Mid-tier' : player.tier === 4 ? 'Deep' : 'Waiver';
	return `${player.name} ${player.position} ${player.team} - ${tierLabel} ${player.position.toLowerCase()}, age ${player.age}, ADP ${player.adp}, Tier ${player.tier}`;
}

/**
 * Seed players into Vector storage and KV storage.
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

	// Build all vector documents
	const vectorDocuments = players.map((player) => ({
		key: `player-${player.playerId}`,
		document: buildPlayerDocument(player),
		metadata: {
			playerId: player.playerId,
			name: player.name,
			position: player.position,
			team: player.team,
			adp: player.adp,
			tier: player.tier,
			age: player.age,
			byeWeek: player.byeWeek,
		} satisfies PlayerMetadata,
	}));

	// Batch upsert to avoid timeout - 25 players per batch
	const BATCH_SIZE = 25;
	for (let i = 0; i < vectorDocuments.length; i += BATCH_SIZE) {
		const batch = vectorDocuments.slice(i, i + BATCH_SIZE);
		await vector.upsert(VECTOR_PLAYERS, ...batch);
	}

	// Store available player list in KV
	await kv.set(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS, players, { ttl: null });

	return players;
}
