# Fantasy Draft Simulator

8-team AI mock draft simulator built on [Agentuity](https://agentuity.dev). 7 AI agents with distinct drafting personas compete against 1 human player in a 5-round SUPERFLEX snake draft. Each agent uses a different LLM from a different provider, calls tools to research players, and adapts strategy based on board dynamics.

[![Watch the demo](https://img.youtube.com/vi/yJaRJKEQafM/maxresdefault.jpg)](https://www.youtube.com/watch?v=yJaRJKEQafM)

## Getting Started

```bash
git clone https://github.com/parteeksingh24/fantasy-draft-simulator.git
cd fantasy-draft-simulator
bun install
agentuity login
bun run dev
```

Open `http://localhost:3500`, pick your draft position, and start the draft.

| Command | Description |
|---------|-------------|
| `bun run dev` | Start dev server |
| `bun run build` | Build for deployment |
| `bun run typecheck` | TypeScript type checking |
| `bun run deploy` | Deploy to Agentuity Cloud |

## Platform Features Used

| Feature | Usage |
|---------|-------|
| **Agent orchestration** | Commissioner calls drafter agents via `agent.run()`. No LLM, pure orchestration. |
| **KV Storage** | Board state, rosters, persona assignments, scouting notes, reasoning summaries across 5 namespaces. |
| **Durable Streams** | Each AI pick's thinking process recorded as NDJSON for replay. |
| **SSE streaming** | `sse()` helper streams thinking tokens, tool calls, and picks to the frontend. |
| **AI Gateway** | 12 personas across 4 LLM providers, all routed through a single gateway. |
| **Hono router** | `createRouter()` defines API routes with built-in `c.var.kv`, `c.var.stream`, `c.var.logger`. |

## Personas and Models

Personas are randomly assigned from a weighted pool at draft start. Duplicates are allowed. 2 reactive agents are always guaranteed.

| Persona | Model | Provider | Strategy |
|---------|-------|----------|----------|
| balanced | claude-sonnet-4-5 | Anthropic | Best Player Available, weighs value and need equally |
| bold | gpt-5-mini | OpenAI | Swings for upside, reaches for breakout candidates |
| zero-rb | claude-haiku-4-5 | Anthropic | Avoids RBs in rounds 1-3, prioritizes WR/QB/TE |
| qb-first | grok-4-fast-reasoning | xAI | Secures an elite QB early for SUPERFLEX advantage |
| stud-rb | gpt-5-nano | OpenAI | Locks in a bellcow RB round 1 |
| value-hunter | claude-haiku-4-5 | Anthropic | Picks the biggest value drop regardless of position |
| stack-builder | deepseek-reasoner | DeepSeek | Builds QB/WR same-team stacks |
| te-premium | gpt-5-mini | OpenAI | Reaches for elite TEs early |
| youth-movement | claude-haiku-4-5 | Anthropic | Targets players under 26, avoids aging veterans |
| contrarian | grok-4-1-fast-reasoning | xAI | Goes against position runs |
| risk-averse | grok-code-fast-1 | xAI | Takes the highest-ranked safe player, never reaches |
| reactive | gpt-5-mini | OpenAI | Panics into position runs, jumps on value drops |

Models are defined once in `src/lib/drafter-models.ts`. Both the SSE streaming path and the commissioner's `agent.run()` path import from the same source:

```typescript
// src/lib/drafter-models.ts
export const DRAFTER_MODELS: Record<string, LanguageModel> = {
  'drafter-balanced':      anthropic('claude-sonnet-4-5'),
  'drafter-bold':          openai('gpt-5-mini'),
  'drafter-te-premium':    openai('gpt-5-mini'),
  'drafter-youth-movement': anthropic('claude-haiku-4-5'),
  // ... 12 total
};

// src/agent/drafter-balanced/index.ts
import { DRAFTER_MODELS } from '../../lib/drafter-models';

handler: createDrafterHandler({
  name: 'drafter-balanced',
  systemPrompt: '...',
  model: DRAFTER_MODELS['drafter-balanced']!,
}),
```

## Agent Tools

Each agent gets a budget of 4 tool calls (`TOOL_BUDGET`). The runtime caps total steps at 7 (`MAX_STEPS`).

| Tool | What the agent asks | What it returns |
|------|--------------------|-----------------|
| `getTopAvailable` | "Who's still on the board?" | Ranked players filtered by roster eligibility. Optional position filter. |
| `analyzeBoardTrends` | "What's happening around me?" | Position runs, value drops, scarcity alerts from recent picks. |
| `getTeamRoster` | "What does Team X have?" | Any team's roster and open slots. |
| `getDraftIntel` | "What do I know?" | Own scouting notes + recent pick reasoning from other teams. |
| `writeScoutingNote` | "Remember this for later." | Saves a note to KV (max 10 per team, FIFO). |

Typical pick sequence: `getTeamRoster` -> `getDraftIntel` -> `analyzeBoardTrends` -> `getTopAvailable` -> `writeScoutingNote`.

## Board Analysis and Strategy Shifts

Before each pick, board analysis detects three signal types:

| Signal | Trigger | Example |
|--------|---------|---------|
| Position run | 3+ picks at the same position in the last 8 picks | "3 RBs just went off the board" |
| Value drop | Player available 8+ picks past expected rank | "Elite WR fell way past ADP" |
| Scarcity alert | 5 or fewer players remaining at a position | "Only 2 TEs left in top tier" |

Signals are injected into the agent's prompt and available via `analyzeBoardTrends`.

**Strategy shifts** are detected after each pick by comparing what the agent did against what their persona would normally do. When a zero-rb agent drafts an RB in round 2, that's a shift. Shifts are stored in KV and emitted as SSE events for the frontend.

## SSE Events

`GET /draft/advance/stream` streams the AI pick process in real time.

| Event | Data |
|-------|------|
| `metadata` | Persona, model, team info, pick number |
| `board-context` | Position runs, value drops, scarcity alerts |
| `thinking` | LLM reasoning tokens |
| `tool-call` | Tool name and args |
| `tool-result` | Tool output (large arrays truncated to 5 items) |
| `strategy-shift` | Pick contradicted the persona's expected behavior |
| `pick` | Final pick, updated board state, rosters |
| `done` | Stream complete |
| `error` | Error details |

## Roster Format

5 slots per team: QB, RB, WR, TE, SUPERFLEX (any position). 5 rounds, 8 teams, 40 total picks. Snake order: odd rounds 1-8, even rounds 8-1.

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/health` | Health check |
| POST | `/draft/seed` | Seed player data from Sleeper API into KV |
| POST | `/draft/start` | Initialize a new draft (seeds, resets, assigns personas) |
| GET | `/draft/board` | Current board state, rosters, available count |
| POST | `/draft/pick` | Human pick. Body: `{ "playerId": "..." }` |
| POST | `/draft/advance` | Next AI pick (non-streaming) |
| GET | `/draft/advance/stream` | Next AI pick (SSE with live thinking) |
| GET | `/draft/players` | Available players and seed timestamp |
| GET | `/draft/strategies` | Persona assignments and strategy shifts |
| POST | `/draft/end` | End draft early |
| POST | `/draft/reset` | Reset all draft state |

## KV Storage

| Namespace | Keys | Purpose |
|-----------|------|---------|
| `draft-state` | `board`, `settings`, `available-players`, `seeded-at` | Board state, draft settings, player pool, seed timestamp |
| `team-rosters` | `team-{0..7}` | Per-team roster slots |
| `agent-strategies` | `persona-assignments`, `strategy-shifts` | Persona mapping, detected shifts |
| `team-scouting-notes` | `team-{0..7}` | Agent-written notes (max 10, FIFO) |
| `pick-reasoning` | `pick-{1..40}` | Reasoning summaries per AI pick |

Each AI pick also writes to a **durable stream** (`pick-reasoning` namespace) as NDJSON for UI replay.

## Data Source

Player data from the [Sleeper API](https://docs.sleeper.com/) (free, no auth). The seed pipeline fetches the full player database, filters to the top 150 by `search_rank`, keeps QB/RB/WR/TE only, and maps to a structured format with rank, tier, age, and bye week.

## Project Structure

```
src/
├── agent/
│   ├── commissioner/          # Draft orchestration (no LLM)
│   └── drafter-*/             # 12 persona agents, each imports model from drafter-models.ts
├── api/
│   └── index.ts               # Hono routes + SSE streaming
├── lib/
│   ├── drafter-models.ts      # Persona-to-model mapping (single source of truth)
│   ├── drafter-common.ts      # Shared handler factory, schemas, prompt builders
│   ├── drafter-tools.ts       # 5 AI SDK tools
│   ├── drafter-capabilities.ts # Generation mode per persona
│   ├── drafter-runtime-config.ts # TOOL_BUDGET, MAX_STEPS
│   ├── board-analysis.ts      # Position runs, value drops, scarcity, shifts
│   ├── pick-engine.ts         # Pick validation, fallback logic
│   ├── record-pick.ts         # Pick recording, roster updates
│   ├── seed-players.ts        # Sleeper API fetch + KV seeding
│   ├── sleeper-blocklist.ts   # Known phantom player IDs to exclude
│   ├── persona-assignment.ts  # Weighted random persona assignment
│   └── types.ts               # Shared types, KV keys, roster logic
└── web/
    ├── components/            # DraftBoard, ThinkingPanel, PlayerPicker, etc.
    ├── hooks/                 # useAdvanceStream (SSE), usePickTimer
    └── lib/                   # API client, frontend types
```

## Links

- [Agentuity](https://agentuity.dev)
- [Sleeper API](https://docs.sleeper.com/)
- [Vercel AI SDK](https://ai-sdk.dev)
- [Bun](https://bun.sh)

## License

Apache-2.0
