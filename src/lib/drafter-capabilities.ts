export type DraftGenerationMode = 'structured_with_tools' | 'text_json_with_tools';

const PERSONA_GENERATION_MODE: Record<string, DraftGenerationMode> = {
	// xAI models reject tools + json_schema together in the gateway.
	'drafter-qb-first': 'text_json_with_tools',
	'drafter-contrarian': 'text_json_with_tools',
	'drafter-risk-averse': 'text_json_with_tools',
	// deepseek-reasoner doesn't support JSON schema output natively;
	// AI SDK compatibility mode (schema in system message) produces unparseable responses.
	'drafter-stack-builder': 'text_json_with_tools',
};

export function getDrafterGenerationMode(persona: string): DraftGenerationMode {
	return PERSONA_GENERATION_MODE[persona] ?? 'structured_with_tools';
}
