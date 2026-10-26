/// <reference lib="dom" />

miro.board.ui.on('icon:click', async () => {
	await miro.board.ui.openPanel({ url: '/miro/panel' });
});

miro.board.ui.on('app_card:open', async ({ appCard }) => {
	const { id } = await miro.board.getInfo();
	const query = new URLSearchParams({ board: id, item: appCard.id });
	await miro.board.ui.openModal({ url: `/miro/card?${query.toString()}`, width: 420, height: 320 });
});
