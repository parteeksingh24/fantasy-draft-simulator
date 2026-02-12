import type { Pick, Player } from './types';

// --- Detection result types ---

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
export function detectPositionRuns(picks: Pick[], windowSize = 5): PositionRun[] {
	if (picks.length === 0) return [];

	const window = picks.slice(-windowSize);
	const counts = new Map<string, number>();

	for (const pick of window) {
		counts.set(pick.position, (counts.get(pick.position) ?? 0) + 1);
	}

	const runs: PositionRun[] = [];
	for (const [position, count] of counts) {
		if (count >= 3) {
			runs.push({ position, count, window: window.length });
		}
	}

	return runs;
}

/**
 * Detect value drops: players whose ADP is much lower (better) than the current pick number.
 * A player with ADP 10 still available at pick 25 has "dropped" 15 spots, a significant value.
 *
 * @param availablePlayers - Players still on the board
 * @param pickNumber - The current overall pick number
 * @param threshold - Minimum ADP difference to flag (default 10)
 * @returns Players sorted by biggest drop first
 */
export function detectValueDrops(
	availablePlayers: Player[],
	pickNumber: number,
	threshold = 10,
): ValueDrop[] {
	const drops: ValueDrop[] = [];

	for (const player of availablePlayers) {
		const adpDiff = pickNumber - player.adp;
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
		if (remaining <= 5) {
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
			.map((d) => `${d.player.name} (${d.player.position}, ADP ${d.player.adp}, fallen ${d.adpDiff} spots)`)
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
