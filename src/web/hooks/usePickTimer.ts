import { useState, useEffect, useRef } from 'react';

const PICK_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

export function usePickTimer(isOnClock: boolean, onTimeout: () => void) {
	const [remaining, setRemaining] = useState(PICK_TIMEOUT_MS);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const startTimeRef = useRef<number>(0);

	useEffect(() => {
		if (!isOnClock) {
			setRemaining(PICK_TIMEOUT_MS);
			if (intervalRef.current) clearInterval(intervalRef.current);
			return;
		}

		startTimeRef.current = Date.now();
		setRemaining(PICK_TIMEOUT_MS);

		intervalRef.current = setInterval(() => {
			const elapsed = Date.now() - startTimeRef.current;
			const left = Math.max(0, PICK_TIMEOUT_MS - elapsed);
			setRemaining(left);
			if (left <= 0) {
				if (intervalRef.current) clearInterval(intervalRef.current);
				onTimeout();
			}
		}, 1000);

		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [isOnClock, onTimeout]);

	const minutes = Math.floor(remaining / 60000);
	const seconds = Math.floor((remaining % 60000) / 1000);
	const display = `${minutes}:${seconds.toString().padStart(2, '0')}`;
	const percent = (remaining / PICK_TIMEOUT_MS) * 100;

	return { remaining, display, percent };
}
