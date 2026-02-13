import { useState, useRef, useEffect } from 'react';
import { cn } from '../lib/utils';
import type { Pick, Position, PersonaAssignment, StrategyShift, ToolCallRecord } from '../lib/types';
import { POSITION_COLORS, PERSONA_DISPLAY_NAMES, PERSONA_MODELS, TEAM_NAMES, TOOL_COLORS } from '../lib/types';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import Markdown from 'react-markdown';

interface ThinkingPanelProps {
	lastPick: Pick | null;
	personas: PersonaAssignment[] | null;
	shifts: StrategyShift[];
	isStreaming?: boolean;
	streamTokens?: string;
	streamPersona?: string;
	streamModel?: string;
	streamTeamIndex?: number;
	isHumanTurn: boolean;
	toolCalls?: ToolCallRecord[];
}

function summarizeResult(result: unknown): string {
	if (Array.isArray(result)) return `${result.length} result${result.length === 1 ? '' : 's'}`;
	if (typeof result === 'string') return result.length > 80 ? result.slice(0, 80) + '...' : result;
	if (typeof result === 'object' && result !== null) {
		const json = JSON.stringify(result);
		return json.length > 80 ? json.slice(0, 80) + '...' : json;
	}
	return String(result);
}

function ToolCallCard({ tc }: { tc: ToolCallRecord }) {
	const [expanded, setExpanded] = useState(false);
	const colors = TOOL_COLORS[tc.name] ?? { text: 'text-gray-400', bg: 'bg-gray-500/20', border: 'border-gray-500/30' };

	return (
		<div className={cn('rounded-lg border p-2 text-xs', colors.bg, colors.border)}>
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="w-full flex items-center justify-between cursor-pointer"
			>
				<Badge className={cn('text-xs h-auto py-0 px-1.5 font-mono', colors.bg, colors.text, 'border', colors.border)}>
					{tc.name}
				</Badge>
				{tc.result === undefined ? (
					<span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
				) : (
					<span className="text-gray-500">{expanded ? '-' : '+'}</span>
				)}
			</button>

			{expanded && (
				<div className="mt-2 space-y-1">
					{Object.keys(tc.args).length > 0 && (
						<div className="space-y-0.5">
							{Object.entries(tc.args).map(([k, v]) => (
								<div key={k} className="flex gap-1.5 font-mono text-gray-500">
									<span className="text-gray-600">{k}:</span>
									<span className="text-gray-400 truncate">{String(v)}</span>
								</div>
							))}
						</div>
					)}
					{tc.result !== undefined && (
						<div className="text-gray-400 font-mono truncate">
							{summarizeResult(tc.result)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

export function ThinkingPanel({ lastPick, personas, shifts, isStreaming, streamTokens, streamPersona, streamModel, streamTeamIndex, isHumanTurn, toolCalls }: ThinkingPanelProps) {
	// Auto-scroll ref for streaming view
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [streamTokens]);

	// Streaming state: show live tokens with blinking cursor
	if (isStreaming && streamTokens !== undefined) {
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

					{/* Tool calls */}
					{toolCalls && toolCalls.length > 0 && (
						<div className="space-y-1.5 flex-shrink-0">
							<div className="text-xs text-gray-500 font-medium">Tools</div>
							{toolCalls.map((tc, i) => (
								<ToolCallCard key={`${tc.name}-${i}`} tc={tc} />
							))}
						</div>
					)}

					{/* Live streaming tokens */}
					<div className="flex-1 min-h-0 overflow-hidden flex flex-col">
						<div className="text-xs text-gray-500 mb-1 font-medium flex-shrink-0">Reasoning</div>
						<div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
							<div className="text-sm text-gray-400 leading-relaxed prose prose-invert prose-sm max-w-none">
								<Markdown>{streamTokens}</Markdown>
								<span className="inline-block w-1.5 h-3 bg-cyan-400 animate-pulse ml-0.5 align-middle" />
							</div>
						</div>
					</div>
				</CardContent>
			</Card>
		);
	}

	if (isHumanTurn) {
		return (
			<Card className="h-full bg-gray-900/40 border-gray-800 py-4 overflow-hidden">
				<CardHeader className="px-4 pb-0">
					<CardTitle className="text-xs uppercase tracking-wider text-gray-600 font-medium">
						Your Turn
					</CardTitle>
				</CardHeader>
				<CardContent className="px-4 flex-1 flex items-center justify-center">
					<div className="text-center">
						<p className="text-sm text-cyan-400 font-medium">You're on the clock</p>
						<p className="text-xs text-gray-600 mt-1">Select a player from the list</p>
					</div>
				</CardContent>
			</Card>
		);
	}

	// No pick yet: waiting state
	if (!lastPick) {
		return (
			<Card className="h-full bg-gray-900/40 border-gray-800 py-4 overflow-hidden">
				<CardHeader className="px-4 pb-0">
					<CardTitle className="text-xs uppercase tracking-wider text-gray-600 font-medium">
						AI Output
					</CardTitle>
				</CardHeader>
				<CardContent className="px-4 flex-1 flex items-center justify-center">
					<p className="text-sm text-gray-700 text-center">
						Waiting for AI pick...
					</p>
				</CardContent>
			</Card>
		);
	}

	// Last pick state
	const colors = POSITION_COLORS[lastPick.position as Position];
	const teamName = TEAM_NAMES[lastPick.teamIndex] ?? `Team ${lastPick.teamIndex + 1}`;

	// Find persona for this team
	let personaDisplay = '';
	let modelName = '';
	if (personas) {
		const assignment = personas.find((p) => p.teamIndex === lastPick.teamIndex);
		if (assignment && assignment.persona !== 'human') {
			personaDisplay = PERSONA_DISPLAY_NAMES[assignment.persona] ?? assignment.persona;
			modelName = PERSONA_MODELS[assignment.persona] ?? '';
		}
	}

	// Check for strategy shift on this pick
	const shift = shifts.find((s) => s.pickNumber === lastPick.pickNumber);

	const confidencePercent = Math.round(lastPick.confidence * 100);

	return (
		<Card className="h-full bg-gray-900/40 border-gray-800 py-4 overflow-hidden flex flex-col">
			<CardHeader className="px-4 pb-0 flex-shrink-0">
				<CardTitle className="text-xs uppercase tracking-wider text-gray-600 font-medium">
					Last AI Pick
				</CardTitle>
			</CardHeader>

			<CardContent className="px-4 flex flex-col flex-1 gap-3 min-h-0">
				{/* Player card */}
				<div className={cn(
					'rounded-lg p-3 border flex-shrink-0',
					colors.bg, colors.border,
				)}>
					<div className={cn('text-base font-semibold', colors.text)}>
						{lastPick.playerName}
					</div>
					<div className="flex items-center gap-2 mt-1">
						<Badge className={cn('text-xs h-auto py-0 px-1.5 font-mono', colors.bg, colors.text, 'border', colors.border)}>
							{lastPick.position}
						</Badge>
						<span className="text-xs text-gray-500">
							Pick #{lastPick.pickNumber}
						</span>
					</div>
				</div>

				{/* Team and persona info */}
				<div className="space-y-2 flex-shrink-0">
					<div className="flex items-center justify-between">
						<span className="text-xs text-gray-500">Team</span>
						<span className="text-sm text-gray-300">{teamName}</span>
					</div>
					{personaDisplay && (
						<div className="flex items-center justify-between">
							<span className="text-xs text-gray-500">Persona</span>
							<Badge variant="secondary" className="text-xs h-auto py-0.5">
								{personaDisplay}
							</Badge>
						</div>
					)}
					{modelName && (
						<div className="flex items-center justify-between">
							<span className="text-xs text-gray-500">Model</span>
							<span className="text-xs text-gray-400 font-mono">
								{modelName}
							</span>
						</div>
					)}
				</div>

				{/* Confidence meter */}
				<div className="flex-shrink-0">
					<div className="flex items-center justify-between mb-1">
						<span className="text-xs text-gray-500">Confidence</span>
						<span className="text-xs font-mono text-gray-400">
							{confidencePercent}%
						</span>
					</div>
					<Progress
						value={confidencePercent}
						className={cn(
							'h-1.5 bg-gray-800',
							confidencePercent >= 80
								? '[&>[data-slot=progress-indicator]]:bg-green-500'
								: confidencePercent >= 50
									? '[&>[data-slot=progress-indicator]]:bg-yellow-500'
									: '[&>[data-slot=progress-indicator]]:bg-red-500',
						)}
					/>
				</div>

				{/* Strategy shift */}
				{shift && (
					<div className="p-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 flex-shrink-0">
						<div className="text-xs text-yellow-400 font-semibold flex items-center gap-1 mb-1">
							<span>!</span>
							<span>Strategy Shift</span>
						</div>
						<p className="text-xs text-yellow-300/70 leading-relaxed">
							{shift.trigger}
						</p>
					</div>
				)}

				{/* Reasoning */}
				<div className="flex-1 min-h-0 overflow-hidden flex flex-col">
					<div className="text-xs text-gray-500 mb-1 font-medium flex-shrink-0">Reasoning</div>
					<div className="flex-1 overflow-y-auto min-h-0">
						<div className="text-sm text-gray-400 leading-relaxed prose prose-invert prose-sm max-w-none">
							<Markdown>{lastPick.reasoning}</Markdown>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
