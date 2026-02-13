import Markdown from 'react-markdown';
import { cn } from '../lib/utils';
import type { BoardState, Pick, Position, StrategyShift, PersonaAssignment } from '../lib/types';
import { NUM_TEAMS, NUM_ROUNDS, TEAM_NAMES, POSITION_COLORS, PERSONA_DISPLAY_NAMES, PERSONA_DESCRIPTIONS, PERSONA_MODELS } from '../lib/types';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Badge } from './ui/badge';

interface DraftBoardProps {
	board: BoardState | null;
	humanTeamIndex: number;
	personas: PersonaAssignment[] | null;
	shifts: StrategyShift[];
}

export function DraftBoard({ board, humanTeamIndex, personas, shifts }: DraftBoardProps) {
	// Build a lookup map: `${round}-${teamIndex}` -> Pick
	const pickMap = new Map<string, Pick>();
	if (board) {
		for (const pick of board.picks) {
			pickMap.set(`${pick.round}-${pick.teamIndex}`, pick);
		}
	}

	// Build shift lookup: pickNumber -> StrategyShift
	const shiftMap = new Map<number, StrategyShift>();
	for (const shift of shifts) {
		shiftMap.set(shift.pickNumber, shift);
	}

	function getPersonaForTeam(teamIndex: number): string {
		if (!personas) return '';
		const assignment = personas.find((p) => p.teamIndex === teamIndex);
		if (!assignment) return '';
		return PERSONA_DISPLAY_NAMES[assignment.persona] ?? assignment.persona;
	}

	function getPersonaKeyForTeam(teamIndex: number): string {
		if (!personas) return '';
		const assignment = personas.find((p) => p.teamIndex === teamIndex);
		return assignment?.persona ?? '';
	}

	// Check if a cell is the current on-the-clock pick
	function isOnTheClock(round: number, teamIndex: number): boolean {
		if (!board || board.draftComplete) return false;
		return board.currentPick.round === round && board.currentPick.teamIndex === teamIndex;
	}

	return (
		<div className="relative">
			{/* Column headers */}
			<div
				className="grid gap-1 mb-1"
				style={{ gridTemplateColumns: `64px repeat(${NUM_TEAMS}, minmax(0, 1fr))` }}
			>
				<div className="text-sm text-gray-600 font-medium px-1 py-2 text-center">
					Round
				</div>
				{Array.from({ length: NUM_TEAMS }, (_, i) => {
					const isHuman = i === humanTeamIndex;
					const persona = getPersonaForTeam(i);
					const personaKey = getPersonaKeyForTeam(i);
					const description = PERSONA_DESCRIPTIONS[personaKey] ?? '';
					const modelName = PERSONA_MODELS[personaKey] ?? '';

					return (
						<Tooltip key={i} delayDuration={0}>
							<TooltipTrigger asChild>
								<div
									className={cn(
										'text-sm font-medium px-1 py-3 text-center rounded-t-md truncate cursor-pointer',
										isHuman
											? 'bg-cyan-500/15 text-cyan-400 border-t border-x border-cyan-500/30'
											: 'text-gray-500 hover:bg-gray-800/40',
									)}
								>
									<div className="truncate">{TEAM_NAMES[i]}</div>
									{persona && (() => {
										const teamHasShift = shifts.some((s) => s.teamIndex === i);
										return (
											<div className={cn(
												'text-xs truncate mt-0.5 flex items-center gap-0.5 justify-center',
												isHuman ? 'text-cyan-500/70' : 'text-gray-600',
											)}>
												{persona}
												{teamHasShift && (
													<span className="inline-flex w-3.5 h-3.5 rounded-full bg-yellow-500 text-black text-[8px] font-bold items-center justify-center flex-shrink-0" title="Strategy shifted">!</span>
												)}
											</div>
										);
									})()}
								</div>
							</TooltipTrigger>
							{(description || isHuman) && (
								<TooltipContent side="top" sideOffset={8} className="bg-gray-900 border border-gray-700 text-white max-w-xs p-3">
									{/* Team name header */}
									<div className="flex items-center gap-2 mb-2">
										<span className="text-xs font-semibold text-white">{TEAM_NAMES[i]}</span>
										{isHuman && (
											<Badge className="text-[9px] bg-cyan-500/15 border-cyan-500/30 text-cyan-400 h-auto py-0 px-1.5">
												You
											</Badge>
										)}
									</div>

									{/* Persona and model info */}
									{persona && !isHuman && (
										<div className="space-y-1.5 mb-2">
											<div className="flex items-center justify-between">
												<span className="text-xs text-gray-500">Strategy</span>
												<Badge variant="secondary" className="text-xs h-auto py-0.5">
													{persona}
												</Badge>
											</div>
											{modelName && (
												<div className="flex items-center justify-between">
													<span className="text-xs text-gray-500">Model</span>
													<span className="text-xs text-gray-400 font-mono">
														{modelName}
													</span>
												</div>
											)}
										</div>
									)}

									{/* Description */}
									{description && (
										<p className="text-xs text-gray-400 leading-relaxed">
											{description}
										</p>
									)}
								</TooltipContent>
							)}
						</Tooltip>
					);
				})}
			</div>

			{/* Draft grid rows */}
			{Array.from({ length: NUM_ROUNDS }, (_, roundIdx) => {
				const round = roundIdx + 1;
				return (
					<div
						key={round}
						className="grid gap-1 mb-1"
						style={{ gridTemplateColumns: `64px repeat(${NUM_TEAMS}, minmax(0, 1fr))` }}
					>
						{/* Round label */}
						<div className="flex items-center justify-center text-sm text-gray-600 font-mono">
							R{round}
						</div>

						{/* Team cells for this round */}
						{Array.from({ length: NUM_TEAMS }, (_, teamIdx) => {
							const pick = pickMap.get(`${round}-${teamIdx}`);
							const onClock = isOnTheClock(round, teamIdx);
							const isHumanCol = teamIdx === humanTeamIndex;
							const pickShift = pick ? shiftMap.get(pick.pickNumber) : undefined;

							if (pick) {
								const colors = POSITION_COLORS[pick.position as Position];
								return (
									<Tooltip key={teamIdx} delayDuration={300}>
										<TooltipTrigger asChild>
											<div
												className={cn(
													'relative rounded-md px-2 py-2 cursor-pointer transition-all duration-150',
													'border',
													colors.bg,
													colors.border,
													isHumanCol && 'ring-1 ring-cyan-500/20',
													'hover:brightness-125 hover:scale-[1.02]',
												)}
											>
												<div className={cn('text-sm font-semibold truncate', colors.text)}>
													{pick.playerName}
												</div>
												<div className="flex items-center justify-between mt-0.5">
													<span className={cn('text-xs font-mono', colors.text)}>
														{pick.position}
													</span>
													<span className="text-xs text-gray-600">
														#{pick.pickNumber}
													</span>
												</div>
												{/* Strategy shift indicator */}
												{pickShift && (
													<div
														className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-yellow-500 text-black text-[10px] font-bold flex items-center justify-center"
													>
														!
													</div>
												)}
											</div>
										</TooltipTrigger>
										<TooltipContent
											side="top"
											className="bg-gray-900 border border-gray-700 text-white max-w-xs p-3 pointer-events-auto"
										>
											{/* Player header */}
											<div className="flex items-center gap-2 mb-2">
												<span className={cn(
													'text-xs font-mono px-1.5 py-0.5 rounded',
													colors.bg, colors.text, colors.border, 'border',
												)}>
													{pick.position}
												</span>
												<span className="text-sm font-semibold text-white">
													{pick.playerName}
												</span>
											</div>

											{/* Meta info */}
											<div className="flex items-center gap-3 text-xs text-gray-400 mb-2">
												<span>{TEAM_NAMES[pick.teamIndex]}</span>
												<span>Pick #{pick.pickNumber}</span>
												<span>R{pick.round}</span>
											</div>

											{/* Confidence - hidden for human picks */}
											{pick.reasoning !== 'Human selection' && (
												<div className="flex items-center gap-2 mb-2">
													<span className="text-xs text-gray-500">Confidence:</span>
													<div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
														<div
															className={cn(
																'h-full rounded-full transition-all',
																pick.confidence >= 0.8 ? 'bg-green-500' :
																pick.confidence >= 0.5 ? 'bg-yellow-500' : 'bg-red-500',
															)}
															style={{ width: `${Math.round(pick.confidence * 100)}%` }}
														/>
													</div>
													<span className="text-xs text-gray-400">
														{Math.round(pick.confidence * 100)}%
													</span>
												</div>
											)}

											{/* Reasoning - scrollable */}
											<div className="text-xs text-gray-300 leading-relaxed max-h-32 overflow-y-auto prose prose-invert prose-xs max-w-none">
												<Markdown>{pick.reasoning}</Markdown>
											</div>

											{/* Strategy shift badge */}
											{pickShift && (
												<div className="mt-2 p-1.5 rounded bg-yellow-500/10 border border-yellow-500/20">
													<div className="text-xs text-yellow-400 font-semibold flex items-center gap-1">
														<span>!</span>
														<span>Strategy Shift</span>
													</div>
													<p className="text-xs text-yellow-300/70 mt-0.5 line-clamp-2">
														{pickShift.trigger}
													</p>
												</div>
											)}
										</TooltipContent>
									</Tooltip>
								);
							}

							// Empty cell
							return (
								<div
									key={teamIdx}
									className={cn(
										'rounded-md px-2 py-2 border transition-all duration-300',
										onClock
											? 'border-cyan-400/50 bg-cyan-500/10 animate-pulse'
											: 'border-gray-800/50 bg-gray-900/30',
										isHumanCol && !onClock && 'border-cyan-500/10 bg-cyan-500/5',
									)}
								>
									{onClock ? (
										<div className="text-xs text-cyan-400 font-medium text-center">
											On Clock
										</div>
									) : (
										<div className="text-xs text-gray-800 text-center">
											--
										</div>
									)}
								</div>
							);
						})}
					</div>
				);
			})}
		</div>
	);
}
