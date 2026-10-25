import type { Log } from '../log.ts';

export const INTENTS = { GUILDS: 1, GUILD_MESSAGES: 512, MESSAGE_CONTENT: 32768 } as const;

export type GatewayMessage = {
	id: string;
	channelId: string;
	guildId: string | null;
	type: number;
	content: string;
	author: { id: string; name: string; bot: boolean };
	webhookId: string | null;
	applicationId: string | null;
	attachments: { url: string; filename: string }[];
	mentions: { id: string; name: string }[];
};

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const INVALID_SESSION_PAUSE_MS = 1000;
const INVALID_SESSION_JITTER_MS = 4000;
/** Not 1000/1001: Discord keeps the session resumable when we drop the socket with another code. */
const DROP_CODE = 4000;

/** Close codes after which Discord wants a brand-new session: reconnect with IDENTIFY, never RESUME. */
const NEW_SESSION_CLOSE: ReadonlySet<number> = new Set([4007, 4009]);

/** Close codes after which a reconnect cannot help; the text goes to the log, never the server's reason. */
const FATAL_CLOSE: ReadonlyMap<number, string> = new Map([
	[4004, 'токен бота отклонён Discord'],
	[4010, 'неверный shard'],
	[4011, 'нужен sharding'],
	[4012, 'неверная версия Gateway API'],
	[4013, 'неверные intents'],
	[4014, 'MESSAGE_CONTENT не включён в Developer Portal'],
]);

type Frame = { op: number; d?: unknown; s?: number | null; t?: string | null };

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Parses a MESSAGE_CREATE payload at the boundary; the list holds the required fields that are missing. */
export function parseMessage(d: unknown): GatewayMessage | { missing: string[] } {
	if (!isRecord(d)) return { missing: ['d'] };
	const author = isRecord(d.author) ? d.author : {};
	const id = str(d.id);
	const channelId = str(d.channel_id);
	const authorId = str(author.id);
	const missing = [
		id === null && 'id',
		channelId === null && 'channel_id',
		authorId === null && 'author.id',
	].filter((x): x is string => x !== false);
	if (id === null || channelId === null || authorId === null) return { missing };
	const member = isRecord(d.member) ? d.member : {};
	const nameOf = (u: Record<string, unknown>) =>
		str(u.global_name) ?? str(u.username) ?? str(u.id) ?? '';
	const attachments = Array.isArray(d.attachments) ? d.attachments : [];
	const mentions = Array.isArray(d.mentions) ? d.mentions : [];
	return {
		id,
		channelId,
		guildId: str(d.guild_id),
		type: typeof d.type === 'number' ? d.type : 0,
		content: typeof d.content === 'string' ? d.content : '',
		author: {
			id: authorId,
			name: str(member.nick) ?? nameOf(author),
			bot: author.bot === true,
		},
		webhookId: str(d.webhook_id),
		applicationId: str(d.application_id),
		attachments: attachments.filter(isRecord).flatMap((a) => {
			const url = str(a.url);
			return url === null ? [] : [{ url, filename: str(a.filename) ?? '' }];
		}),
		mentions: mentions.filter(isRecord).flatMap((m) => {
			const mid = str(m.id);
			return mid === null ? [] : [{ id: mid, name: nameOf(m) }];
		}),
	};
}

/** Discord Gateway v10 client: one connection, heartbeat, resume. Nothing here logs the token or message text. */
export class Gateway {
	private readonly token: string;
	private readonly intents: number;
	private readonly onMessage: (message: GatewayMessage) => void;
	private readonly log: Log;
	private readonly url: string;
	private readonly WS: typeof WebSocket;
	private readonly random: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	private ws: WebSocket | null = null;
	/** Bumped on every drop/stop/scheduled reconnect: callbacks of an older connection or sleep compare and bail. */
	private gen = 0;
	private stopped = true;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private acked = true;
	private seq: number | null = null;
	private sessionId: string | null = null;
	private resumeUrl: string | null = null;
	private attempt = 0;

	constructor(opts: {
		token: string;
		intents: number;
		onMessage: (message: GatewayMessage) => void;
		log: Log;
		url?: string;
		WebSocketImpl?: typeof WebSocket;
		random?: () => number;
		sleep?: (ms: number) => Promise<void>;
	}) {
		this.token = opts.token;
		this.intents = opts.intents;
		this.onMessage = opts.onMessage;
		this.log = opts.log;
		this.url = opts.url ?? GATEWAY_URL;
		this.WS = opts.WebSocketImpl ?? WebSocket;
		this.random = opts.random ?? Math.random;
		this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.tryConnect();
	}

	stop(): Promise<void> {
		this.stopped = true;
		this.drop(1000);
		return Promise.resolve();
	}

	private connect(): void {
		const gen = ++this.gen;
		const resuming = this.sessionId !== null && this.resumeUrl !== null;
		const ws = new this.WS(resuming ? this.withParams(this.resumeUrl as string) : this.url);
		this.ws = ws;
		// Listeners go on synchronously, before the socket can deliver anything.
		ws.addEventListener('message', (ev) => {
			if (gen === this.gen) this.onFrame(ev.data);
		});
		ws.addEventListener('error', () => {
			if (gen === this.gen) this.log({ event: 'gateway.socket_error', level: 'warn' });
		});
		ws.addEventListener('close', (ev) => {
			if (gen === this.gen) this.onClose(ev.code);
		});
	}

	/** connect() that never throws (bad URL, constructor failure): logs and retries after the backoff. */
	private tryConnect(): void {
		try {
			this.connect();
		} catch {
			this.ws = null;
			this.log({ event: 'gateway.connect_failed', level: 'warn' });
			this.retryAfterBackoff();
		}
	}

	private nextBackoff(): number {
		const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** this.attempt);
		this.attempt++;
		return delay;
	}

	private retryAfterBackoff(): void {
		void this.reconnectAfter(this.nextBackoff());
	}

	private clearSession(): void {
		this.sessionId = null;
		this.resumeUrl = null;
		this.seq = null;
	}

	private withParams(base: string): string {
		const u = new URL(base);
		u.searchParams.set('v', '10');
		u.searchParams.set('encoding', 'json');
		return u.toString();
	}

	/** Detaches the current connection (its callbacks stop firing) and closes the socket. */
	private drop(code: number): void {
		this.gen++;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		const ws = this.ws;
		this.ws = null;
		try {
			ws?.close(code);
		} catch {
			// already closing
		}
	}

	private send(frame: Frame): void {
		if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(frame));
	}

	private onFrame(data: unknown): void {
		let frame: Frame;
		try {
			const parsed: unknown = JSON.parse(typeof data === 'string' ? data : '');
			if (!isRecord(parsed) || typeof parsed.op !== 'number') throw new Error('not a frame');
			frame = parsed as Frame;
		} catch {
			this.log({ event: 'gateway.bad_frame', level: 'warn' });
			return;
		}
		switch (frame.op) {
			case 10:
				this.onHello(frame.d);
				return;
			case 11:
				this.acked = true;
				return;
			case 1:
				this.heartbeat();
				return;
			case 7:
				this.log({ event: 'gateway.reconnect', reason: 'op7' });
				this.drop(DROP_CODE);
				this.tryConnect();
				return;
			case 9:
				this.onInvalidSession(frame.d === true);
				return;
			case 0:
				this.onDispatch(frame);
		}
	}

	private onHello(d: unknown): void {
		const interval =
			isRecord(d) && typeof d.heartbeat_interval === 'number' ? d.heartbeat_interval : 0;
		if (interval <= 0) {
			this.log({ event: 'gateway.bad_frame', level: 'warn', op: 10 });
			return;
		}
		this.acked = true;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.tick(interval), interval * this.random());
		if (this.sessionId !== null) {
			this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
		} else {
			this.send({
				op: 2,
				d: {
					token: this.token,
					intents: this.intents,
					properties: { os: 'linux', browser: 'plane-discord', device: 'plane-discord' },
				},
			});
		}
	}

	private tick(interval: number): void {
		if (!this.acked) {
			// Zombie connection: no ACK for the previous heartbeat. Drop it and resume.
			this.log({ event: 'gateway.reconnect', reason: 'no_ack' });
			this.drop(DROP_CODE);
			this.tryConnect();
			return;
		}
		this.acked = false;
		this.heartbeat();
		this.timer = setTimeout(() => this.tick(interval), interval);
	}

	private heartbeat(): void {
		this.send({ op: 1, d: this.seq });
	}

	private onInvalidSession(resumable: boolean): void {
		if (resumable) {
			this.log({ event: 'gateway.reconnect', reason: 'op9_resume' });
			this.drop(DROP_CODE);
			this.tryConnect();
			return;
		}
		this.clearSession();
		const pause = INVALID_SESSION_PAUSE_MS + this.random() * INVALID_SESSION_JITTER_MS;
		this.log({ event: 'gateway.reconnect', reason: 'op9_identify', delay_ms: pause });
		this.drop(1000);
		void this.reconnectAfter(pause);
	}

	private onDispatch(frame: Frame): void {
		if (typeof frame.s === 'number') this.seq = frame.s;
		switch (frame.t) {
			case 'READY': {
				const d = isRecord(frame.d) ? frame.d : {};
				this.sessionId = str(d.session_id);
				this.resumeUrl = str(d.resume_gateway_url);
				if (this.resumeUrl !== null && !URL.canParse(this.resumeUrl)) {
					// A session we cannot resume to is no session: the next connect re-identifies.
					this.log({ event: 'gateway.bad_ready', level: 'warn' });
					this.clearSession();
				}
				this.attempt = 0;
				this.log({ event: 'gateway.ready' });
				return;
			}
			case 'RESUMED':
				this.attempt = 0;
				this.log({ event: 'gateway.resumed' });
				return;
			case 'MESSAGE_CREATE': {
				const message = parseMessage(frame.d);
				if ('missing' in message) {
					this.log({
						event: 'gateway.bad_message',
						level: 'warn',
						missing: message.missing.join(','),
					});
					return;
				}
				try {
					this.onMessage(message);
				} catch {
					// The handler's own failure is its concern; the connection must survive it.
					this.log({ event: 'gateway.handler_failed', level: 'error', message_id: message.id });
				}
			}
		}
	}

	private onClose(code: number): void {
		const fatal = FATAL_CLOSE.get(code);
		if (fatal !== undefined) {
			this.drop(1000);
			this.stopped = true;
			this.log({ event: 'gateway.fatal', level: 'error', code, error: fatal });
			return;
		}
		this.drop(1000);
		if (NEW_SESSION_CLOSE.has(code)) this.clearSession();
		const delay = this.nextBackoff();
		this.log({ event: 'gateway.reconnect', reason: 'close', code, delay_ms: delay });
		void this.reconnectAfter(delay);
	}

	private async reconnectAfter(ms: number): Promise<void> {
		const token = ++this.gen;
		try {
			await this.sleep(ms);
		} catch {
			// A broken sleep cannot pace retries; give up rather than spin.
			this.log({ event: 'gateway.sleep_failed', level: 'error' });
			return;
		}
		if (this.stopped || token !== this.gen) return;
		this.tryConnect();
	}
}
