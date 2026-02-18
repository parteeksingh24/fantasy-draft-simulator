import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils';
import type { PersonaAssignment, ToolCallRecord, Roster, RosterSlot } from '../lib/types';
import { TEAM_NAMES, PERSONA_DISPLAY_NAMES, PERSONA_MODELS, POSITION_COLORS } from '../lib/types';
import type { BoardContext } from '../hooks/useAdvanceStream';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import Markdown from 'react-markdown';
import { ToolCallChip } from './ToolCallChip';

interface ThinkingPanelProps {
	personas: PersonaAssignment[] | null;
	isStreaming?: boolean;
	streamTokens?: string;
	streamPersona?: string;
	streamModel?: string;
	streamTeamIndex?: number;
	toolCalls?: ToolCallRecord[];
	boardContext?: BoardContext | null;
	streamError?: string | null;
	isHumanTurn?: boolean;
	roster?: Roster | null;
	picksUntilNextTurn?: number;
}

export function ThinkingPanel({ personas, isStreaming, streamTokens, streamPersona, streamModel, streamTeamIndex, toolCalls, boardContext, streamError, isHumanTurn, roster, picksUntilNextTurn }: ThinkingPanelProps) {
	const scrollRef = useRef<HTMLDivElement>(null);

	// Collapsible state for Board Context and Tools
	const [boardContextExpanded, setBoardContextExpanded] = useState(!isStreaming);
	const [toolsExpanded, setToolsExpanded] = useState(!isStreaming);

	// Auto-collapse during streaming, auto-expand when done
	useEffect(() => {
		if (isStreaming) {
			setBoardContextExpanded(false);
			setToolsExpanded(false);
		} else {
			setBoardContextExpanded(true);
			setToolsExpanded(true);
		}
	}, [isStreaming]);

	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [streamTokens]);

	const teamName = streamTeamIndex !== undefined
		? (TEAM_NAMES[streamTeamIndex] ?? `Team ${streamTeamIndex + 1}`)
		: '';
	const personaDisplay = streamPersona
		? (PERSONA_DISPLAY_NAMES[streamPersona] ?? streamPersona)
		: '';
	const modelDisplay = streamModel ?? (streamPersona ? PERSONA_MODELS[streamPersona] ?? '' : '');

	const boardContextCount = boardContext
		? boardContext.positionRuns.length + boardContext.valueDrops.length + boardContext.scarcity.length
		: 0;
	const toolCallCount = toolCalls?.length ?? 0;

	// Compute roster slots still needed for "Your Turn" state
	const slotsNeeded: RosterSlot[] = [];
	if (roster) {
		if (!roster.qb) slotsNeeded.push('QB');
		if (!roster.rb) slotsNeeded.push('RB');
		if (!roster.wr) slotsNeeded.push('WR');
		if (!roster.te) slotsNeeded.push('TE');
		if (!roster.superflex) slotsNeeded.push('SUPERFLEX');
	}

	// "Your Turn" state: human is on the clock and no AI stream is active
	if (isHumanTurn && !isStreaming) {
		return (
			<Card className="h-full bg-gray-900/40 border-cyan-500/20 py-4 overflow-hidden flex flex-col">
				<CardContent className="px-4 flex-1 flex flex-col items-center justify-center text-center gap-4">
					<div>
						<h3 className="text-lg font-semibold text-cyan-400">Your Turn!</h3>
						<p className="text-sm text-gray-500 mt-1">Make your pick from the board below</p>
					</div>

					{slotsNeeded.length > 0 && (
						<div className="w-full">
							<div className="text-xs text-gray-500 font-medium mb-2">You still need</div>
							<div className="flex flex-wrap justify-center gap-1.5">
								{slotsNeeded.map((slot) => {
									const posKey = slot === 'SUPERFLEX' ? null : slot;
									const colors = posKey ? POSITION_COLORS[posKey] : null;
									return (
										<Badge
											key={slot}
											className={cn(
												'text-xs',
												colors
													? cn(colors.bg, colors.text, 'border', colors.border)
													: 'bg-gray-700/50 text-gray-300 border-gray-600/50',
											)}
										>
											{slot === 'SUPERFLEX' ? 'FLEX' : slot}
										</Badge>
									);
								})}
							</div>
						</div>
					)}

					{picksUntilNextTurn !== undefined && picksUntilNextTurn > 0 && (
						<p className="text-xs text-gray-600">
							{picksUntilNextTurn} pick{picksUntilNextTurn !== 1 ? 's' : ''} until your next turn
						</p>
					)}
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className="h-full bg-gray-900/40 border-gray-800 py-4 overflow-hidden flex flex-col">
			<CardHeader className="px-4 pb-0 flex-shrink-0">
				<CardTitle className="text-xs uppercase tracking-wider text-gray-600 font-medium">
					AI Thinking
					<span className="ml-2 inline-block w-1.5 h-3 bg-cyan-400 animate-pulse" />
				</CardTitle>
			</CardHeader>

			<CardContent className="px-4 flex flex-col flex-1 gap-3 min-h-0">
				{/* Team and persona info */}
				<div className="space-y-2 flex-shrink-0">
					{teamName && (
						<div className="flex items-center justify-between">
							<span className="text-xs text-gray-500">Team</span>
							<span className="text-sm text-gray-300">{teamName}</span>
						</div>
					)}
					{personaDisplay && (
						<div className="flex items-center justify-between">
							<span className="text-xs text-gray-500">Persona</span>
							<Badge variant="secondary" className="text-xs h-auto py-0.5">
								{personaDisplay}
							</Badge>
						</div>
					)}
					{modelDisplay && (
						<div className="flex items-center justify-between">
							<span className="text-xs text-gray-500">Model</span>
							<span className="text-xs text-gray-400 font-mono">
								{modelDisplay}
							</span>
						</div>
					)}
				</div>

				{/* Board context (collapsible) */}
				{boardContext && boardContextCount > 0 && (
					<div className="flex-shrink-0">
						<button
							type="button"
							onClick={() => setBoardContextExpanded((v) => !v)}
							className="flex items-center gap-1 text-xs text-gray-500 font-medium cursor-pointer hover:text-gray-400 transition-colors w-full"
						>
							<ChevronRight
								className={cn(
									'w-3 h-3 transition-transform duration-150',
									boardContextExpanded && 'rotate-90',
								)}
							/>
							Board Context ({boardContextCount})
						</button>
						<AnimatePresence initial={false}>
							{boardContextExpanded && (
								<motion.div
									initial={{ height: 0, opacity: 0 }}
									animate={{ height: 'auto', opacity: 1 }}
									exit={{ height: 0, opacity: 0 }}
									transition={{ duration: 0.15 }}
									className="overflow-hidden"
								>
									<div className="space-y-1.5 pt-1.5">
										{boardContext.positionRuns.map((run) => (
											<div key={run.position} className="text-xs text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded px-2 py-1">
												{run.position} — {run.count} of last {run.window} picks
											</div>
										))}
										{boardContext.valueDrops.map((drop) => (
											<div key={drop.playerName} className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded px-2 py-1">
												{drop.playerName} fell {drop.adpDiff} spots
											</div>
										))}
										{boardContext.scarcity.map((s) => (
											<div key={s.position} className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded px-2 py-1">
												Only {s.remaining} {s.position}s left
											</div>
										))}
									</div>
								</motion.div>
							)}
						</AnimatePresence>
					</div>
				)}

				{/* Tool calls (collapsible) */}
				{toolCalls && toolCallCount > 0 && (
					<div className="flex-shrink-0">
						<button
							type="button"
							onClick={() => setToolsExpanded((v) => !v)}
							className="flex items-center gap-1 text-xs text-gray-500 font-medium cursor-pointer hover:text-gray-400 transition-colors w-full"
						>
							<ChevronRight
								className={cn(
									'w-3 h-3 transition-transform duration-150',
									toolsExpanded && 'rotate-90',
								)}
							/>
							Tools ({toolCallCount})
						</button>
						<AnimatePresence initial={false}>
							{toolsExpanded && (
								<motion.div
									initial={{ height: 0, opacity: 0 }}
									animate={{ height: 'auto', opacity: 1 }}
									exit={{ height: 0, opacity: 0 }}
									transition={{ duration: 0.15 }}
									className="overflow-hidden"
								>
									<div className="flex flex-wrap gap-1.5 pt-1.5">
										{toolCalls.map((tc, i) => (
											<ToolCallChip key={tc.toolCallId ?? `${tc.name}-${tc.timestamp}-${i}`} tc={tc} />
										))}
									</div>
								</motion.div>
							)}
						</AnimatePresence>
					</div>
				)}

				{/* Live streaming tokens */}
				<div className="flex-1 min-h-0 overflow-hidden flex flex-col">
					<div className="text-xs text-gray-500 mb-1 font-medium flex-shrink-0">Reasoning</div>
					<div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
						<div className="text-sm text-gray-400 leading-relaxed prose prose-invert prose-sm max-w-none">
							<Markdown>{streamTokens ?? ''}</Markdown>
							{isStreaming && (
								<span className="inline-block w-1.5 h-3 bg-cyan-400 animate-pulse ml-0.5 align-middle" />
							)}
						</div>
						{streamError && (
							<div className="mt-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
								{streamError.includes('No draft in progress')
									? 'No draft in progress. Start a new draft.'
									: 'Connection lost. Auto-advance paused. Click Advance to retry.'}
							</div>
						)}
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
