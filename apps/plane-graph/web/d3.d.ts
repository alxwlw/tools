// The part of d3 v7 (https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js) graph.ts calls.

type D3Value<D, V> = V | ((d: D) => V);

interface D3Selection<D = unknown> {
	append(tag: string): D3Selection<D>;
	attr(name: string, value: D3Value<D, string | number | null>): D3Selection<D>;
	style(name: string, value: D3Value<D, string | null>): D3Selection<D>;
	text(value: D3Value<D, string>): D3Selection<D>;
	classed(names: string, value: D3Value<D, boolean>): D3Selection<D>;
	on(type: string, handler: (event: Event, d: D) => void): D3Selection<D>;
	selectAll(selector: string): D3Selection<unknown>;
	data<T>(rows: T[]): D3Selection<T>;
	join(tag: string): D3Selection<D>;
	each(fn: (this: Element, d: D) => void): D3Selection<D>;
	call(fn: (selection: never, ...args: never[]) => unknown, ...args: unknown[]): D3Selection<D>;
	transition(): D3Selection<D>;
	duration(ms: number): D3Selection<D>;
}

interface D3ZoomTransform {
	x: number;
	y: number;
	k: number;
	translate(x: number, y: number): D3ZoomTransform;
	scale(k: number): D3ZoomTransform;
}
interface D3ZoomEvent {
	transform: D3ZoomTransform;
}
interface D3Zoom {
	(selection: D3Selection<unknown>): void;
	scaleExtent(extent: [number, number]): D3Zoom;
	on(type: 'zoom', handler: (event: D3ZoomEvent) => void): D3Zoom;
	transform: (selection: D3Selection<unknown>, transform: D3ZoomTransform) => void;
}

interface D3DragEvent {
	active: number;
	x: number;
	y: number;
}
interface D3Drag<D> {
	(selection: D3Selection<D>): void;
	on(type: 'start' | 'drag' | 'end', handler: (event: D3DragEvent, d: D) => void): D3Drag<D>;
}

/** A node as the simulation keeps it: positions are written by the simulation. */
interface D3Node {
	id: string;
	x?: number;
	y?: number;
	fx?: number | null;
	fy?: number | null;
}
interface D3Link<N> {
	source: string | N;
	target: string | N;
}

interface D3Force {
	(alpha: number): void;
}
interface D3LinkForce<N, L> extends D3Force {
	id(fn: (node: N) => string): D3LinkForce<N, L>;
	distance(fn: (link: L) => number): D3LinkForce<N, L>;
	strength(fn: (link: L) => number): D3LinkForce<N, L>;
}
interface D3Strength<N> extends D3Force {
	strength(value: number | ((node: N) => number)): D3Strength<N>;
}
interface D3Simulation<N> {
	force(name: string, force: D3Force | null): D3Simulation<N>;
	on(type: 'tick' | 'end', handler: () => void): D3Simulation<N>;
	alphaTarget(value: number): D3Simulation<N>;
	restart(): D3Simulation<N>;
	stop(): D3Simulation<N>;
}

declare const d3: {
	select(node: Element): D3Selection<unknown>;
	zoom(): D3Zoom;
	zoomIdentity: D3ZoomTransform;
	drag<D>(): D3Drag<D>;
	forceSimulation<N extends D3Node>(nodes: N[]): D3Simulation<N>;
	forceLink<N extends D3Node, L extends D3Link<N>>(links: L[]): D3LinkForce<N, L>;
	forceManyBody(): D3Strength<D3Node>;
	forceCollide(radius: (node: never) => number): D3Force;
	forceX<N extends D3Node>(x: number | ((node: N) => number)): D3Strength<N>;
	forceY(y: number): D3Strength<D3Node>;
};
