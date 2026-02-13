import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import './App.css';
import { cn } from './lib/utils';
import { api } from './lib/api';
import type { BoardState, Player, Roster, PersonaAssignment, StrategyShift } from './lib/types';
import { TEAM_NAMES, NUM_TEAMS } from './lib/types';
import { DraftBoard } from './components/DraftBoard';
import { DraftControls } from './components/DraftControls';
import { PlayerPicker } from './components/PlayerPicker';
import { ThinkingPanel } from './components/ThinkingPanel';
import { useAdvanceStream } from './hooks/useAdvanceStream';
import { usePickTimer } from './hooks/usePickTimer';
import { TooltipProvider } from './components/ui/tooltip';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from './components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';

export function App() {
	// Draft state
	const [board, setBoard] = useState<BoardState | null>(null);
	const [rosters, setRosters] = useState<Roster[]>([]);
	const [players, setPlayers] = useState<Player[]>([]);
	const [personas, setPersonas] = useState<PersonaAssignment[] | null>(null);
	const [shifts, setShifts] = useState<StrategyShift[]>([]);

	// UI state
	const [humanTeamIndex, setHumanTeamIndex] = useState<number | null>(null);
	const [starting, setStarting] = useState(false);
	const [advancing, setAdvancing] = useState(false);
	const [picking, setPicking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [playersLoading, setPlayersLoading] = useState(false);

	// Loading state for initial hydration
	const [hydrating, setHydrating] = useState(true);

	// SSE streaming hook
	const stream = useAdvanceStream();

	// Panel visibility with exit delay
	const [showThinkingPanel, setShowThinkingPanel] = useState(false);

	useEffect(() => {
		if (stream.isStreaming) {
			setShowThinkingPanel(true);
		} else if (showThinkingPanel) {
			const timer = setTimeout(() => setShowThinkingPanel(false), 1500);
			return () => clearTimeout(timer);
		}
	}, [stream.isStreaming, showThinkingPanel]);

	// Refs to prevent duplicate concurrent calls
	const advancingRef = useRef(false);
	const startingRef = useRef(false);

	// Fetch board state from the server
	const refreshBoard = useCallback(async () => {
		try {
			const data = await api.getBoard();
			setBoard(data.board);
			setRosters(data.rosters);
			setError(null);
		} catch {
			// Board might not exist yet, that's fine
		}
	}, []);

	// Fetch available players
	const refreshPlayers = useCallback(async () => {
		try {
			setPlayersLoading(true);
			const data = await api.getPlayers();
			setPlayers(data.players);
		} catch {
			// Players might not be seeded yet
		} finally {
			setPlayersLoading(false);
		}
	}, []);

	// Fetch strategies/personas
	const refreshStrategies = useCallback(async () => {
		try {
			const data = await api.getStrategies();
			if (data.personas) {
				setPersonas(data.personas);
			}
			if (Array.isArray(data.shifts)) {
				setShifts(data.shifts);
			}
		} catch {
			// No strategies yet
		}
	}, []);

	// Hydrate from server on mount (resume in-progress draft)
	useEffect(() => {
		async function hydrate() {
			// Pre-seed player data in the background so it's ready when the user clicks Start.
			// This fetches from Sleeper API + writes to KV. The endpoint is idempotent (skips if cached).
			api.seedPlayers().catch(() => {});

			try {
				const data = await api.getBoard();
				setBoard(data.board);
				setRosters(data.rosters);
				setHumanTeamIndex(data.board.settings.humanTeamIndex);
				// Call APIs directly (not through wrapper functions that swallow errors)
				// so Promise.allSettled can detect failures
				const [playersResult, strategiesResult] = await Promise.allSettled([
					api.getPlayers(),
					api.getStrategies(),
				]);
				if (playersResult.status === 'fulfilled') {
					setPlayers(playersResult.value.players);
				}
				if (strategiesResult.status === 'fulfilled') {
					if (strategiesResult.value.personas) setPersonas(strategiesResult.value.personas);
					if (Array.isArray(strategiesResult.value.shifts)) setShifts(strategiesResult.value.shifts);
				}
				if (playersResult.status === 'rejected' || strategiesResult.status === 'rejected') {
					setError('Draft resumed, but some data failed to load. Try refreshing.');
				}
			} catch (err) {
				console.warn('No draft in progress:', err);
			} finally {
				setHydrating(false);
			}
		}
		hydrate();
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	// Reset all state for a new draft
	function handleNewDraft() {
		setBoard(null);
		setRosters([]);
		setPlayers([]);
		setPersonas(null);
		setShifts([]);
		setHumanTeamIndex(null);
		setAdvancing(false);
		setPicking(false);
		setError(null);
		advancingRef.current = false;
		stream.reset();
	}

	// Start the draft
	async function handleStart() {
		if (startingRef.current) return;
		startingRef.current = true;
		setStarting(true);
		setError(null);
		try {
			// Resolve random position at start time
			const resolvedIndex = humanTeamIndex ?? Math.floor(Math.random() * NUM_TEAMS);
			setHumanTeamIndex(resolvedIndex);
			const result = await api.startDraft(resolvedIndex);
			// Use enriched response directly (no follow-up API calls needed)
			setBoard(result.boardState);
			setPlayers(result.players);
			setRosters(result.rosters);
			setPersonas(result.personas);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to start draft');
		} finally {
			setStarting(false);
			startingRef.current = false;
		}
	}

	// Advance (trigger next AI pick) via SSE stream
	// Extract stable references to avoid re-renders from timer invalidating the auto-advance timeout
	const { startStream } = stream;
	const handleAdvance = useCallback(async () => {
		if (advancingRef.current) return;
		advancingRef.current = true;
		setAdvancing(true);
		setError(null);
		try {
			startStream();
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to advance');
			setAdvancing(false);
			advancingRef.current = false;
		}
	}, [startStream]);

	// Handle SSE stream completion: when a pick arrives, update state
	useEffect(() => {
		if (stream.boardState) {
			setBoard(stream.boardState);
		}
		if (stream.rosters) {
			setRosters(stream.rosters);
		}
		if (stream.draftComplete !== undefined && stream.boardState) {
			// Refresh all state when stream delivers a pick
			refreshPlayers();
			refreshStrategies();
		}
	}, [stream.boardState, stream.rosters, stream.draftComplete, refreshPlayers, refreshStrategies]);

	// Reset advancing state when stream finishes
	useEffect(() => {
		if (!stream.isStreaming && advancingRef.current) {
			setAdvancing(false);
			advancingRef.current = false;
		}
		if (stream.error) {
			setError(stream.error);
			setAdvancing(false);
			advancingRef.current = false;
		}
	}, [stream.isStreaming, stream.error]);

	// Human makes a pick
	const handlePick = useCallback(async (playerId: string) => {
		setPicking(true);
		setError(null);
		try {
			const result = await api.makePick(playerId);
			if (!result.success) {
				setError(result.message || 'Pick was not accepted');
				return;
			}
			// Update board directly from the pick response (more reliable than refreshBoard)
			if (result.boardState) setBoard(result.boardState);
			// Also refresh players and board in background for full state sync
			refreshPlayers().catch(() => {});
			refreshBoard().catch(() => {});
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to make pick');
		} finally {
			setPicking(false);
		}
	}, [refreshBoard, refreshPlayers]);

	// Auto-advance: when it's an AI turn and we're not already advancing
	useEffect(() => {
		if (!board || board.draftComplete) return;
		if (board.currentPick.isHuman) return;
		if (stream.isStreaming) return;

		const timer = setTimeout(() => {
			if (advancingRef.current) return;
			handleAdvance();
		}, 1500);

		return () => clearTimeout(timer);
	}, [board, handleAdvance, stream.isStreaming]);

	// Get the human team's roster
	const resolvedTeamIndex = humanTeamIndex ?? 0;
	const humanRoster = rosters.find((r) => r.teamIndex === resolvedTeamIndex) ?? null;

	const draftStarted = board !== null;
	const draftComplete = board?.draftComplete ?? false;
	const isHumanTurn = board?.currentPick.isHuman ?? false;

	// Pick timer
	const isOnClock = draftStarted && !draftComplete;

	const handleTimeout = useCallback(() => {
		if (isHumanTurn) {
			if (players.length > 0) {
				handlePick(players[0]!.playerId);
			}
		} else {
			handleAdvance();
		}
	}, [isHumanTurn, players, handlePick, handleAdvance]);

	const timer = usePickTimer(isOnClock, handleTimeout);

	return (
		<TooltipProvider>
			<div className="text-white font-sans min-h-screen flex flex-col">
				{/* Header + Controls bar - only show when draft is active */}
				{draftStarted && (
				<div className="px-6 py-3 max-w-[1600px] mx-auto w-full">
					<div className="flex items-center justify-between mb-3">
						<div>
							<h1 className="text-xl font-thin tracking-wide">
								Fantasy Draft Simulator
							</h1>
							<p className="text-xs text-gray-600 mt-0.5">
								AI-powered 12-team snake draft
							</p>
						</div>
						{!draftComplete && isHumanTurn && (
							<Badge className="bg-cyan-500/15 border-cyan-500/30 text-cyan-400 animate-pulse hover:bg-cyan-500/20">
								Your turn to pick!
							</Badge>
						)}
						{draftComplete && (
							<Badge className="bg-green-500/15 border-green-500/30 text-green-400 hover:bg-green-500/20">
								Draft Complete
							</Badge>
						)}
					</div>
					<DraftControls
							board={board}
							onStart={handleStart}
							onAdvance={handleAdvance}
							onNewDraft={handleNewDraft}
							humanTeamIndex={humanTeamIndex}
							setHumanTeamIndex={setHumanTeamIndex}
							starting={starting}
							advancing={advancing}
							personas={personas}
							timerDisplay={timer.display}
							timerPercent={timer.percent}
						/>
				</div>
				)}

				{/* Error banner */}
				<AnimatePresence>
					{error && (
						<motion.div
							initial={{ height: 0, opacity: 0 }}
							animate={{ height: 'auto', opacity: 1 }}
							exit={{ height: 0, opacity: 0 }}
							transition={{ duration: 0.2 }}
							className="overflow-hidden"
						>
							<div className="px-6 py-2 bg-red-500/10 border-b border-red-500/20">
								<div className="max-w-[1600px] mx-auto flex items-center justify-between">
									<span className="text-xs text-red-400">{error}</span>
									<button
										onClick={() => setError(null)}
										className="text-xs text-red-500 hover:text-red-400 cursor-pointer"
									>
										Dismiss
									</button>
								</div>
							</div>
						</motion.div>
					)}
				</AnimatePresence>

				{/* Main content */}
				<div className="flex-1 px-6 pb-6 max-w-[1600px] mx-auto w-full flex flex-col">
					{hydrating ? (
						<div className="flex-1 flex items-center justify-center">
							<div className="text-center">
								<div className="text-4xl mb-4 animate-spin opacity-40">&#127944;</div>
								<h2 className="text-lg text-gray-300 font-light">Loading...</h2>
							</div>
						</div>
					) : !draftStarted ? (
						<div className="flex-1 flex items-center justify-center">
							<div className="max-w-xl w-full text-center">
								{starting ? (
									<div className="bg-gray-900/60 border border-gray-800 rounded-xl p-10">
										<div className="text-4xl mb-4 animate-spin opacity-40">&#127944;</div>
										<h2 className="text-lg text-gray-300 font-light mb-2">Setting up draft...</h2>
										<p className="text-sm text-gray-400">
											Fetching player data and seeding AI agents. This may take a moment on the first run.
										</p>
									</div>
								) : (
									<div className="bg-gray-900/60 border border-gray-800 rounded-xl p-10">
										{/* Header */}
										<div className="text-5xl mb-5 opacity-75">&#127944;</div>
										<h1 className="text-4xl font-thin tracking-wide mb-2">
											Fantasy Draft Simulator
										</h1>
										<p className="text-base text-gray-400 mb-8 max-w-md mx-auto">
											11 AI agents with unique strategies will compete against you in a 5-round snake draft.
										</p>

										{/* Draft setup */}
										<div className="flex items-center justify-center gap-3 mb-3">
											<label className="text-base text-gray-400">
												Draft Position
											</label>
											<Select
												value={humanTeamIndex === null ? 'random' : String(humanTeamIndex)}
												onValueChange={(val) => setHumanTeamIndex(val === 'random' ? null : Number(val))}
											>
												<SelectTrigger size="sm" className="w-[100px] text-sm bg-gray-800 border-gray-700 text-gray-300">
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

										<Button
											onClick={handleStart}
											disabled={starting}
											className="w-full bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/30 hover:border-cyan-500/50 cursor-pointer"
										>
											Start Draft
										</Button>

										{/* Powered by Agentuity */}
										<div className="mt-8 pt-6 border-t border-gray-800/50">
											<p className="text-sm text-gray-600 mb-4">
												Powered by <a href="https://agentuity.dev" target="_blank" rel="noopener noreferrer" className="text-cyan-500/70 hover:text-cyan-400 transition-colors">Agentuity</a>
											</p>
											<div className="flex flex-wrap items-center justify-center gap-2">
												{[
													{
														label: 'Multi-Agent',
														title: 'Multi-Agent Orchestration',
														desc: '11 AI drafter agents, each with a unique persona and strategy, orchestrated by a commissioner agent. No LLM needed for orchestration.',
													},
													{
														label: 'AI Gateway',
														title: 'AI Gateway',
														desc: 'Route to any LLM provider through a single API. Each drafter uses a different model: GPT-5, Claude, Gemini, Grok, DeepSeek.',
													},
													{
														label: 'KV Storage',
														title: 'KV Storage',
														desc: 'Persistent key-value storage for draft state, team rosters, persona assignments, and strategy shift history. Survives across requests.',
													},
													{
														label: 'Smart Picks',
														title: 'Rank-Based Intelligence',
														desc: 'Agents evaluate 150+ NFL players ranked by ADP, filtered by roster eligibility, and scored against persona strategy.',
													},
													{
														label: 'SSE Streaming',
														title: 'SSE Streaming',
														desc: 'Server-sent events stream each agent\'s thinking tokens in real-time. Watch the AI reason through its pick live.',
													},
												].map((feature) => (
													<span
														key={feature.label}
														className="group relative"
													>
														<span className="text-sm text-gray-500 border border-gray-800 rounded-md px-3 py-1.5 bg-gray-900/50 hover:border-gray-700 hover:text-gray-400 transition-colors cursor-help inline-block">
															{feature.label}
														</span>

														{/* Tooltip */}
														<div className="group-hover:flex hidden absolute left-1/2 -translate-x-1/2 bg-gray-900 border border-gray-800 rounded-lg p-4 leading-normal z-10 mb-2 shadow-2xl text-left w-80 bottom-full flex-col gap-2">
															<div className="text-base text-white font-semibold">{feature.title}</div>
															<p className="text-sm text-gray-400">{feature.desc}</p>
														</div>
													</span>
												))}
											</div>
										</div>
									</div>
								)}
							</div>
						</div>
					) : (
						<div className="flex flex-col gap-4">
							{/* Top section: Draft Board (full width, prominent) */}
							<DraftBoard
								board={board}
								humanTeamIndex={resolvedTeamIndex}
								personas={personas}
								shifts={shifts}
								latestPickNumber={board?.picks.length ? board.picks[board.picks.length - 1]!.pickNumber : undefined}
							/>

							{/* Bottom section: PlayerPicker + ThinkingPanel with fixed height */}
							{!draftComplete && (
								<div className="flex gap-4" style={{ height: '420px' }}>
									{/* Left: Player picker (always visible, smoothly expands) */}
									<motion.div layout className="flex-1 min-w-0 overflow-hidden">
										{playersLoading && players.length === 0 ? (
											<div className="h-full flex items-center justify-center bg-gray-900/80 rounded-xl border border-gray-800/50">
												<p className="text-sm text-gray-600">Loading players...</p>
											</div>
										) : (
											<PlayerPicker
												players={players}
												roster={humanRoster}
												isHumanTurn={isHumanTurn}
												onPick={handlePick}
												picking={picking}
											/>
										)}
									</motion.div>

									{/* Right: Thinking panel (slides in/out) */}
									<AnimatePresence>
										{showThinkingPanel && (
											<motion.div
												initial={{ width: 0, opacity: 0, x: 40 }}
												animate={{ width: 320, opacity: 1, x: 0 }}
												exit={{ width: 0, opacity: 0, x: 40 }}
												transition={{ type: 'spring', stiffness: 300, damping: 30 }}
												className="flex-shrink-0 overflow-hidden"
											>
												<ThinkingPanel
													personas={personas}
													isStreaming={stream.isStreaming}
													streamTokens={stream.tokens}
													streamPersona={stream.persona}
													streamModel={stream.model}
													streamTeamIndex={stream.teamIndex}
													toolCalls={stream.toolCalls}
												/>
											</motion.div>
										)}
									</AnimatePresence>
								</div>
							)}

							{/* Draft complete summary */}
							{draftComplete && (
								<motion.div
									initial={{ opacity: 0, y: 20 }}
									animate={{ opacity: 1, y: 0 }}
									transition={{ duration: 0.4, ease: 'easeOut' }}
								>
									<Card className="bg-gray-900/60 border-green-500/20">
										<CardHeader>
											<CardTitle className="text-sm text-green-400">
												Draft Complete
											</CardTitle>
										</CardHeader>
										<CardContent>
											<div className="grid grid-cols-4 gap-3">
												{rosters.map((roster) => {
													const isHuman = roster.teamIndex === resolvedTeamIndex;
													return (
														<Card
															key={roster.teamIndex}
															size="sm"
															className={cn(
																'p-2 gap-1 shadow-none',
																isHuman
																	? 'bg-cyan-500/10 border-cyan-500/20'
																	: 'bg-gray-900/50 border-gray-800',
															)}
														>
															<div className={cn(
																'text-xs font-semibold',
																isHuman ? 'text-cyan-400' : 'text-gray-400',
															)}>
																{TEAM_NAMES[roster.teamIndex]}
																{isHuman && ' (You)'}
															</div>
															{(['qb', 'rb', 'wr', 'te', 'superflex'] as const).map((slot) => {
																const player = roster[slot];
																return (
																	<div key={slot} className="text-xs text-gray-500 flex justify-between py-0.5">
																		<span className="uppercase text-gray-600 w-6">
																			{slot === 'superflex' ? 'FX' : slot}
																		</span>
																		<span className="text-gray-400 truncate flex-1 text-right">
																			{player?.name ?? '--'}
																		</span>
																	</div>
																);
															})}
														</Card>
													);
												})}
											</div>
										</CardContent>
									</Card>
								</motion.div>
							)}
						</div>
					)}
				</div>
			</div>
		</TooltipProvider>
	);
}
