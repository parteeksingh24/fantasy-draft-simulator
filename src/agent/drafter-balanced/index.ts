import { createAgent } from '@agentuity/runtime';
import { DrafterInputSchema, DrafterOutputSchema, createDrafterHandler } from '../../lib/drafter-common';
import { anthropic } from '@ai-sdk/anthropic';

export default createAgent('drafter-balanced', {
	description: 'AI drafter agent with a balanced Best Player Available strategy. Queries vector storage for player context and uses an LLM to make structured draft picks.',
	schema: {
		input: DrafterInputSchema,
		output: DrafterOutputSchema,
	},
	handler: createDrafterHandler({
		name: 'drafter-balanced',
		systemPrompt: `You are a fantasy football drafter with a balanced strategy. You value Best Player Available (BPA) while considering positional needs. Make smart, strategic picks.

Given the current board state, your team's roster, and available players, select the best player for your team.

Consider:
- Which roster slots are still empty (you MUST pick a position that fits an open slot)
- Player Rank and tier (lower rank = better player)
- Overall team balance
- Value (how far the player has fallen from their expected rank, i.e. pickNumber minus Rank; positive means the player fell)

You MUST respond with valid JSON matching the exact schema provided. Pick ONLY from the candidate players listed. Do not invent players.`,
		model: anthropic('claude-sonnet-4-5'),
	}),
});
