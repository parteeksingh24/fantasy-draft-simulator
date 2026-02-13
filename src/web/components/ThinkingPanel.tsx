import { useEffect, useRef } from 'react';
import { cn } from '../lib/utils';
import type { PersonaAssignment, ToolCallRecord } from '../lib/types';
import { TEAM_NAMES, PERSONA_DISPLAY_NAMES, PERSONA_MODELS } from '../lib/types';
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
}

export function ThinkingPanel({ personas, isStreaming, streamTokens, streamPersona, streamModel, streamTeamIndex, toolCalls }: ThinkingPanelProps) {
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

				{/* Tool calls as inline chips */}
				{toolCalls && toolCalls.length > 0 && (
					<div className="flex-shrink-0">
						<div className="text-xs text-gray-500 font-medium mb-1.5">Tools</div>
						<div className="flex flex-wrap gap-1.5">
							{toolCalls.map((tc, i) => (
								<ToolCallChip key={`${tc.name}-${i}`} tc={tc} />
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
