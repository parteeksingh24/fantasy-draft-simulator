import { useEffect, useRef } from 'react';
import { cn } from '../lib/utils';
import type { PersonaAssignment, ToolCallRecord } from '../lib/types';
import { TEAM_NAMES, PERSONA_DISPLAY_NAMES, PERSONA_MODELS } from '../lib/types';
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
}

export function ThinkingPanel({ personas, isStreaming, streamTokens, streamPersona, streamModel, streamTeamIndex, toolCalls, boardContext }: ThinkingPanelProps) {
	const scrollRef = useRef<HTMLDivElement>(null);

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

				{/* Board context (position runs, value drops, scarcity) */}
				{boardContext && (
					<div className="flex-shrink-0 space-y-1.5">
						<div className="text-xs text-gray-500 font-medium">Board Context</div>
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
				)}

				{/* Tool calls as inline chips */}
				{toolCalls && toolCalls.length > 0 && (
					<div className="flex-shrink-0">
						<div className="text-xs text-gray-500 font-medium mb-1.5">Tools</div>
						<div className="flex flex-wrap gap-1.5">
							{toolCalls.map((tc, i) => (
								<ToolCallChip key={tc.toolCallId ?? `${tc.name}-${tc.timestamp}-${i}`} tc={tc} />
							))}
						</div>
					</div>
				)}

				{/* Live streaming tokens */}
				<div className="flex-1 min-h-0 overflow-hidden flex flex-col">
					<div className="text-xs text-gray-500 mb-1 font-medium flex-shrink-0">Reasoning</div>
					<div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
						<div className="text-sm text-gray-400 leading-relaxed prose prose-invert prose-sm max-w-none">
							<Markdown>{streamTokens ?? ''}</Markdown>
							<span className="inline-block w-1.5 h-3 bg-cyan-400 animate-pulse ml-0.5 align-middle" />
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
