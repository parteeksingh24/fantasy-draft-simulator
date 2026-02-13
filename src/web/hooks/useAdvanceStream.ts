/**
 * Custom hook for SSE streaming of AI draft picks.
 * Uses native EventSource to connect to GET /api/draft/advance/stream.
 * Accumulates reasoning tokens and delivers the final pick.
 */
import { useState, useCallback, useRef } from 'react';
import type { BoardState, Pick, Roster, ToolCallRecord } from '../lib/types';

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
	});

	const eventSourceRef = useRef<EventSource | null>(null);

	const close = useCallback(() => {
		if (eventSourceRef.current) {
			eventSourceRef.current.close();
			eventSourceRef.current = null;
		}
	}, []);

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
				const data = JSON.parse(e.data) as { name: string; args: Record<string, unknown> };
				setState((prev) => ({
					...prev,
					toolCalls: [...prev.toolCalls, { name: data.name, args: data.args, timestamp: Date.now() }],
				}));
			} catch {
				// Ignore parse errors
			}
		});

		es.addEventListener('tool-result', (e) => {
			try {
				const data = JSON.parse(e.data) as { name: string; result: unknown };
				setState((prev) => ({
					...prev,
					toolCalls: prev.toolCalls.map((tc) =>
						tc.name === data.name && !tc.result ? { ...tc, result: data.result } : tc,
					),
				}));
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
		});
	}, [close]);

	return {
		...state,
		startStream,
		close,
		reset,
	};
}
