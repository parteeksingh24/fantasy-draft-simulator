import {
	canDraftPosition,
	type Pick,
	type Player,
	type Position,
	type PersonaShiftDetection,
	type Roster,
} from './types';

// --- Shift detection thresholds ---
// These thresholds are calibrated to ADP-based "spots": ~8 spots equals roughly
// one ADP tier. Minor thresholds catch soft deviations worth surfacing in the UI
// but not alarming. Major thresholds flag picks that clearly contradict the persona's
// stated strategy. Values were tuned empirically across simulated drafts; adjust
// per-persona if shift rates feel too noisy or too quiet.
const POSITION_RUN_WINDOW = 8;
const POSITION_RUN_MIN_COUNT = 3;
const VALUE_DROP_THRESHOLD = 8;
const SCARCITY_THRESHOLD = 5;
const STRONG_VALUE_PIVOT_EDGE = 8;
const BALANCED_MINOR_REACH_THRESHOLD = 10;
const BALANCED_MAJOR_REACH_THRESHOLD = 14;
const BALANCED_MINOR_DROP_THRESHOLD = 10;
const BALANCED_MAJOR_DROP_THRESHOLD = 14;
const BALANCED_MINOR_DROP_GAP = 5;
const BALANCED_MAJOR_DROP_GAP = 8;
const RISK_AVERSE_MINOR_REACH_THRESHOLD = 8;
const RISK_AVERSE_MAJOR_REACH_THRESHOLD = 12;
const VALUE_HUNTER_MINOR_NEGATIVE_VALUE = -4;
const VALUE_HUNTER_MAJOR_NEGATIVE_VALUE = -8;
const VALUE_HUNTER_MINOR_DROP_THRESHOLD = 8;
const VALUE_HUNTER_MAJOR_DROP_THRESHOLD = 10;
const VALUE_HUNTER_MINOR_DROP_GAP = 3;
const VALUE_HUNTER_MAJOR_DROP_GAP = 5;

export interface PositionRun {
	position: Position;
	count: number;
	window: number;
}

export interface ValueDrop {
	player: Player;
	adpDiff: number;
}

export interface ScarcityAlert {
	position: Position;
	remaining: number;
}

export interface BoardAnalysis {
	positionRuns: PositionRun[];
	valueDrops: ValueDrop[];
	scarcity: ScarcityAlert[];
	summary: string;
}

export interface ShiftEvaluationContext {
	eligiblePlayers: Player[];
	eligiblePositions: Set<Position>;
	forcedPosition: Position | null;
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
	const counts = new Map<Position, number>();

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
	const counts = new Map<Position, number>();

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

function getPlayerValue(pickNumber: number, player: Player): number {
	return pickNumber - player.rank;
}

function getBestValueCandidate(pickNumber: number, players: Player[]): Player | null {
	let best: Player | null = null;
	let bestValue = Number.NEGATIVE_INFINITY;

	for (const player of players) {
		const value = getPlayerValue(pickNumber, player);
		if (value > bestValue) {
			best = player;
			bestValue = value;
		}
	}

	return best;
}

function getTopEligibleValueDrop(
	boardAnalysis: BoardAnalysis,
	eligiblePositions: Set<Position>,
): ValueDrop | null {
	for (const drop of boardAnalysis.valueDrops) {
		if (eligiblePositions.has(drop.player.position)) {
			return drop;
		}
	}
	return null;
}

interface CoreStrategyBreakOptions {
	personaLabel: string;
	pick: Pick;
	pickedValue: number | null;
	preferredCandidates: Player[];
	preferredLabel: string;
	majorCategory: PersonaShiftDetection['category'];
}

function classifyCoreStrategyBreak(options: CoreStrategyBreakOptions): PersonaShiftDetection | null {
	const {
		personaLabel,
		pick,
		pickedValue,
		preferredCandidates,
		preferredLabel,
		majorCategory,
	} = options;
	const bestPreferred = getBestValueCandidate(pick.pickNumber, preferredCandidates);

	if (!bestPreferred) {
		return null;
	}

	const bestPreferredValue = getPlayerValue(pick.pickNumber, bestPreferred);
	if (pickedValue !== null) {
		const valueEdge = pickedValue - bestPreferredValue;
		if (valueEdge >= STRONG_VALUE_PIVOT_EDGE) {
			return {
				trigger: `${personaLabel} persona made a one-pick value pivot: drafted ${pick.playerName} (${pick.position}) over in-strategy ${preferredLabel} option ${bestPreferred.name} with a +${valueEdge} value edge.`,
				category: 'value-deviation',
				severity: 'minor',
			};
		}
	}

	return {
		trigger: `${personaLabel} persona broke its core strategy by drafting ${pick.playerName} (${pick.position}) while viable ${preferredLabel} option ${bestPreferred.name} was available.`,
		category: majorCategory,
		severity: 'major',
	};
}

export function buildShiftEvaluationContext(
	roster: Roster,
	availablePlayers: Player[],
): ShiftEvaluationContext {
	const eligiblePlayers = availablePlayers.filter((player) => canDraftPosition(roster, player.position));
	const eligiblePositions = new Set<Position>(eligiblePlayers.map((player) => player.position));
	const forcedPosition = eligiblePositions.size === 1
		? [...eligiblePositions][0] ?? null
		: null;

	return {
		eligiblePlayers,
		eligiblePositions,
		forcedPosition,
	};
}

/**
 * Detect whether a pick represents a strategy shift based on the persona's
 * expected behavior. This replaces brittle keyword matching in LLM reasoning.
 *
 * Returns structured shift metadata if the pick deviates from persona norms,
 * or null if the pick is consistent with the persona.
 */
export function detectPersonaShift(
	persona: string,
	pick: Pick,
	boardAnalysis: BoardAnalysis,
	availablePlayers: Player[],
	shiftContext?: ShiftEvaluationContext,
): PersonaShiftDetection | null {
	const { position } = pick;
	const round = pick.round;
	const pickedPlayer = availablePlayers.find((p) => p.playerId === pick.playerId);
	const pickedValue = pickedPlayer ? pick.pickNumber - pickedPlayer.rank : null;
	const pickedReach = pickedPlayer ? pickedPlayer.rank - pick.pickNumber : null;
	const eligiblePlayers = shiftContext?.eligiblePlayers ?? availablePlayers;
	const eligiblePositions = shiftContext?.eligiblePositions ?? new Set<Position>(eligiblePlayers.map((player) => player.position));
	const forcedPosition = shiftContext?.forcedPosition ?? (
		eligiblePositions.size === 1
			? [...eligiblePositions][0] ?? null
			: null
	);

	// Safety net: record-pick.ts already suppresses forced picks before calling this
	// function, but guard here defensively in case detectPersonaShift is called directly.
	if (forcedPosition && forcedPosition === position) {
		return null;
	}

	const eligibleRuns = boardAnalysis.positionRuns.filter((run) => eligiblePositions.has(run.position));
	const eligibleScarcity = boardAnalysis.scarcity.filter((scarcity) => eligiblePositions.has(scarcity.position));

	switch (persona) {
		case 'drafter-balanced': {
			// Balanced should not make extreme reaches or pass obvious value
			if (pickedReach !== null && pickedReach >= BALANCED_MAJOR_REACH_THRESHOLD) {
				return {
					trigger: `Balanced persona made an aggressive reach for ${pick.playerName} (${pickedReach} spots ahead of rank), deviating from BPA principles.`,
					category: 'value-deviation',
					severity: 'major',
				};
			}

			if (pickedReach !== null && pickedReach >= BALANCED_MINOR_REACH_THRESHOLD) {
				return {
					trigger: `Balanced persona slightly reached for ${pick.playerName} (${pickedReach} spots ahead of rank), nudging away from BPA discipline.`,
					category: 'value-deviation',
					severity: 'minor',
				};
			}

			const topDrop = getTopEligibleValueDrop(boardAnalysis, eligiblePositions);
			if (
				topDrop
				&& topDrop.player.playerId !== pick.playerId
				&& pickedValue !== null
			) {
				const dropGap = topDrop.adpDiff - pickedValue;
				if (
					topDrop.adpDiff >= BALANCED_MAJOR_DROP_THRESHOLD
					&& dropGap >= BALANCED_MAJOR_DROP_GAP
				) {
					return {
						trigger: `Balanced persona passed on a major eligible value drop (${topDrop.player.name}, +${topDrop.adpDiff}) to draft ${pick.playerName} with clearly lower value.`,
						category: 'value-deviation',
						severity: 'major',
					};
				}

				if (
					topDrop.adpDiff >= BALANCED_MINOR_DROP_THRESHOLD
					&& dropGap >= BALANCED_MINOR_DROP_GAP
				) {
					return {
						trigger: `Balanced persona bypassed an eligible value pocket (${topDrop.player.name}, +${topDrop.adpDiff}) for ${pick.playerName}, signaling a light tactical pivot.`,
						category: 'value-deviation',
						severity: 'minor',
					};
				}
			}
			break;
		}

		case 'drafter-bold': {
			// Bold should lean into upside over conservative veteran picks
			if (pickedPlayer && round <= 3 && pickedPlayer.age >= 29 && (pickedValue ?? 0) < 8) {
				// Don't flag if no young eligible alternative existed
				const hasYoungAlternative = eligiblePlayers.some((p) => p.age < 29);
				if (!hasYoungAlternative) break;
				const isMajor = pickedPlayer.age >= 31 && (pickedValue ?? 0) < 4;
				return {
					trigger: `Bold persona drafted older, safer profile ${pick.playerName} (age ${pickedPlayer.age}) without a major value discount.`,
					category: 'strategy-break',
					severity: isMajor ? 'major' : 'minor',
				};
			}
			break;
		}

		case 'drafter-stack-builder': {
			// Stack-builder should secure a QB anchor early while elite QBs remain
			if (position !== 'QB' && round <= 2) {
				const eliteQBs = eligiblePlayers.filter((p) => p.position === 'QB' && p.rank <= 18);
				return classifyCoreStrategyBreak({
					personaLabel: 'Stack-builder',
					pick,
					pickedValue,
					preferredCandidates: eliteQBs,
					preferredLabel: 'elite QB',
					majorCategory: 'positional-pivot',
				});
			}
			break;
		}

		case 'drafter-zero-rb': {
			// Zero-RB should avoid RBs in rounds 1-3
			if (position === 'RB' && round <= 3) {
				const nonRBAlternatives = eligiblePlayers.filter((player) => player.position !== 'RB');
				return classifyCoreStrategyBreak({
					personaLabel: 'Zero-RB',
					pick,
					pickedValue,
					preferredCandidates: nonRBAlternatives,
					preferredLabel: 'non-RB',
					majorCategory: 'strategy-break',
				});
			}
			break;
		}

		case 'drafter-qb-first': {
			// QB-first should take QBs when available
			if (position !== 'QB' && round <= 2) {
				const qbsAvailable = eligiblePlayers.filter((p) => p.position === 'QB');
				return classifyCoreStrategyBreak({
					personaLabel: 'QB-first',
					pick,
					pickedValue,
					preferredCandidates: qbsAvailable,
					preferredLabel: 'QB',
					majorCategory: 'strategy-break',
				});
			}
			break;
		}

		case 'drafter-stud-rb': {
			// Stud-RB should draft RBs in round 1
			if (position !== 'RB' && round === 1) {
				const rbsAvailable = eligiblePlayers.filter((p) => p.position === 'RB');
				return classifyCoreStrategyBreak({
					personaLabel: 'Stud-RB',
					pick,
					pickedValue,
					preferredCandidates: rbsAvailable,
					preferredLabel: 'RB',
					majorCategory: 'strategy-break',
				});
			}
			break;
		}

		case 'drafter-te-premium': {
			// TE-premium should draft TEs early when elite ones are available
			if (position !== 'TE' && round <= 2) {
				const eliteTEs = eligiblePlayers.filter((p) => p.position === 'TE' && p.tier <= 2);
				return classifyCoreStrategyBreak({
					personaLabel: 'TE-premium',
					pick,
					pickedValue,
					preferredCandidates: eliteTEs,
					preferredLabel: 'elite TE',
					majorCategory: 'strategy-break',
				});
			}
			break;
		}

		case 'drafter-contrarian': {
			// Contrarian should go against position runs, not join them
			const activeRuns = eligibleRuns.filter(
				(r) => r.count >= 4 || (r.window >= 6 && r.count / r.window >= 0.5),
			);
			const joinedRun = activeRuns.find((r) => r.position === position);
			if (joinedRun) {
				const hasAlternative = eligiblePlayers.some((player) => player.position !== position);
				if (!hasAlternative) break;
				return {
					trigger: `Contrarian joined a ${position} run (${joinedRun.count} of last ${joinedRun.window} picks) instead of going against the grain.`,
					category: 'trend-follow',
					severity: joinedRun.count >= 5 ? 'major' : 'minor',
				};
			}
			break;
		}

		case 'drafter-youth-movement': {
			// Youth movement should avoid old players
			if (pickedPlayer) {
				// Don't flag if no young eligible alternative existed
				const hasYoungAlternative = eligiblePlayers.some((p) => p.age < 28);
				if (!hasYoungAlternative) break;

				if (pickedPlayer.age >= 30) {
					return {
						trigger: `Youth-movement persona drafted ${pick.playerName} (age ${pickedPlayer.age}), breaking their preference for young players.`,
						category: 'strategy-break',
						severity: 'major',
					};
				}

				if (pickedPlayer.age >= 28) {
					return {
						trigger: `Youth-movement persona drafted ${pick.playerName} (age ${pickedPlayer.age}), a mild departure from its youth-first bias.`,
						category: 'strategy-break',
						severity: 'minor',
					};
				}
			}
			break;
		}

		case 'drafter-risk-averse': {
			// Risk-averse should not reach far past rank
			if (pickedReach !== null) {
				if (pickedReach > RISK_AVERSE_MAJOR_REACH_THRESHOLD) {
					return {
						trigger: `Risk-averse persona reached for ${pick.playerName} (Rank ${pickedPlayer!.rank} at pick ${pick.pickNumber}, a ${pickedReach}-spot reach).`,
						category: 'value-deviation',
						severity: 'major',
					};
				}

				if (pickedReach > RISK_AVERSE_MINOR_REACH_THRESHOLD) {
					return {
						trigger: `Risk-averse persona made a moderate reach for ${pick.playerName} (${pickedReach} spots ahead of rank), slightly increasing volatility.`,
						category: 'value-deviation',
						severity: 'minor',
					};
				}
			}
			break;
		}

		case 'drafter-value-hunter': {
			// Value hunter should pick the biggest value drop, not reach
			if (pickedPlayer) {
				const value = pick.pickNumber - pickedPlayer.rank;
				if (value < VALUE_HUNTER_MAJOR_NEGATIVE_VALUE) {
					return {
						trigger: `Value-hunter reached for ${pick.playerName} (Rank ${pickedPlayer.rank} at pick ${pick.pickNumber}, negative value).`,
						category: 'value-deviation',
						severity: 'major',
					};
				}

				if (value < VALUE_HUNTER_MINOR_NEGATIVE_VALUE) {
					return {
						trigger: `Value-hunter took ${pick.playerName} at slight negative value (Rank ${pickedPlayer.rank} at pick ${pick.pickNumber}), a softer deviation from value-first behavior.`,
						category: 'value-deviation',
						severity: 'minor',
					};
				}

				const topDrop = getTopEligibleValueDrop(boardAnalysis, eligiblePositions);
				if (topDrop && topDrop.player.playerId !== pick.playerId) {
					const dropGap = topDrop.adpDiff - value;
					if (topDrop.adpDiff >= VALUE_HUNTER_MAJOR_DROP_THRESHOLD && dropGap >= VALUE_HUNTER_MAJOR_DROP_GAP) {
						return {
							trigger: `Value-hunter passed on top eligible value drop ${topDrop.player.name} (+${topDrop.adpDiff}) for a lower-value option.`,
							category: 'value-deviation',
							severity: 'major',
						};
					}

					if (topDrop.adpDiff >= VALUE_HUNTER_MINOR_DROP_THRESHOLD && dropGap >= VALUE_HUNTER_MINOR_DROP_GAP) {
						return {
							trigger: `Value-hunter bypassed eligible drop ${topDrop.player.name} (+${topDrop.adpDiff}) and made a minor tactical pivot.`,
							category: 'value-deviation',
							severity: 'minor',
						};
					}
				}
			}
			break;
		}

		case 'drafter-reactive': {
			// Reactive's normal behavior is following trends. A shift is when they DON'T follow.
			const sortedRuns = [...eligibleRuns].sort((a, b) => b.count - a.count);
			const dominantRun = sortedRuns[0];
			const runnerUpRun = sortedRuns[1];
			const hasDominantRun = !!(
				dominantRun
				&& dominantRun.count >= 4
				&& (!runnerUpRun || dominantRun.count - runnerUpRun.count >= 1)
			);
			const topDrop = getTopEligibleValueDrop(boardAnalysis, eligiblePositions);
			const hasMajorDrop = !!(topDrop && topDrop.adpDiff >= 10);
			const hasMinorDrop = !!(topDrop && topDrop.adpDiff >= 8);
			const urgentScarcity = eligibleScarcity.filter((s) => s.remaining <= 3);

			// If there's a dominant position run but they picked a different position
			if (hasDominantRun && dominantRun.position !== position) {
				return {
					trigger: `Reactive persona ignored a dominant ${dominantRun.position} run (${dominantRun.count} of last ${dominantRun.window} picks) and drafted ${pick.playerName} (${position}).`,
					category: 'trend-fade',
					severity: 'major',
				};
			}

			// If there's a major value drop but they picked someone with clearly less value
			if (!hasDominantRun && topDrop && (hasMajorDrop || hasMinorDrop)) {
				const pickedTheDrop = topDrop.player.playerId === pick.playerId;
				if (!pickedTheDrop) {
					// pickedValue is null when the picked player wasn't found in availablePlayers
					// (should not happen in normal flow, but handle defensively)
					if (pickedValue === null) {
						return {
							trigger: `Reactive persona passed on ${topDrop.player.name} (${topDrop.player.position}, fallen ${topDrop.adpDiff} spots) to draft ${pick.playerName} instead.`,
							category: 'value-deviation',
							severity: hasMajorDrop ? 'major' : 'minor',
						};
					}

					const dropGap = topDrop.adpDiff - pickedValue;
					if (hasMajorDrop && dropGap >= 6) {
						return {
							trigger: `Reactive persona passed on ${topDrop.player.name} (${topDrop.player.position}, fallen ${topDrop.adpDiff} spots) to draft ${pick.playerName} instead.`,
							category: 'value-deviation',
							severity: 'major',
						};
					}

					if (dropGap >= 3) {
						return {
							trigger: `Reactive persona faded an eligible value signal (${topDrop.player.name}, +${topDrop.adpDiff}) for ${pick.playerName}.`,
							category: 'value-deviation',
							severity: 'minor',
						};
					}
				}
			}

			// If urgent scarcity alert but they drafted a non-scarce position
			if (!hasDominantRun && !hasMinorDrop && urgentScarcity.length > 0) {
				const scarcePositions = urgentScarcity.map((s) => s.position);
				if (!scarcePositions.includes(position)) {
					return {
						trigger: `Reactive persona ignored scarcity alerts at ${scarcePositions.join(', ')} and drafted ${pick.playerName} (${position}).`,
						category: 'trend-fade',
						severity: urgentScarcity.length > 1 ? 'major' : 'minor',
					};
				}
			}
			break;
		}

		// Unrecognized personas are not evaluated for shifts. If adding a new
		// persona, add a case above to enable shift detection for it.
		default:
			break;
	}

	return null;
}
