import { cn } from '../lib/utils';
import type { Pick, Position, StrategyShift } from '../lib/types';
import { POSITION_COLORS, TEAM_NAMES, SHIFT_CATEGORY_LABELS } from '../lib/types';

interface PickTooltipProps {
	pick: Pick;
	shift: StrategyShift | null;
	position: { x: number; y: number };
}

export function PickTooltip({ pick, shift, position }: PickTooltipProps) {
	const colors = POSITION_COLORS[pick.position as Position];
	const isHumanPick = pick.reasoning === 'Human selection';

	return (
		<div
			className="fixed z-50 pointer-events-auto"
			style={{
				left: position.x,
				top: position.y - 8,
				transform: 'translate(-50%, -100%)',
			}}
		>
			<div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-3 max-w-xs">
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
				<div className="flex items-center gap-3 text-[11px] text-gray-400 mb-2">
					<span>{TEAM_NAMES[pick.teamIndex]}</span>
					<span>Pick #{pick.pickNumber}</span>
					<span>R{pick.round}</span>
				</div>

				{/* Confidence - hidden for human picks */}
				{!isHumanPick && (
					<div className="flex items-center gap-2 mb-2">
						<span className="text-[11px] text-gray-500">Confidence:</span>
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
						<span className="text-[11px] text-gray-400">
							{Math.round(pick.confidence * 100)}%
						</span>
					</div>
				)}

				{/* Reasoning - scrollable for long AI text */}
				<p className="text-[11px] text-gray-300 leading-relaxed max-h-32 overflow-y-auto">
					{pick.reasoning}
				</p>

				{/* Strategy shift badge */}
					{shift && (
						<div className="mt-2 p-1.5 rounded bg-yellow-500/10 border border-yellow-500/20">
							<div className="text-[10px] text-yellow-400 font-semibold flex items-center gap-1">
								<span>!</span>
								<span>Strategy Shift</span>
							</div>
							<div className="mt-0.5 text-[10px] text-yellow-300/80">
								{SHIFT_CATEGORY_LABELS[shift.category]} • {shift.severity}
							</div>
							<p className="text-[10px] text-yellow-300/70 mt-0.5 line-clamp-2">
								{shift.trigger}
							</p>
						</div>
					)}
			</div>
		</div>
	);
}
