// The part of the Miro Web SDK v2 (https://miro.com/app/static/sdk/v2/miro.js) the pages call.
type MiroItem = { id: string; type: string };

declare const miro: {
	board: {
		getSelection(): Promise<MiroItem[]>;
		getInfo(): Promise<{ id: string }>;
		getIdToken(): Promise<string>;
		getUserInfo(): Promise<{ name: string }>;
		ui: {
			openPanel(options: { url: string }): Promise<void>;
			openModal(options: { url: string; width: number; height: number }): Promise<void>;
			on(event: 'icon:click', handler: () => void | Promise<void>): void;
			on(
				event: 'app_card:open',
				handler: (e: { appCard: { id: string } }) => void | Promise<void>,
			): void;
			on(
				event: 'selection:update',
				handler: (e: { items: MiroItem[] }) => void | Promise<void>,
			): void;
		};
	};
};
