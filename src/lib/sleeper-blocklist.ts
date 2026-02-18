/**
 * Known bad Sleeper player IDs that pass the active/status/team filters
 * but represent phantom or non-draftable entries.
 *
 * Maintained manually. When a phantom player is spotted in the draft,
 * add their Sleeper player_id here.
 */
export const SLEEPER_BLOCKLIST: Set<string> = new Set([
	// Add known phantom player IDs below, one per line:
	// '12345',
]);
