// Adapted from apps/plane-miro/test/fake-plane.ts.
import type { Edge, ItemRow, LabelRow, ModuleRow, ProjectRow, StateRow } from '../src/contract.ts';
import type { PlaneReader } from '../src/plane/client.ts';

/**
 * Plane in memory. Seed `projects`, `states`, `labels`, `modules`, `items`, `relations` directly;
 * `calls` names the PlaneReader methods called, in order.
 */
export class FakePlane implements PlaneReader {
	projects: ProjectRow[] = [];
	states: StateRow[] = [];
	labels: LabelRow[] = [];
	modules: ModuleRow[] = [];
	items = new Map<string, ItemRow>();
	/** item id → the edges its relations read returns. */
	relations = new Map<string, Edge[]>();
	calls: string[] = [];
	#failures = new Map<keyof PlaneReader, Error[]>();

	/** The next call of `method` throws `error` (queued: several calls fail in turn). */
	failNext(method: keyof PlaneReader, error: Error): void {
		this.#failures.set(method, [...(this.#failures.get(method) ?? []), error]);
	}

	#enter(method: keyof PlaneReader): void {
		this.calls.push(method);
		const queue = this.#failures.get(method);
		const error = queue?.shift();
		if (error) throw error;
	}

	async listProjects(): Promise<ProjectRow[]> {
		this.#enter('listProjects');
		return structuredClone(this.projects);
	}

	async listStates(projectId: string): Promise<StateRow[]> {
		this.#enter('listStates');
		return structuredClone(this.states.filter((s) => s.projectId === projectId));
	}

	async listLabels(projectId: string): Promise<LabelRow[]> {
		this.#enter('listLabels');
		return structuredClone(this.labels.filter((l) => l.projectId === projectId));
	}

	async listModules(projectId: string): Promise<ModuleRow[]> {
		this.#enter('listModules');
		return structuredClone(this.modules.filter((m) => m.projectId === projectId));
	}

	async listWorkItems(projectId: string): Promise<ItemRow[]> {
		this.#enter('listWorkItems');
		return structuredClone([...this.items.values()].filter((i) => i.projectId === projectId));
	}

	async getWorkItem(projectId: string, id: string): Promise<ItemRow | null> {
		this.#enter('getWorkItem');
		const item = this.items.get(id);
		return item && item.projectId === projectId ? structuredClone(item) : null;
	}

	async getRelations(_projectId: string, id: string): Promise<Edge[]> {
		this.#enter('getRelations');
		return structuredClone(this.relations.get(id) ?? []);
	}
}
