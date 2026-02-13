export type DraftGenerationMode = 'structured_with_tools' | 'text_json_with_tools';

const PERSONA_GENERATION_MODE: Record<string, DraftGenerationMode> = {
	// xAI chat endpoints in our gateway currently reject tools + json_schema together.
	'drafter-qb-first': 'text_json_with_tools',
	'drafter-contrarian': 'text_json_with_tools',
	'drafter-risk-averse': 'text_json_with_tools',
};

export function getDrafterGenerationMode(persona: string): DraftGenerationMode {
	return PERSONA_GENERATION_MODE[persona] ?? 'structured_with_tools';
}
