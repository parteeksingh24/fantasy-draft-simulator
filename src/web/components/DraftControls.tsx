import { cn } from '../lib/utils';
import type { BoardState, PersonaAssignment } from '../lib/types';
import { TEAM_NAMES, PERSONA_DISPLAY_NAMES, NUM_TEAMS, NUM_ROUNDS } from '../lib/types';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

interface DraftControlsProps {
	board: BoardState | null;
	onStart: () => void;
	onAdvance: () => void;
	onNewDraft: () => void;
	onEndDraft: () => void;
	humanTeamIndex: number | null;
	setHumanTeamIndex: (value: number | null) => void;
	starting: boolean;
	advancing: boolean;
	ending: boolean;
	personas: PersonaAssignment[] | null;
	timerDisplay: string;
	timerPercent: number;
}

export function DraftControls({
	board,
	onStart,
	onAdvance,
	onNewDraft,
	onEndDraft,
	humanTeamIndex,
	setHumanTeamIndex,
	starting,
	advancing,
	ending,
	personas,
	timerDisplay,
	timerPercent,
}: DraftControlsProps) {
	const draftStarted = board !== null;
	const draftComplete = board?.draftComplete ?? false;
	const currentPick = board?.currentPick;
	const isHumanTurn = currentPick?.isHuman ?? false;

	// Status text
	let statusText = 'Not Started';
	if (draftComplete) {
		statusText = (board?.picks.length ?? 0) >= NUM_TEAMS * NUM_ROUNDS ? 'Draft Complete' : 'Draft Ended';
	} else if (currentPick) {
		statusText = `Round ${currentPick.round}, Pick ${currentPick.pickNumber}`;
	}

	// On-the-clock info
	let onClockText = '';
	let onClockPersona = '';
	if (currentPick && !draftComplete) {
		const teamName = TEAM_NAMES[currentPick.teamIndex] ?? `Team ${currentPick.teamIndex + 1}`;
		onClockText = isHumanTurn ? `${teamName} (You)` : teamName;

		if (!isHumanTurn && personas) {
			const assignment = personas.find((p) => p.teamIndex === currentPick.teamIndex);
			if (assignment) {
				onClockPersona = PERSONA_DISPLAY_NAMES[assignment.persona] ?? assignment.persona;
			}
		}
	}

	const canAdvance = draftStarted && !draftComplete && !isHumanTurn && !advancing && !ending;

	function handlePositionChange(val: string) {
		if (val === 'random') {
			setHumanTeamIndex(null);
		} else {
			setHumanTeamIndex(Number(val));
		}
	}

	return (
		<div className="bg-gray-900/60 border border-gray-800 rounded-xl p-4">
			<div className="flex flex-wrap items-center gap-4">
				{/* Status */}
				<div className="flex flex-col gap-0.5 min-w-[160px]">
					<span className="text-xs uppercase tracking-wider text-gray-600 font-medium">
						Status
					</span>
					{draftComplete ? (
						<Badge className="w-fit bg-green-500/20 text-green-400 border-green-500/30 hover:bg-green-500/30">
							{statusText}
						</Badge>
					) : isHumanTurn ? (
						<Badge className="w-fit bg-cyan-500/20 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/30">
							{statusText}
						</Badge>
					) : (
						<span className="text-sm font-semibold text-gray-300">
							{statusText}
						</span>
					)}
				</div>

				{/* On the clock */}
				{onClockText && (
					<div className="flex flex-col gap-0.5 min-w-[140px]">
						<span className="text-xs uppercase tracking-wider text-gray-600 font-medium">
							On the Clock
						</span>
						<div className="flex items-center gap-2">
							<span className={cn(
								'text-sm font-semibold',
								isHumanTurn ? 'text-cyan-400' : 'text-gray-300',
							)}>
								{onClockText}
							</span>
							{onClockPersona && (
								<Badge variant="secondary" className="text-xs h-auto py-0.5">
									{onClockPersona}
								</Badge>
							)}
						</div>
					</div>
				)}

				{/* Picks count */}
				{board && (
					<div className="flex flex-col gap-0.5 min-w-[80px]">
						<span className="text-xs uppercase tracking-wider text-gray-600 font-medium">
							Picks
						</span>
						<span className="text-sm text-gray-300 font-mono">
							{board.picks.length} / 60
						</span>
					</div>
				)}

				{/* Timer */}
				{board && !draftComplete && (
					<div className="flex flex-col gap-0.5 min-w-[60px]">
						<span className="text-xs uppercase tracking-wider text-gray-600 font-medium">Timer</span>
						<span className={cn(
							'text-sm font-mono',
							timerPercent < 20 ? 'text-red-400 animate-pulse' : timerPercent < 50 ? 'text-yellow-400' : 'text-gray-300',
						)}>
							{timerDisplay}
						</span>
					</div>
				)}

				{/* Spacer */}
				<div className="flex-1" />

				{/* Controls */}
				<div className="flex items-center gap-3">
					{/* Draft position selector - only before start */}
					{!draftStarted && (
						<div className="flex items-center gap-2">
							<label className="text-xs text-gray-500" htmlFor="draft-pos">
								Draft Position:
							</label>
							<Select
								value={humanTeamIndex === null ? 'random' : String(humanTeamIndex)}
								onValueChange={handlePositionChange}
							>
								<SelectTrigger size="sm" className="w-[90px] text-xs bg-gray-800 border-gray-700 text-gray-300">
									<SelectValue />
								</SelectTrigger>
								<SelectContent position="popper" sideOffset={4}>
									<SelectItem value="random">Random</SelectItem>
									{Array.from({ length: NUM_TEAMS }, (_, i) => (
										<SelectItem key={i} value={String(i)}>
											#{i + 1}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}

					{/* Start button - only before start */}
					{!draftStarted && (
						<Button
							onClick={onStart}
							disabled={starting}
							size="sm"
							className="bg-cyan-500/20 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/30 hover:border-cyan-500/50"
						>
							{starting ? 'Starting...' : 'Start Draft'}
						</Button>
					)}

					{/* Advance button - during draft, AI turns */}
					{draftStarted && !draftComplete && (
						<Button
							onClick={onAdvance}
							disabled={!canAdvance}
							variant="outline"
							size="sm"
						>
							{advancing ? 'Picking...' : 'Advance'}
						</Button>
					)}

					{/* End Draft button - during active draft */}
					{draftStarted && !draftComplete && (
						<Button
							onClick={onEndDraft}
							disabled={ending}
							variant="outline"
							size="sm"
							className="text-red-400 border-red-500/30 hover:text-red-300 hover:border-red-500/50 hover:bg-red-500/10"
						>
							{ending ? 'Ending...' : 'End Draft'}
						</Button>
					)}

					{/* New Draft button - during or after draft */}
					{draftStarted && (
						<Button
							onClick={onNewDraft}
							variant="outline"
							size="sm"
							className="text-gray-500 border-gray-700 hover:text-gray-300 hover:border-gray-600"
						>
							New Draft
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
