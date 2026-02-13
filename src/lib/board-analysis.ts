import type { Pick, Player } from './types';

// --- Detection result types ---
const POSITION_RUN_WINDOW = 8;
const POSITION_RUN_MIN_COUNT = 3;
const VALUE_DROP_THRESHOLD = 8;
const SCARCITY_THRESHOLD = 5;

export interface PositionRun {
	position: string;
	count: number;
	window: number;
}

export interface ValueDrop {
	player: Player;
	adpDiff: number;
}

export interface ScarcityAlert {
	position: string;
	remaining: number;
}

export interface BoardAnalysis {
	positionRuns: PositionRun[];
	valueDrops: ValueDrop[];
	scarcity: ScarcityAlert[];
	summary: string;
}

/**
 * Detect position runs in recent picks.
 * A "run" occurs when 3 or more picks within the last N picks share the same position,
 * signaling that teams are racing to fill that position.
 */
export function detectPositionRuns(
	picks: Pick[],
	windowSize = POSITION_RUN_WINDOW,
	minRunCount = POSITION_RUN_MIN_COUNT,
): PositionRun[] {
	if (picks.length === 0) return [];

	const window = picks.slice(-windowSize);
	const counts = new Map<string, number>();

	for (const pick of window) {
		counts.set(pick.position, (counts.get(pick.position) ?? 0) + 1);
	}

	const runs: PositionRun[] = [];
	for (const [position, count] of counts) {
		if (count >= minRunCount) {
			runs.push({ position, count, window: window.length });
		}
	}

	return runs;
}

/**
 * Detect value drops: players whose rank is much lower (better) than the current pick number.
 * A player with Rank 10 still available at pick 25 has "dropped" 15 spots, a significant value.
 *
 * @param availablePlayers - Players still on the board
 * @param pickNumber - The current overall pick number
 * @param threshold - Minimum rank difference to flag (default 8)
 * @returns Players sorted by biggest drop first
 */
export function detectValueDrops(
	availablePlayers: Player[],
	pickNumber: number,
	threshold = VALUE_DROP_THRESHOLD,
): ValueDrop[] {
	const drops: ValueDrop[] = [];

	for (const player of availablePlayers) {
		const adpDiff = pickNumber - player.rank;
		if (adpDiff >= threshold) {
			drops.push({ player, adpDiff });
		}
	}

	// Sort by biggest drop first
	drops.sort((a, b) => b.adpDiff - a.adpDiff);
	return drops;
}

/**
 * Detect position scarcity: positions with 5 or fewer remaining players.
 * When a position pool is drying up, teams may need to act quickly or pivot.
 */
export function detectScarcity(availablePlayers: Player[]): ScarcityAlert[] {
	const counts = new Map<string, number>();

	for (const player of availablePlayers) {
		counts.set(player.position, (counts.get(player.position) ?? 0) + 1);
	}

	const scarce: ScarcityAlert[] = [];
	for (const [position, remaining] of counts) {
		if (remaining <= SCARCITY_THRESHOLD) {
			scarce.push({ position, remaining });
		}
	}

	// Sort by most scarce first
	scarce.sort((a, b) => a.remaining - b.remaining);
	return scarce;
}

/**
 * Run all board analysis detections and produce a structured result with a human-readable summary.
 * This summary is injected into drafter prompts so agents can react to board dynamics.
 */
export function analyzeBoardState(
	picks: Pick[],
	availablePlayers: Player[],
	pickNumber: number,
): BoardAnalysis {
	const positionRuns = detectPositionRuns(picks);
	const valueDrops = detectValueDrops(availablePlayers, pickNumber);
	const scarcity = detectScarcity(availablePlayers);

	// Build human-readable summary
	const parts: string[] = [];

	if (positionRuns.length > 0) {
		const runDescriptions = positionRuns
			.map((r) => `${r.position} (${r.count} of last ${r.window} picks)`)
			.join(', ');
		parts.push(`POSITION RUN: Teams are rushing to draft ${runDescriptions}. Consider whether to join the run or exploit the value elsewhere.`);
	}

	if (valueDrops.length > 0) {
		// Show top 3 value drops to keep the prompt focused
		const topDrops = valueDrops.slice(0, 3);
		const dropDescriptions = topDrops
			.map((d) => `${d.player.name} (${d.player.position}, Rank ${d.player.rank}, fallen ${d.adpDiff} spots)`)
			.join('; ');
		parts.push(`VALUE DROPS: ${dropDescriptions}. These players have fallen well past their expected draft position.`);
	}

	if (scarcity.length > 0) {
		const scarcityDescriptions = scarcity
			.map((s) => `${s.position} (${s.remaining} left)`)
			.join(', ');
		parts.push(`SCARCITY ALERT: ${scarcityDescriptions}. These positions are drying up fast.`);
	}

	const summary = parts.length > 0
		? `Board Analysis:\n${parts.join('\n')}`
		: 'Board Analysis: No significant trends detected. Draft as planned.';

	return { positionRuns, valueDrops, scarcity, summary };
}

// --- Behavior-based strategy shift detection ---

export interface StrategyShift {
	pickNumber: number;
	teamIndex: number;
	persona: string;
	trigger: string;
	reasoning: string;
	playerPicked: string;
	position: string;
}

/**
 * Detect whether a pick represents a strategy shift based on the persona's
 * expected behavior. This replaces brittle keyword matching in LLM reasoning.
 *
 * Returns a shift description string if the pick deviates from persona norms,
 * or null if the pick is consistent with the persona.
 */
export function detectPersonaShift(
	persona: string,
	pick: Pick,
	boardAnalysis: BoardAnalysis,
	availablePlayers: Player[],
): string | null {
	const { position } = pick;
	const round = pick.round;
	const pickedPlayer = availablePlayers.find((p) => p.playerId === pick.playerId);
	const pickedValue = pickedPlayer ? pick.pickNumber - pickedPlayer.rank : null;
	const pickedReach = pickedPlayer ? pickedPlayer.rank - pick.pickNumber : null;

	switch (persona) {
		case 'drafter-balanced': {
			// Balanced should not make extreme reaches or pass obvious value
			if (pickedReach !== null && pickedReach >= 14) {
				return `Balanced persona made an aggressive reach for ${pick.playerName} (${pickedReach} spots ahead of rank), deviating from BPA principles.`;
			}

			const topDrop = boardAnalysis.valueDrops[0];
			if (
				topDrop
				&& topDrop.adpDiff >= 14
				&& topDrop.player.playerId !== pick.playerId
				&& pickedValue !== null
				&& pickedValue <= 0
			) {
				return `Balanced persona passed on a major value drop (${topDrop.player.name}, +${topDrop.adpDiff}) to draft ${pick.playerName} with neutral/negative value.`;
			}
			break;
		}

		case 'drafter-bold':
			// Bold should lean into upside over conservative veteran picks
			if (pickedPlayer && round <= 3 && pickedPlayer.age >= 29 && (pickedValue ?? 0) < 8) {
				return `Bold persona drafted older, safer profile ${pick.playerName} (age ${pickedPlayer.age}) without a major value discount.`;
			}
			break;

		case 'drafter-stack-builder': {
			// Stack-builder should secure a QB anchor early while elite QBs remain
			if (position !== 'QB' && round <= 2) {
				const eliteQBs = availablePlayers.filter((p) => p.position === 'QB' && p.rank <= 18);
				if (eliteQBs.length > 0) {
					return `Stack-builder persona passed on elite QB options to draft ${pick.playerName} (${position}) in round ${round}, delaying stack setup.`;
				}
			}
			break;
		}

		case 'drafter-zero-rb':
			// Zero-RB should avoid RBs in rounds 1-3
			if (position === 'RB' && round <= 3) {
				return `Zero-RB persona drafted an RB (${pick.playerName}) in round ${round}, breaking their core strategy.`;
			}
			break;

		case 'drafter-qb-first':
			// QB-first should take QBs when available
			if (position !== 'QB' && round <= 2) {
				const qbsAvailable = availablePlayers.filter((p) => p.position === 'QB');
				if (qbsAvailable.length > 0) {
					return `QB-first persona passed on available QBs to draft ${pick.playerName} (${position}) in round ${round}.`;
				}
			}
			break;

		case 'drafter-stud-rb':
			// Stud-RB should draft RBs in round 1
			if (position !== 'RB' && round === 1) {
				return `Stud-RB persona drafted a ${position} (${pick.playerName}) instead of an RB in round 1.`;
			}
			break;

		case 'drafter-te-premium':
			// TE-premium should draft TEs early when elite ones are available
			if (position !== 'TE' && round <= 2) {
				const eliteTEs = availablePlayers.filter((p) => p.position === 'TE' && p.tier <= 2);
				if (eliteTEs.length > 0) {
					return `TE-premium persona passed on elite TEs to draft ${pick.playerName} (${position}) in round ${round}.`;
				}
			}
			break;

		case 'drafter-contrarian': {
			// Contrarian should go against position runs, not join them
			const activeRuns = boardAnalysis.positionRuns.filter(
				(r) => r.count >= 4 || (r.window >= 6 && r.count / r.window >= 0.5),
			);
			const joinedRun = activeRuns.find((r) => r.position === position);
			if (joinedRun) {
				return `Contrarian joined a ${position} run (${joinedRun.count} of last ${joinedRun.window} picks) instead of going against the grain.`;
			}
			break;
		}

		case 'drafter-youth-movement': {
			// Youth movement should avoid old players
			if (pickedPlayer && pickedPlayer.age >= 28) {
				return `Youth-movement persona drafted ${pick.playerName} (age ${pickedPlayer.age}), breaking their preference for young players.`;
			}
			break;
		}

		case 'drafter-risk-averse': {
			// Risk-averse should not reach far past rank
			if (pickedPlayer) {
				const reach = pickedPlayer.rank - pick.pickNumber;
				if (reach > 10) {
					return `Risk-averse persona reached for ${pick.playerName} (Rank ${pickedPlayer.rank} at pick ${pick.pickNumber}, a ${reach}-spot reach).`;
				}
			}
			break;
		}

		case 'drafter-value-hunter': {
			// Value hunter should pick the biggest value drop, not reach
			if (pickedPlayer) {
				const value = pick.pickNumber - pickedPlayer.rank;
				if (value < -5) {
					return `Value-hunter reached for ${pick.playerName} (Rank ${pickedPlayer.rank} at pick ${pick.pickNumber}, negative value).`;
				}
			}
			break;
		}

		case 'drafter-reactive': {
			// Reactive's normal behavior is following trends. A shift is when they DON'T follow.
			const sortedRuns = [...boardAnalysis.positionRuns].sort((a, b) => b.count - a.count);
			const dominantRun = sortedRuns[0];
			const runnerUpRun = sortedRuns[1];
			const hasDominantRun = !!(
				dominantRun
				&& dominantRun.count >= 4
				&& (!runnerUpRun || dominantRun.count - runnerUpRun.count >= 1)
			);
			const topDrop = boardAnalysis.valueDrops[0];
			const hasMajorDrop = !!(topDrop && topDrop.adpDiff >= 10);
			const urgentScarcity = boardAnalysis.scarcity.filter((s) => s.remaining <= 3);

			// If there's a dominant position run but they picked a different position
			if (hasDominantRun && dominantRun.position !== position) {
				return `Reactive persona ignored a dominant ${dominantRun.position} run (${dominantRun.count} of last ${dominantRun.window} picks) and drafted ${pick.playerName} (${position}).`;
			}

			// If there's a major value drop but they picked someone with clearly less value
			if (!hasDominantRun && hasMajorDrop && topDrop) {
				const pickedTheDrop = topDrop.player.playerId === pick.playerId;
				if (!pickedTheDrop) {
					const pickedIsCloseValue = pickedValue !== null && pickedValue >= topDrop.adpDiff - 6;
					if (pickedIsCloseValue) break;
					return `Reactive persona passed on ${topDrop.player.name} (${topDrop.player.position}, fallen ${topDrop.adpDiff} spots) to draft ${pick.playerName} instead.`;
				}
			}

			// If urgent scarcity alert but they drafted a non-scarce position
			if (!hasDominantRun && !hasMajorDrop && urgentScarcity.length > 0) {
				const scarcePositions = urgentScarcity.map((s) => s.position);
				if (!scarcePositions.includes(position)) {
					return `Reactive persona ignored scarcity alerts at ${scarcePositions.join(', ')} and drafted ${pick.playerName} (${position}).`;
				}
			}
			break;
		}
	}

	return null;
}
