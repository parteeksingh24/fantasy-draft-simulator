/**
 * Custom hook for SSE streaming of AI draft picks.
 * Uses native EventSource to connect to GET /api/draft/advance/stream.
 * Accumulates reasoning tokens and delivers the final pick.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import type { BoardState, Pick, Roster, ToolCallRecord, StrategyShift } from '../lib/types';

export interface BoardContext {
	positionRuns: { position: string; count: number; window: number }[];
	valueDrops: { playerName: string; position: string; adpDiff: number }[];
	scarcity: { position: string; remaining: number }[];
	summary: string;
}

interface AdvanceStreamState {
	isStreaming: boolean;
	tokens: string;
	persona: string | undefined;
	model: string | undefined;
	teamIndex: number | undefined;
	pick: Pick | null;
	boardState: BoardState | null;
	rosters: Roster[] | null;
	draftComplete: boolean | undefined;
	error: string | null;
	toolCalls: ToolCallRecord[];
	boardContext: BoardContext | null;
	strategyShift: StrategyShift | null;
}

function attachToolResult(
	toolCalls: ToolCallRecord[],
	data: { name: string; result: unknown; toolCallId?: string },
): ToolCallRecord[] {
	const next = [...toolCalls];

	if (data.toolCallId) {
		for (let i = next.length - 1; i >= 0; i--) {
			const call = next[i]!;
			if (call.toolCallId === data.toolCallId && call.result === undefined) {
				next[i] = { ...call, result: data.result };
				return next;
			}
		}
	}

	// Fallback for older payloads that only include tool name.
	for (let i = next.length - 1; i >= 0; i--) {
		const call = next[i]!;
		if (call.name === data.name && call.result === undefined) {
			next[i] = { ...call, result: data.result };
			return next;
		}
	}

	return next;
}

export function useAdvanceStream() {
	const [state, setState] = useState<AdvanceStreamState>({
		isStreaming: false,
		tokens: '',
		persona: undefined,
		model: undefined,
		teamIndex: undefined,
		pick: null,
		boardState: null,
		rosters: null,
		draftComplete: undefined,
		error: null,
		toolCalls: [],
		boardContext: null,
		strategyShift: null,
	});

	const eventSourceRef = useRef<EventSource | null>(null);

	const close = useCallback(() => {
		if (eventSourceRef.current) {
			eventSourceRef.current.close();
			eventSourceRef.current = null;
		}
	}, []);

	useEffect(() => () => {
		close();
	}, [close]);

	const startStream = useCallback(() => {
		// Close any existing connection
		close();

		// Reset state for new stream
		setState({
			isStreaming: true,
			tokens: '',
			persona: undefined,
			model: undefined,
			teamIndex: undefined,
			pick: null,
			boardState: null,
			rosters: null,
			draftComplete: undefined,
			error: null,
			toolCalls: [],
			boardContext: null,
			strategyShift: null,
		});

		const es = new EventSource('/api/draft/advance/stream');
		eventSourceRef.current = es;

		es.addEventListener('metadata', (e) => {
			try {
				const data = JSON.parse(e.data);
				setState((prev) => ({
					...prev,
					persona: data.persona,
					model: data.model,
					teamIndex: data.teamIndex,
				}));
			} catch {
				// Ignore parse errors
			}
		});

		es.addEventListener('thinking', (e) => {
			setState((prev) => ({
				...prev,
				tokens: prev.tokens + e.data,
			}));
		});

		es.addEventListener('tool-call', (e) => {
			try {
				const data = JSON.parse(e.data) as { name: string; args?: Record<string, unknown>; toolCallId?: string };
				setState((prev) => ({
					...prev,
					toolCalls: [
						...prev.toolCalls,
						{
							name: data.name,
							args: data.args ?? {},
							toolCallId: data.toolCallId,
							timestamp: Date.now(),
						},
					],
				}));
			} catch {
				// Ignore parse errors
			}
		});

		es.addEventListener('tool-result', (e) => {
			try {
				const data = JSON.parse(e.data) as { name: string; result: unknown; toolCallId?: string };
				setState((prev) => ({
					...prev,
					toolCalls: attachToolResult(prev.toolCalls, data),
				}));
			} catch {
				// Ignore parse errors
			}
		});

		es.addEventListener('board-context', (e) => {
			try {
				const data = JSON.parse(e.data);
				setState((prev) => ({ ...prev, boardContext: data }));
			} catch {
				// Ignore parse errors
			}
		});

		es.addEventListener('strategy-shift', (e) => {
			try {
				const data = JSON.parse(e.data);
				setState((prev) => ({ ...prev, strategyShift: data }));
			} catch {
				// Ignore parse errors
			}
		});

		es.addEventListener('pick', (e) => {
			try {
				const data = JSON.parse(e.data);
				setState((prev) => ({
					...prev,
					pick: data.pick ?? null,
					boardState: data.boardState ?? null,
					rosters: data.rosters ?? null,
					draftComplete: data.draftComplete,
				}));
			} catch {
				// Ignore parse errors
			}
		});

		es.addEventListener('done', () => {
			setState((prev) => ({ ...prev, isStreaming: false }));
			es.close();
			eventSourceRef.current = null;
		});

		es.addEventListener('error', (e) => {
			// Check if this is a server-sent error event or a connection error
			if (e instanceof MessageEvent && e.data) {
				try {
					const data = JSON.parse(e.data);
					setState((prev) => ({
						...prev,
						isStreaming: false,
						error: data.error ?? 'Stream error',
					}));
				} catch {
					setState((prev) => ({
						...prev,
						isStreaming: false,
						error: 'Stream error',
					}));
				}
			} else {
				// Connection error - EventSource will auto-reconnect,
				// but we should close and let the caller decide
				setState((prev) => ({
					...prev,
					isStreaming: false,
					error: 'Connection lost',
				}));
			}
			es.close();
			eventSourceRef.current = null;
		});
	}, [close]);

	const reset = useCallback(() => {
		close();
		setState({
			isStreaming: false,
			tokens: '',
			persona: undefined,
			model: undefined,
			teamIndex: undefined,
			pick: null,
			boardState: null,
			rosters: null,
			draftComplete: undefined,
			error: null,
			toolCalls: [],
			boardContext: null,
			strategyShift: null,
		});
	}, [close]);

	return {
		...state,
		startStream,
		close,
		reset,
	};
}
