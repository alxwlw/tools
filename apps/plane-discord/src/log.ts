export type LogEntry = { event: string; level?: 'warn' | 'error' } & Record<
	string,
	string | number | boolean | null | undefined
>;
export type Log = (entry: LogEntry) => void;

/** One JSON line per entry: { ts, ...entry }. Callers never pass message, description or comment text. */
export function jsonLog(
	write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
	now: () => Date = () => new Date(),
): Log {
	return (entry) => write(JSON.stringify({ ts: now().toISOString(), ...entry }));
}
