import { cn } from '../lib/utils';
import type { ToolCallRecord } from '../lib/types';
import { TOOL_COLORS } from '../lib/types';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

function summarizeResult(result: unknown): string {
	if (Array.isArray(result)) return `${result.length} result${result.length === 1 ? '' : 's'}`;
	if (typeof result === 'string') return result.length > 80 ? result.slice(0, 80) + '...' : result;
	if (typeof result === 'object' && result !== null) {
		const json = JSON.stringify(result);
		return json.length > 80 ? json.slice(0, 80) + '...' : json;
	}
	return String(result);
}

export function ToolCallChip({ tc }: { tc: ToolCallRecord }) {
	const colors = TOOL_COLORS[tc.name] ?? { text: 'text-gray-400', bg: 'bg-gray-500/20', border: 'border-gray-500/30' };
	const isPending = tc.result === undefined;

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-mono cursor-pointer',
						'border transition-colors hover:brightness-125',
						colors.bg, colors.text, colors.border,
					)}
				>
					{tc.name}
					{isPending && (
						<span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
					)}
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-72 bg-gray-900 border-gray-700 text-white p-3" side="top" sideOffset={4}>
				<div className="space-y-2">
					<div className={cn('text-xs font-semibold', colors.text)}>{tc.name}</div>
					{Object.keys(tc.args).length > 0 && (
						<div className="space-y-0.5">
							<div className="text-xs text-gray-500 font-medium">Args</div>
							{Object.entries(tc.args).map(([k, v]) => (
								<div key={k} className="flex gap-1.5 font-mono text-xs text-gray-500">
									<span className="text-gray-600">{k}:</span>
									<span className="text-gray-400 truncate">{String(v)}</span>
								</div>
							))}
						</div>
					)}
					{tc.result !== undefined && (
						<div>
							<div className="text-xs text-gray-500 font-medium mb-0.5">Result</div>
							<div className="text-xs text-gray-400 font-mono break-words">
								{summarizeResult(tc.result)}
							</div>
						</div>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
