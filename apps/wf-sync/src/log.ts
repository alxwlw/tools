export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level =
	(process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : 'info';

export function setLevel(l: Level): void {
	threshold = l;
}

export interface Logger {
	debug(msg: string, ...rest: unknown[]): void;
	info(msg: string, ...rest: unknown[]): void;
	warn(msg: string, ...rest: unknown[]): void;
	error(msg: string, ...rest: unknown[]): void;
	child(scope: string): Logger;
}

export function createLogger(scope = 'wf-sync'): Logger {
	const emit = (level: Level, msg: string, rest: unknown[]) => {
		if (ORDER[level] < ORDER[threshold]) return;
		const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
		(level === 'error' || level === 'warn' ? console.error : console.log)(line, ...rest);
	};
	return {
		debug: (m, ...r) => emit('debug', m, r),
		info: (m, ...r) => emit('info', m, r),
		warn: (m, ...r) => emit('warn', m, r),
		error: (m, ...r) => emit('error', m, r),
		child: (s) => createLogger(`${scope}:${s}`),
	};
}
