// Adapted from apps/plane-discord/src/log.ts: a startup record may carry string lists, and describeError lives here.
/** Scalars, plus a list of flat records for the startup summary (`tenants`, whose `inputs` is a list). */
export type LogValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| ReadonlyArray<Readonly<Record<string, string | number | readonly string[]>>>;
export type LogEntry = { event: string; level?: 'warn' | 'error' } & Record<string, LogValue>;
export type Log = (entry: LogEntry) => void;

/** One JSON line per entry: { ts, ...entry }. Callers never pass message, description or comment text. */
export function jsonLog(
	write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
	now: () => Date = () => new Date(),
): Log {
	return (entry) => write(JSON.stringify({ ts: now().toISOString(), ...entry }));
}

/**
 * `<name>: <message>` of an error for a log line or the inbox. Plane and GitHub errors carry method, path and
 * status only, never a response body; anything that is not an Error is `unknown error`.
 */
export function describeError(err: unknown): string {
	try {
		return err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
	} catch {
		return 'unknown error';
	}
}
