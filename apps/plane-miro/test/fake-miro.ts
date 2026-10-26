import {
	MiroApiError,
	type AppCardInput,
	type Connector,
	type MiroApi,
	type MiroItem,
	type Place,
} from '../src/miro/rest.ts';

export type FakeBoard = {
	name: string;
	/** A frame's title is the `html` of its `frame` item. */
	items: Map<string, MiroItem>;
	tags: Map<string, string[]>;
	connectors: Connector[];
	cards: Map<string, { card: AppCardInput; place: Place }>;
};

/** In-memory MiroApi: a board in `noAccess` reads as null and refuses writes with 403, a missing item as 404. */
export class FakeMiro implements MiroApi {
	readonly boards = new Map<string, FakeBoard>();
	readonly noAccess = new Set<string>();
	/** Names of the called methods, in order. */
	readonly calls: string[] = [];
	readonly #failures = new Map<keyof MiroApi, Error[]>();
	#seq = 0;
	#valid = true;

	addBoard(id: string, name = 'Board'): FakeBoard {
		const board: FakeBoard = {
			name,
			items: new Map(),
			tags: new Map(),
			connectors: [],
			cards: new Map(),
		};
		this.boards.set(id, board);
		return board;
	}

	setTokenValid(valid: boolean): void {
		this.#valid = valid;
	}

	/** The next call of `method` throws `error` (queued: several calls queue several errors). */
	failNext(method: keyof MiroApi, error: Error): void {
		this.#failures.set(method, [...(this.#failures.get(method) ?? []), error]);
	}

	item(boardId: string, itemId: string): MiroItem | null {
		return this.boards.get(boardId)?.items.get(itemId) ?? null;
	}

	cardsOn(boardId: string): { id: string; card: AppCardInput; place: Place }[] {
		const board = this.boards.get(boardId);
		return board === undefined
			? []
			: [...board.cards].map(([id, { card, place }]) => ({ id, card, place }));
	}

	connector(id: string): Connector | undefined {
		for (const board of this.boards.values()) {
			const found = board.connectors.find((c) => c.id === id);
			if (found !== undefined) return found;
		}
		return undefined;
	}

	#enter(method: keyof MiroApi): void {
		this.calls.push(method);
		const queue = this.#failures.get(method);
		const error = queue?.shift();
		if (error !== undefined) throw error;
	}

	#board(boardId: string, method: string): FakeBoard {
		const board = this.boards.get(boardId);
		if (board === undefined) throw new MiroApiError(404, method, '/v2/boards/{board}');
		if (this.noAccess.has(boardId)) throw new MiroApiError(403, method, '/v2/boards/{board}');
		return board;
	}

	async getBoard(boardId: string): Promise<{ id: string; name: string } | null> {
		this.#enter('getBoard');
		const board = this.boards.get(boardId);
		if (board === undefined || this.noAccess.has(boardId)) return null;
		return { id: boardId, name: board.name };
	}

	async getItem(boardId: string, itemId: string): Promise<MiroItem | null> {
		this.#enter('getItem');
		return this.#board(boardId, 'GET').items.get(itemId) ?? null;
	}

	async getFrameTitle(boardId: string, frameId: string): Promise<string | null> {
		this.#enter('getFrameTitle');
		const frame = this.#board(boardId, 'GET').items.get(frameId);
		return frame === undefined || frame.type !== 'frame' ? null : frame.html;
	}

	async getItemTags(boardId: string, itemId: string): Promise<string[]> {
		this.#enter('getItemTags');
		return [...(this.#board(boardId, 'GET').tags.get(itemId) ?? [])];
	}

	async createAppCard(boardId: string, card: AppCardInput, place: Place): Promise<string> {
		this.#enter('createAppCard');
		const board = this.#board(boardId, 'POST');
		const id = `345876450000000${String(++this.#seq).padStart(4, '0')}`;
		board.cards.set(id, { card, place });
		board.items.set(id, {
			id,
			type: 'app_card',
			html: card.title,
			x: place.x,
			y: place.y,
			width: null,
			height: null,
			parentId: place.parentId,
		});
		return id;
	}

	async updateAppCard(
		boardId: string,
		cardId: string,
		card: Partial<AppCardInput>,
	): Promise<'ok' | 'gone'> {
		this.#enter('updateAppCard');
		const board = this.#board(boardId, 'PATCH');
		const have = board.cards.get(cardId);
		if (have === undefined) return 'gone';
		have.card = { ...have.card, ...card };
		const item = board.items.get(cardId);
		if (item !== undefined && card.title !== undefined) item.html = card.title;
		return 'ok';
	}

	async listConnectors(boardId: string): Promise<Connector[]> {
		this.#enter('listConnectors');
		return this.#board(boardId, 'GET').connectors.map((c) => ({ ...c }));
	}

	async reattachConnector(
		boardId: string,
		connectorId: string,
		side: 'start' | 'end',
		itemId: string,
	): Promise<void> {
		this.#enter('reattachConnector');
		const found = this.#board(boardId, 'PATCH').connectors.find((c) => c.id === connectorId);
		if (found === undefined)
			throw new MiroApiError(404, 'PATCH', '/v2/boards/{board}/connectors/{id}');
		if (side === 'start') found.startItemId = itemId;
		else found.endItemId = itemId;
	}

	async deleteItem(boardId: string, itemId: string): Promise<void> {
		this.#enter('deleteItem');
		const board = this.#board(boardId, 'DELETE');
		board.items.delete(itemId);
		board.cards.delete(itemId);
	}

	async tokenValid(): Promise<boolean> {
		this.#enter('tokenValid');
		return this.#valid;
	}
}
