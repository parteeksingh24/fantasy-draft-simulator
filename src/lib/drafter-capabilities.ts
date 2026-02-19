export type DraftGenerationMode = 'structured_with_tools' | 'text_json_with_tools';

const PERSONA_GENERATION_MODE: Record<string, DraftGenerationMode> = {
	// xAI models reject tools + json_schema together in the gateway.
	'drafter-qb-first': 'text_json_with_tools',
	'drafter-contrarian': 'text_json_with_tools',
	'drafter-risk-averse': 'text_json_with_tools',
	// deepseek-reasoner doesn't support JSON schema output natively.
	'drafter-stack-builder': 'text_json_with_tools',
	// claude-haiku-4-5 frequently throws AI_NoObjectGeneratedError with Output.object() + tools.
	'drafter-zero-rb': 'text_json_with_tools',
	'drafter-value-hunter': 'text_json_with_tools',
	// claude-haiku-4-5 frequently throws AI_NoObjectGeneratedError with Output.object() + tools.
	'drafter-youth-movement': 'text_json_with_tools',
	// gpt-5-mini struggles with structured output + tools in the gateway.
	'drafter-reactive': 'text_json_with_tools',
	// gpt-5-mini struggles with structured output + tools in the gateway.
	'drafter-bold': 'text_json_with_tools',
	// gpt-5-mini struggles with structured output + tools in the gateway.
	'drafter-te-premium': 'text_json_with_tools',
	// Keep gpt-5-nano behavior consistent with other non-structured personas.
	'drafter-stud-rb': 'text_json_with_tools',
};

export function getDrafterGenerationMode(persona: string): DraftGenerationMode {
	return PERSONA_GENERATION_MODE[persona] ?? 'structured_with_tools';
}
