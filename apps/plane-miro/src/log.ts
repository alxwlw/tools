// Copy of apps/plane-discord/src/log.ts; keep in sync until a shared package exists.
/** Scalars, plus a list of flat records for the startup summary (`tenants`). */
export type LogValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| ReadonlyArray<Readonly<Record<string, string | number>>>;
export type LogEntry = { event: string; level?: 'warn' | 'error' } & Record<string, LogValue>;
export type Log = (entry: LogEntry) => void;

/** One JSON line per entry: { ts, ...entry }. Callers never pass message, description or comment text. */
export function jsonLog(
	write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
	now: () => Date = () => new Date(),
): Log {
	return (entry) => write(JSON.stringify({ ts: now().toISOString(), ...entry }));
}
