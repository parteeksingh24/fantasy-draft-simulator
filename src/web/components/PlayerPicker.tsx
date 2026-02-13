import { useState, useMemo } from 'react';
import { cn } from '../lib/utils';
import type { Player, Position, Roster } from '../lib/types';
import { POSITION_COLORS } from '../lib/types';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card } from './ui/card';

interface PlayerPickerProps {
	players: Player[];
	roster: Roster | null;
	isHumanTurn: boolean;
	onPick: (playerId: string) => void;
	picking: boolean;
}

const FILTER_OPTIONS: Array<{ label: string; value: Position | 'ALL' }> = [
	{ label: 'All', value: 'ALL' },
	{ label: 'QB', value: 'QB' },
	{ label: 'RB', value: 'RB' },
	{ label: 'WR', value: 'WR' },
	{ label: 'TE', value: 'TE' },
];

export function PlayerPicker({ players, roster, isHumanTurn, onPick, picking }: PlayerPickerProps) {
	const [positionFilter, setPositionFilter] = useState<Position | 'ALL'>('ALL');
	const [searchQuery, setSearchQuery] = useState('');

	const filteredPlayers = useMemo(() => {
		let list = players;

		if (positionFilter !== 'ALL') {
			list = list.filter((p) => p.position === positionFilter);
		}

		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase().trim();
			list = list.filter(
				(p) =>
					p.name.toLowerCase().includes(q) ||
					p.team.toLowerCase().includes(q),
			);
		}

		return list;
	}, [players, positionFilter, searchQuery]);

	// Roster slots display
	const rosterSlots = [
		{ label: 'QB', player: roster?.qb },
		{ label: 'RB', player: roster?.rb },
		{ label: 'WR', player: roster?.wr },
		{ label: 'TE', player: roster?.te },
		{ label: 'FLEX', player: roster?.superflex },
	];

	function handleRowClick(playerId: string) {
		if (isHumanTurn && !picking) {
			onPick(playerId);
		}
	}

	return (
		<div className={cn(
			'bg-gray-900/80 rounded-xl overflow-hidden border h-full flex flex-col',
			isHumanTurn ? 'border-cyan-500/20' : 'border-gray-800/50',
		)}>
			{/* Header */}
			<div className={cn(
				'px-4 py-2.5 border-b flex-shrink-0',
				isHumanTurn ? 'border-cyan-500/20 bg-cyan-500/5' : 'border-gray-800/50 bg-gray-900/50',
			)}>
				<div>
					<h3 className={cn(
						'text-sm font-semibold',
						isHumanTurn ? 'text-cyan-400' : 'text-gray-500',
					)}>
						{isHumanTurn ? 'Your Pick' : 'Available Players'}
					</h3>
					<p className="text-xs text-gray-600 mt-0.5">
						{isHumanTurn ? 'Select a player to draft' : 'AI is picking...'}
					</p>
				</div>
			</div>

			<div className="flex flex-1 min-h-0">
				{/* Player list */}
				<div className="flex-1 min-w-0 flex flex-col">
					{/* Filters */}
					<div className="px-4 py-2 border-b border-gray-800 flex items-center gap-3 flex-shrink-0">
						{/* Position filter badges */}
						<div className="flex items-center gap-1">
							{FILTER_OPTIONS.map((opt) => {
								const isActive = positionFilter === opt.value;
								const posColors = opt.value !== 'ALL' ? POSITION_COLORS[opt.value] : null;
								return (
									<Badge
										key={opt.value}
										onClick={() => setPositionFilter(opt.value)}
										className={cn(
											'cursor-pointer text-xs transition-colors',
											isActive
												? posColors
													? cn(posColors.bg, posColors.text, 'border', posColors.border)
													: 'bg-gray-700 text-white'
												: 'bg-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-800/50 border-transparent',
										)}
									>
										{opt.label}
									</Badge>
								);
							})}
						</div>

						{/* Search */}
						<input
							type="text"
							placeholder="Search players..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="flex-1 bg-gray-800/50 border border-gray-700/50 text-gray-300 text-sm rounded-md px-2.5 py-1.5 focus:outline-none focus:border-cyan-500/50 placeholder:text-gray-600"
						/>

						<span className="text-xs text-gray-600 font-mono">
							{filteredPlayers.length}
						</span>
					</div>

					{/* Player list - fills remaining space */}
					<div className="flex-1 min-h-0 overflow-y-auto">
						{filteredPlayers.length === 0 ? (
							<div className="px-4 py-8 text-center text-sm text-gray-600">
								{players.length === 0
									? 'No players available.'
									: 'No players match your filter.'}
							</div>
						) : (
							filteredPlayers.map((player, idx) => {
								const prevTier = idx > 0 ? filteredPlayers[idx - 1]!.tier : player.tier;
								const showSeparator = idx > 0 && player.tier !== prevTier;
								const colors = POSITION_COLORS[player.position];
								return (
									<div key={player.playerId}>
										{showSeparator && (
											<div className="flex items-center gap-2 px-4 py-1 bg-gray-900/50">
												<div className="flex-1 h-px bg-gray-700/50" />
												<span className="text-[9px] text-gray-600 font-mono">Tier {player.tier}</span>
												<div className="flex-1 h-px bg-gray-700/50" />
											</div>
										)}
										<div
											className={cn(
												'w-full px-4 py-2 flex items-center gap-3 border-b border-gray-800/50 hover:bg-gray-800/40',
												isHumanTurn && !picking && 'cursor-pointer active:bg-gray-700/40',
											)}
											onClick={() => handleRowClick(player.playerId)}
										>
											{/* Position badge */}
											<Badge className={cn('text-xs font-mono w-8 justify-center px-1 py-0', colors.bg, colors.text, 'border', colors.border)}>
												{player.position}
											</Badge>
											{/* Name */}
											<span className="text-sm font-medium flex-1 truncate text-gray-300">
												{player.name}
											</span>
											{/* Team */}
											<span className="text-xs text-gray-500 w-8 text-center">
												{player.team}
											</span>
											{/* Rank */}
											<span className="text-xs text-gray-600 font-mono w-10 text-right">
												#{player.rank}
											</span>
											{/* Draft button */}
											<Button
												size="sm"
												variant="outline"
												onClick={(e) => {
													e.stopPropagation();
													onPick(player.playerId);
												}}
												disabled={picking || !isHumanTurn}
												className={cn(
													'text-xs h-8 px-3',
													isHumanTurn
														? 'text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/20'
														: 'text-gray-600 border-gray-700/30 cursor-not-allowed',
												)}
											>
												Draft
											</Button>
										</div>
									</div>
								);
							})
						)}
					</div>
				</div>

				{/* Roster sidebar */}
				<div className="w-32 border-l border-gray-800 bg-gray-900/50 p-3 overflow-y-auto flex-shrink-0">
					<h4 className="text-xs uppercase tracking-wider text-gray-600 font-medium mb-2">
						Your Roster
					</h4>
					<div className="flex flex-col gap-1.5">
						{rosterSlots.map(({ label, player }) => {
							const posKey = label === 'FLEX' ? null : label as Position;
							const colors = posKey ? POSITION_COLORS[posKey] : null;
							return (
								<Card
									key={label}
									size="sm"
									className={cn(
										'px-2 py-1.5 gap-0 shadow-none rounded-md',
										player
											? cn(
												colors?.bg ?? 'bg-gray-800/50',
												colors?.border ? `border ${colors.border}` : 'border-gray-700/50',
											)
											: 'border-gray-800/50 border-dashed bg-gray-900/30',
									)}
								>
									<div className="text-xs text-gray-600 font-medium">{label}</div>
									{player ? (
										<div className={cn(
											'text-sm font-medium truncate',
											colors?.text ?? 'text-gray-300',
										)}>
											{player.name}
										</div>
									) : (
										<div className="text-xs text-gray-700 italic">Empty</div>
									)}
								</Card>
							);
						})}
					</div>
				</div>
			</div>
		</div>
	);
}
