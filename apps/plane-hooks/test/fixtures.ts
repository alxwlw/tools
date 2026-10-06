/** Test fixtures from test/fixtures/, parsed or as raw bytes (signatures are computed over raw bytes). */
export async function fixture(name: string): Promise<any> {
	return Bun.file(`${import.meta.dir}/fixtures/${name}`).json();
}

export async function fixtureBytes(name: string): Promise<Uint8Array> {
	return new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/${name}`).arrayBuffer());
}
