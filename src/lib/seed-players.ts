import type { KeyValueStorage } from '@agentuity/core';
import {
	type Player,
	KV_DRAFT_STATE,
	KEY_AVAILABLE_PLAYERS,
} from './types';
import { SLEEPER_BLOCKLIST } from './sleeper-blocklist';

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

// Keep bye weeks keyed by NFL season year so updates are localized.
// If the current season is not listed yet, we fall back to the latest known season map.
const FALLBACK_BYE_WEEK_SEASON = 2025;
const BYE_WEEKS_BY_SEASON: Record<number, Record<string, number>> = {
	2025: {
		ARI: 11, ATL: 12, BAL: 14, BUF: 12,
		CAR: 11, CHI: 7, CIN: 12, CLE: 10,
		DAL: 7, DEN: 14, DET: 9, GB: 10,
		HOU: 14, IND: 14, JAX: 12, KC: 6,
		LAC: 5, LAR: 6, LV: 10, MIA: 6,
		MIN: 6, NE: 14, NO: 12, NYG: 11,
		NYJ: 12, PHI: 7, PIT: 9, SEA: 10,
		SF: 9, TB: 11, TEN: 5, WAS: 14,
	},
};

const DEFAULT_BYE_WEEK = 8;
const SLEEPER_API_URL = 'https://api.sleeper.app/v1/players/nfl';
const VALID_POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
const TOP_N_PLAYERS = 150;
const SLEEPER_FETCH_TIMEOUT_MS = 8000;
const SLEEPER_FETCH_RETRIES = 2;
const SLEEPER_RETRY_BASE_DELAY_MS = 400;

// Statuses that indicate a player is not fantasy-draftable.
// Sleeper's `active: true` + `status === 'Active'` lets some stale entries through;
// this denylist catches additional non-draftable states.
const STATUS_DENYLIST = new Set([
	'inactive',
	'retired',
	'voluntarily retired',
	'reserve/retired',
]);

function getLikelyNflSeasonYear(date = new Date()): number {
	// Jan/Feb generally still map to the previous NFL season context.
	const month = date.getUTCMonth() + 1;
	const year = date.getUTCFullYear();
	return month <= 2 ? year - 1 : year;
}

function resolveByeWeek(team: string, seasonYear = getLikelyNflSeasonYear()): number {
	const seasonMap = BYE_WEEKS_BY_SEASON[seasonYear]
		?? BYE_WEEKS_BY_SEASON[FALLBACK_BYE_WEEK_SEASON];
	if (!seasonMap) return DEFAULT_BYE_WEEK;
	return seasonMap[team] ?? DEFAULT_BYE_WEEK;
}

function isValidPosition(position: string): position is (typeof VALID_POSITIONS)[number] {
	return VALID_POSITIONS.includes(position as (typeof VALID_POSITIONS)[number]);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch all players from Sleeper API and filter to fantasy-relevant players.
 */
async function fetchSleeperPlayers(): Promise<SleeperPlayer[]> {
	let lastError: unknown;

	for (let attempt = 0; attempt <= SLEEPER_FETCH_RETRIES; attempt++) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), SLEEPER_FETCH_TIMEOUT_MS);

		try {
			const response = await fetch(SLEEPER_API_URL, { signal: controller.signal });

			if (!response.ok) {
				throw new Error(`Sleeper API error: ${response.status} ${response.statusText}`);
			}

			const data: SleeperResponse = await response.json();

			return Object.values(data)
				.filter((p) => {
					// Must be a valid fantasy position
					if (!isValidPosition(p.position)) return false;

					// Must be active
					if (!p.active) return false;

					// Check status against denylist (catches more phantom entries)
					if (p.status && STATUS_DENYLIST.has(p.status.trim().toLowerCase())) return false;

					// Exclude known phantom players
					if (SLEEPER_BLOCKLIST.has(p.player_id)) return false;

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
		} catch (error) {
			lastError = error;
			if (attempt < SLEEPER_FETCH_RETRIES) {
				await sleep(SLEEPER_RETRY_BASE_DELAY_MS * (attempt + 1));
			}
		} finally {
			clearTimeout(timeout);
		}
	}

	const message = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`Sleeper API request failed after ${SLEEPER_FETCH_RETRIES + 1} attempts: ${message}`);
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
function mapSleeperToPlayer(sleeperPlayer: SleeperPlayer): Player {
	const team = sleeperPlayer.team || 'FA';
	const byeWeek = resolveByeWeek(team);
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
 * Seed players into KV storage.
 *
 * KV stores the available player list (source of truth for availability).
 *
 * @param kv - KeyValue storage interface
 * @returns Array of seeded players
 */
export async function seedPlayers(kv: KeyValueStorage): Promise<Player[]> {
	// Fetch players from Sleeper API
	const sleeperPlayers = await fetchSleeperPlayers();

	if (sleeperPlayers.length === 0) {
		throw new Error('No players fetched from Sleeper API');
	}

	// Map to our Player type
	const players = sleeperPlayers.map((sp) => mapSleeperToPlayer(sp));

	// Store available player list and seed timestamp in KV
	await Promise.all([
		kv.set(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS, players, { ttl: null }),
		kv.set(KV_DRAFT_STATE, 'seeded-at', Date.now(), { ttl: null }),
	]);

	return players;
}
