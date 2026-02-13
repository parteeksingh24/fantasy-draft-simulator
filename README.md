# Fantasy Draft Simulator

12-team AI mock draft simulator. 11 AI agents with distinct drafting personas compete against 1 human player in a 5-round SUPERFLEX snake draft.

Built on [Agentuity](https://agentuity.dev). Each agent uses a different LLM, calls tools autonomously to research players, and adapts strategy in real time based on board dynamics.

## How It Works

```
                         ┌─────────────────────┐
                         │   React Frontend    │
                         │   (SSE streaming)   │
                         └────────┬────────────┘
                                  │
                         ┌────────▼────────────┐
                         │    API Routes        │
                         │    (Hono router)     │
                         └────────┬────────────┘
                                  │
                         ┌────────▼────────────┐
                         │   Commissioner       │
                         │   (no LLM, pure      │
                         │    orchestration)     │
                         └────────┬────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
     ┌────────▼──────┐  ┌────────▼──────┐  ┌────────▼──────┐
     │  Drafter #1   │  │  Drafter #2   │  │  Drafter #N   │
     │  (claude-     │  │  (gpt-5-mini) │  │  (grok-4-1)   │
     │   sonnet-4-5) │  │               │  │               │
     └───────┬───────┘  └───────┬───────┘  └───────┬───────┘
             │                  │                  │
             └──────────────────┼──────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │                       │
             ┌──────▼──────┐        ┌───────▼──────┐
             │  KV Storage │        │ Vector Store │
             │  (state,    │        │ (semantic    │
             │   rosters)  │        │  player      │
             └─────────────┘        │  search)     │
                                    └──────────────┘
```

The **commissioner** manages snake draft ordering, pick validation, and roster enforcement without any LLM calls. Each **drafter agent** receives board state, uses tools to research available players, then returns a structured pick via `generateText` or `streamText`. The frontend consumes the SSE stream to show the agent's reasoning, tool calls, and final pick in real time.

## Agentuity Platform Features

This project uses six Agentuity platform capabilities. Here is how each one is wired up.

| Feature | What It Does Here | Source File |
|---------|-------------------|-------------|
| Agent orchestration | Commissioner calls persona-specific drafter agents via `agent.run()` | `src/agent/commissioner/index.ts` |
| KV Storage | Board state, rosters, persona assignments, strategy shifts | `src/lib/seed-players.ts`, `src/agent/commissioner/index.ts` |
| Vector Storage | Semantic player search ("elite young wide receiver") with embedded metadata | `src/lib/drafter-tools.ts` |
| SSE streaming | `sse()` helper streams thinking tokens, tool calls, and picks to the frontend | `src/api/index.ts` |
| AI Gateway | Each persona routes to a different LLM provider through Agentuity's gateway | `src/lib/drafter-models.ts` |
| Hono router | `createRouter()` from `@agentuity/runtime` defines all API routes | `src/api/index.ts` |

**Agent orchestration.** The commissioner is a non-LLM agent that looks up the on-clock team's persona, resolves the matching drafter agent, and calls it:

```typescript
// src/agent/commissioner/index.ts
const drafterAgent = DRAFTER_AGENTS[personaName] ?? drafterBalanced;
const drafterResult = await drafterAgent.run(drafterInput);
```

**KV Storage.** Draft state, rosters, and persona assignments are persisted across requests in three KV namespaces. The seed pipeline writes the player list to KV as the source of truth for availability:

```typescript
// src/lib/seed-players.ts
await kv.set(KV_DRAFT_STATE, KEY_AVAILABLE_PLAYERS, players, { ttl: null });
```

**Vector Storage.** The `searchPlayers` tool runs semantic queries against embedded player documents so agents can search by natural language ("safe veteran quarterback") instead of exact filters:

```typescript
// src/lib/drafter-tools.ts
const results = await deps.vector.search<PlayerMetadata>(VECTOR_PLAYERS, {
  query,
  limit: normalizedLimit,
});
```

**SSE streaming.** The `/draft/advance/stream` endpoint uses the `sse()` helper from `@agentuity/runtime` to stream events as the AI thinks:

```typescript
// src/api/index.ts
import { createRouter, sse } from '@agentuity/runtime';

api.get('/draft/advance/stream', sse(async (c, stream) => {
  // Stream thinking tokens, tool calls, and the final pick
  await stream.writeSSE({ event: 'thinking', data: part.text });
}));
```

**AI Gateway.** Each persona maps to a different model and provider. The gateway handles routing, so agent code just references provider SDKs:

```typescript
// src/lib/drafter-models.ts
export const DRAFTER_MODELS: Record<string, LanguageModel> = {
  'drafter-balanced': anthropic('claude-sonnet-4-5'),
  'drafter-bold':     openai('gpt-5-mini'),
  'drafter-qb-first': xai('grok-3-fast'),
  'drafter-stack-builder': deepseek('deepseek-reasoner'),
  'drafter-te-premium':    moonshotai('kimi-k2.5'),
  // ...
};
```

**Hono router.** API routes are defined with `createRouter()` from `@agentuity/runtime`, which provides a Hono-compatible router with built-in access to `c.var.kv`, `c.var.vector`, and `c.var.logger`:

```typescript
// src/api/index.ts
import { createRouter, sse } from '@agentuity/runtime';
const api = createRouter();

api.post('/draft/start', async (c) => {
  await ensureSeeded(c.var.kv, c.var.vector, c.var.logger);
  const result = await commissioner.run({ action: 'start', humanTeamIndex });
  return c.json(result);
});
```

## Personas and Models

Each draft randomly assigns personas from a weighted pool. Duplicates are allowed (multiple teams can share a strategy). 2 reactive agents are always guaranteed.

| Persona | Model | Provider | Strategy |
|---------|-------|----------|----------|
| balanced | claude-sonnet-4-5 | Anthropic | Best Player Available, weighs value and positional need equally |
| bold | gpt-5-mini | OpenAI | Swing for upside, reaches for breakout candidates |
| zero-rb | claude-haiku-4-5 | Anthropic | Avoids RBs in rounds 1-3, prioritizes WR/QB/TE |
| qb-first | grok-3-fast | xAI | Secures an elite QB early, treats SUPERFLEX QB advantage as critical |
| stud-rb | gpt-5-nano | OpenAI | Locks in a bellcow RB round 1, values volume and touches |
| value-hunter | claude-haiku-4-5 | Anthropic | Picks the biggest value drop regardless of position |
| stack-builder | deepseek-reasoner | DeepSeek | Builds QB/WR same-team stacks for correlated upside |
| te-premium | kimi-k2.5 | Moonshot AI | Reaches for elite TEs early, exploits the TE wasteland |
| youth-movement | claude-haiku-4-5 | Anthropic | Targets players under 26, avoids aging veterans |
| contrarian | grok-4-1-fast-reasoning | xAI | Goes against position runs, exploits herd behavior |
| risk-averse | grok-4-1-fast-reasoning | xAI | Takes the highest-ranked safe player, never reaches |
| reactive | gpt-5-mini | OpenAI | Follows board momentum, panics into position runs, jumps on value drops |

Most personas use `structured_with_tools` generation (structured output + tool calling). xAI models use `text_json_with_tools` because the gateway does not support tools + JSON schema together for those models.

## Agent Tools

Agents choose which tools to call autonomously. Each agent has a step budget of 4 via `stopWhen: stepCountIs(4)`.

| Tool | Description | Inputs |
|------|-------------|--------|
| `searchPlayers` | Semantic search via Vector storage. Finds players matching natural language queries. Falls back to rank-based results if Vector is unavailable. | `query` (string), `position?` (QB/RB/WR/TE), `limit?` (default 10) |
| `getTopAvailable` | Returns top available players sorted by rank. The go-to tool for seeing who's on the board. | `position?` (QB/RB/WR/TE), `limit?` (default 15) |
| `analyzeBoardTrends` | Detects position runs, value drops, and scarcity alerts from recent draft activity. | (none) |
| `getTeamRoster` | Returns any team's current roster and open slots. Useful for predicting opponent picks. | `teamIndex` (0-11) |

Example tool definition from `src/lib/drafter-tools.ts`:

```typescript
searchPlayers: tool({
  description:
    'Semantic search for players via Vector storage. Use this to find players '
    + 'matching a natural language query (e.g. "elite young wide receiver").',
  inputSchema: z.object({
    query: z.string().describe('Natural language search query'),
    position: z.enum(['QB', 'RB', 'WR', 'TE']).optional(),
    limit: z.number().optional().default(10),
  }),
  execute: async ({ query, position, limit }) => {
    const results = await deps.vector.search(VECTOR_PLAYERS, { query, limit });
    // Filter to available players, apply position filter, check roster eligibility
    return { status: 'ok', query, results: players, source: 'vector' };
  },
}),
```

## Board Analysis and Strategy Shifts

Before each pick, the system runs board analysis to detect three types of signals:

- **Position runs**: 3+ picks at the same position in the last 8 picks. Signals teams are racing to fill that position.
- **Value drops**: Players available 8+ picks past their expected rank. Indicates overlooked value.
- **Scarcity alerts**: 5 or fewer players remaining at a position. Warns that a position pool is drying up.

These signals are injected into each agent's prompt and available via the `analyzeBoardTrends` tool.

**Strategy shifts** are detected after each pick by comparing what the agent actually did against what their persona would normally do. For example:

```typescript
case 'drafter-zero-rb':
  // Zero-RB should avoid RBs in rounds 1-3
  if (position === 'RB' && round <= 3) {
    return `Zero-RB persona drafted an RB (${pick.playerName}) in round ${round}, breaking their core strategy.`;
  }
  break;
```

When a shift is detected, it's stored in KV and emitted as an SSE event so the frontend can display a shift indicator on the pick.

## Streaming Events

The `GET /draft/advance/stream` endpoint uses Server-Sent Events to stream the AI pick process in real time.

| Event | Description |
|-------|-------------|
| `metadata` | Persona name, model, generation mode, team info, pick number |
| `board-context` | Position runs, value drops, scarcity alerts detected before the pick |
| `thinking` | Text delta tokens from the LLM's reasoning |
| `tool-call` | Agent called a tool (name, args) |
| `tool-result` | Tool returned results (truncated to 5 items for large arrays) |
| `strategy-shift` | Pick contradicted the persona's expected behavior |
| `pick` | Final pick with updated board state and rosters |
| `done` | Stream complete |
| `error` | Something went wrong |

The frontend consumes these via native `EventSource`, managed by the `useAdvanceStream` hook in `src/web/hooks/useAdvanceStream.ts`.

## Roster Format

| Slot | Position |
|------|----------|
| QB | 1 Quarterback |
| RB | 1 Running Back |
| WR | 1 Wide Receiver |
| TE | 1 Tight End |
| SUPERFLEX | Any position (QB/RB/WR/TE) |

5 rounds, snake draft order: odd rounds pick 1-12, even rounds pick 12-1.

## Project Structure

```
src/
├── agent/
│   ├── commissioner/index.ts       # Draft orchestration, no LLM
│   ├── drafter-balanced/index.ts   # claude-sonnet-4-5
│   ├── drafter-bold/index.ts       # gpt-5-mini
│   ├── drafter-zero-rb/index.ts    # claude-haiku-4-5
│   ├── drafter-qb-first/index.ts   # grok-3-fast
│   ├── drafter-stud-rb/index.ts    # gpt-5-nano
│   ├── drafter-value-hunter/index.ts  # claude-haiku-4-5
│   ├── drafter-stack-builder/index.ts # deepseek-reasoner
│   ├── drafter-te-premium/index.ts    # kimi-k2.5
│   ├── drafter-youth-movement/index.ts # claude-haiku-4-5
│   ├── drafter-contrarian/index.ts    # grok-4-1-fast-reasoning
│   ├── drafter-risk-averse/index.ts   # grok-4-1-fast-reasoning
│   └── drafter-reactive/index.ts      # gpt-5-mini
├── api/
│   └── index.ts                    # Hono routes + SSE streaming endpoint
├── lib/
│   ├── types.ts                    # Shared types, KV keys, roster logic
│   ├── drafter-models.ts           # Persona-to-model mapping, system prompts
│   ├── drafter-capabilities.ts     # Generation mode per persona
│   ├── drafter-common.ts           # Shared handler factory, schemas, prompt builders
│   ├── drafter-tools.ts            # 4 AI SDK tools for player research
│   ├── board-analysis.ts           # Position runs, value drops, scarcity, shift detection
│   ├── record-pick.ts              # Pick recording, roster updates, shift detection
│   ├── seed-players.ts             # Sleeper API fetch, KV + Vector seeding
│   └── persona-assignment.ts       # Weighted random persona assignment
└── web/
    ├── App.tsx                     # Main app layout
    ├── frontend.tsx                # Entry point
    ├── components/
    │   ├── DraftBoard.tsx          # 12-column draft grid
    │   ├── DraftControls.tsx       # Start draft, pick position
    │   ├── PlayerPicker.tsx        # Human pick interface
    │   ├── ThinkingPanel.tsx       # Live agent reasoning panel
    │   ├── PickTooltip.tsx         # Hover tooltip with pick reasoning
    │   ├── ToolCallChip.tsx        # Tool call display chip
    │   └── ui/                     # shadcn components
    ├── hooks/
    │   ├── useAdvanceStream.ts     # SSE stream consumer
    │   └── usePickTimer.ts         # Pick timer
    └── lib/
        ├── api.ts                  # API client
        ├── types.ts                # Frontend types
        └── utils.ts                # Tailwind merge utility
```

## Getting Started

```bash
git clone <repo-url>
cd fantasy-draft-simulator
bun install
agentuity login
bun run dev
```

Open `http://localhost:3500`, pick your draft position, and start the draft.

| Command | Description |
|---------|-------------|
| `bun run dev` | Start dev server at localhost:3500 |
| `bun run build` | Build for deployment |
| `bun run typecheck` | TypeScript type checking |
| `bun run deploy` | Deploy to Agentuity Cloud |

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/health` | Health check |
| POST | `/draft/seed` | Seed player data into KV + Vector. Skips if already seeded. |
| POST | `/draft/start` | Initialize a new draft. Seeds data, resets state, assigns personas. |
| GET | `/draft/board` | Get current board state, rosters, and available player count. |
| POST | `/draft/pick` | Human makes a pick. Body: `{ "playerId": "..." }` |
| POST | `/draft/advance` | Trigger the next AI pick (non-streaming). |
| GET | `/draft/advance/stream` | SSE stream for AI pick with live thinking, tool calls, and events. |
| GET | `/draft/players` | Get available players list for the human pick interface. |
| GET | `/draft/strategies` | Get persona assignments and strategy shifts. |

## Storage

### KV Namespaces

| Namespace | Key | Purpose |
|-----------|-----|---------|
| `draft-state` | `board-state` | Current pick, all picks, draft settings |
| `draft-state` | `available-players` | Players still on the board (source of truth) |
| `team-rosters` | `team-{0..11}` | Per-team roster (QB, RB, WR, TE, SUPERFLEX slots) |
| `agent-strategies` | `persona-assignments` | Which persona is assigned to each team |
| `agent-strategies` | `strategy-shifts` | Detected strategy shift events |

### Vector Namespace

| Namespace | Content |
|-----------|---------|
| `players` | 150 NFL players embedded with metadata (name, position, team, rank, tier, age, bye week) for semantic search |

## Data Source

Player data comes from the [Sleeper API](https://docs.sleeper.com/) (free, no auth required):

```
https://api.sleeper.app/v1/players/nfl
```

The seed pipeline fetches the full player database (~5MB JSON), filters to the top 150 by `search_rank`, keeps only QB/RB/WR/TE positions, and maps each player to a structured format with rank, tier, age, and bye week.

Players are stored in **KV** (availability source of truth, fast reads) and **Vector** (semantic search for the `searchPlayers` tool, seeded in the background).

## Drafter Agent Pattern

All 12 drafter agents share the `createDrafterHandler()` factory and differ only in their system prompt and model:

```typescript
import { createAgent } from '@agentuity/runtime';
import { DrafterInputSchema, DrafterOutputSchema, createDrafterHandler } from '../../lib/drafter-common';
import { anthropic } from '@ai-sdk/anthropic';

export default createAgent('drafter-balanced', {
  description: 'AI drafter with a balanced BPA strategy.',
  schema: {
    input: DrafterInputSchema,
    output: DrafterOutputSchema,
  },
  handler: createDrafterHandler({
    name: 'drafter-balanced',
    systemPrompt: `You are a fantasy football drafter with a balanced strategy...`,
    model: anthropic('claude-sonnet-4-5'),
  }),
});
```

The handler builds tools, constructs a prompt from board state, calls the LLM with `generateText` (or `streamText` in the SSE endpoint), validates the pick against the available player list and roster constraints, and falls back to the highest-ranked eligible player if the LLM output is invalid.

## Links

- [Agentuity](https://agentuity.dev)
- [Sleeper API](https://docs.sleeper.com/)
- [Vercel AI SDK](https://ai-sdk.dev)
- [Bun](https://bun.sh)

## License

Apache-2.0
