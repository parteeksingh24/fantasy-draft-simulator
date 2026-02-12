import './App.css';

export function App() {
	return (
		<div className="text-white flex font-sans justify-center min-h-screen">
			<div className="flex flex-col gap-4 max-w-3xl p-16 w-full">
				<div className="items-center flex flex-col gap-2 justify-center mb-8 relative text-center">
					<h1 className="text-5xl font-thin">Fantasy Draft Simulator</h1>
					<p className="text-gray-400 text-lg">
						AI-powered mock draft with 12 teams
					</p>
				</div>

				<div className="bg-black border border-gray-900 text-gray-400 rounded-lg p-8 shadow-2xl flex flex-col gap-4">
					<p>Draft UI coming in Phase 3. Use the API endpoints to interact with the draft:</p>
					<ul className="list-disc list-inside text-sm space-y-1">
						<li><code className="text-cyan-400">POST /api/draft/start</code> - Initialize a new draft</li>
						<li><code className="text-cyan-400">GET /api/draft/board</code> - Get current board state</li>
						<li><code className="text-cyan-400">POST /api/draft/pick</code> - Make a pick (human)</li>
						<li><code className="text-cyan-400">POST /api/draft/advance</code> - Trigger next AI pick</li>
					</ul>
				</div>
			</div>
		</div>
	);
}
