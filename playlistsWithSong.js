// NAME: Playlists With Song
// DESCRIPTION: Right-click a song → "Show playlists with this song". Lists every playlist in your library that contains it.
// Keeps an index of your playlists (built in the background, refreshed as playlists change),
// so results show instantly instead of reading every playlist on every lookup.

(function playlistsWithSong() {
	const S = window.Spicetify;
	if (!S?.ContextMenu || !S?.Platform?.RootlistAPI || !S?.Platform?.PlaylistAPI || !S?.PopupModal || !S?.URI) {
		setTimeout(playlistsWithSong, 300);
		return;
	}

	const LOG = "[PlaylistsWithSong]";
	const PAGE = 500;
	const PARALLEL = 12;            // full playlist reads at once during a lookup
	const CHECK_PARALLEL = 30;      // quick "has it changed?" checks at once (tiny requests)
	const BACKGROUND_PARALLEL = 4;  // gentler while warming the index in the background
	const WARM_AFTER_MS = 15000;    // start building the index this long after Spotify starts
	const REFRESH_EVERY_MS = 10 * 60 * 1000;

	// Walk the library tree (folders can nest) and collect playlists.
	function collectPlaylists(items, folderPath, out) {
		for (const item of items || []) {
			if (item.type === "folder") {
				collectPlaylists(item.items, [...folderPath, item.name], out);
			} else if (item.type === "playlist" && item.uri) {
				out.push({ uri: item.uri, name: item.name, owner: item.owner?.name, folder: folderPath.join(" / ") });
			}
		}
		return out;
	}

	async function getLibraryPlaylists() {
		const root = await S.Platform.RootlistAPI.getContents();
		return collectPlaylists(root.items, [], []);
	}

	const idOf = (uri) => (uri || "").split(":").pop();

	// ---- Index: playlist uri -> { total, keys } ----
	// keys holds every track's uri, its track ID, and the ID it was relinked from,
	// so relinked copies of a song still match.
	const index = new Map();
	const inFlight = new Map(); // playlist uri -> promise, so a lookup and the background never read the same playlist twice

	function keysFor(item) {
		const keys = [];
		if (item?.uri) {
			keys.push(item.uri);
			if (item.uri.startsWith("spotify:track:")) keys.push(idOf(item.uri));
		}
		if (item?.linkedFrom?.uri) {
			keys.push(item.linkedFrom.uri);
			keys.push(idOf(item.linkedFrom.uri));
		}
		return keys;
	}

	function readPlaylist(uri) {
		if (inFlight.has(uri)) return inFlight.get(uri);
		const job = (async () => {
			const keys = new Set();
			let offset = 0, total = 0;
			for (;;) {
				const res = await S.Platform.PlaylistAPI.getContents(uri, { offset, limit: PAGE });
				const items = res?.items || [];
				for (const it of items) for (const k of keysFor(it)) keys.add(k);
				offset += items.length;
				total = res?.totalLength ?? 0;
				if (items.length === 0 || offset >= total) break;
			}
			index.set(uri, { total, keys });
			return index.get(uri);
		})().finally(() => inFlight.delete(uri));
		inFlight.set(uri, job);
		return job;
	}

	// One tiny request: has the playlist's song count changed since we indexed it?
	async function isStale(uri) {
		const cached = index.get(uri);
		if (!cached) return true;
		const res = await S.Platform.PlaylistAPI.getContents(uri, { offset: 0, limit: 1 });
		return (res?.totalLength ?? 0) !== cached.total;
	}

	const matches = (entry, trackUri) =>
		!!entry && (entry.keys.has(trackUri) || (!trackUri.startsWith("spotify:local:") && entry.keys.has(idOf(trackUri))));

	// Lets at most `limit` calls of fn run at once.
	function limiter(limit) {
		let active = 0;
		const waiting = [];
		return async fn => {
			while (active >= limit) await new Promise(r => waiting.push(r));
			active++;
			try { return await fn(); } finally { active--; waiting.shift()?.(); }
		};
	}

	async function runPool(items, parallel, fn) {
		const queue = [...items];
		await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
			while (queue.length) await fn(queue.shift());
		}));
	}

	// Build/refresh the index quietly in the background.
	let warming = false;
	async function warmIndex() {
		if (warming) return;
		warming = true;
		try {
			const playlists = await getLibraryPlaylists();
			const live = new Set(playlists.map(p => p.uri));
			for (const uri of index.keys()) if (!live.has(uri)) index.delete(uri);
			await runPool(playlists, BACKGROUND_PARALLEL, async p => {
				try { if (await isStale(p.uri)) await readPlaylist(p.uri); }
				catch (err) { console.warn(LOG, "Background read failed for", p.name, err); }
			});
			console.log(LOG, `Index ready: ${index.size} playlists.`);
		} catch (err) {
			console.warn(LOG, "Background indexing failed", err);
		} finally {
			warming = false;
		}
	}
	setTimeout(warmIndex, WARM_AFTER_MS);
	setInterval(warmIndex, REFRESH_EVERY_MS);

	function el(tag, style, text) {
		const e = document.createElement(tag);
		if (style) e.style.cssText = style;
		if (text != null) e.textContent = text;
		return e;
	}

	function goTo(uri) {
		S.PopupModal.hide();
		const path = S.URI.fromString(uri)?.toURLPath?.(true) || `/playlist/${idOf(uri)}`;
		S.Platform.History.push(path);
	}

	async function run(uris) {
		const trackUri = uris[0];
		const box = el("div", "display:flex;flex-direction:column;gap:8px;min-width:320px;");
		const status = el("div", "opacity:.7;", "Loading your library…");
		const list = el("div", "display:flex;flex-direction:column;gap:4px;");
		box.append(status, list);
		S.PopupModal.display({ title: "Playlists with this song", content: box, isLarge: true });

		try {
			const playlists = await getLibraryPlaylists();
			const found = new Map();
			let failed = 0;

			function render() {
				list.replaceChildren();
				for (const p of [...found.values()].sort((a, b) => a.name.localeCompare(b.name))) {
					const row = el(
						"button",
						"all:unset;cursor:pointer;padding:8px 10px;border-radius:6px;background:rgba(255,255,255,.07);display:flex;flex-direction:column;"
					);
					row.append(el("span", "font-weight:600;", p.name));
					const meta = [p.owner && `by ${p.owner}`, p.folder && `in ${p.folder}`].filter(Boolean).join(" · ");
					if (meta) row.append(el("span", "font-size:12px;opacity:.65;", meta));
					row.onmouseenter = () => (row.style.background = "rgba(255,255,255,.14)");
					row.onmouseleave = () => (row.style.background = "rgba(255,255,255,.07)");
					row.onclick = () => goTo(p.uri);
					list.append(row);
				}
			}

			// 1) Instant answer from the index.
			let cachedCount = 0;
			for (const p of playlists) {
				const entry = index.get(p.uri);
				if (entry) cachedCount++;
				if (matches(entry, trackUri)) found.set(p.uri, p);
			}
			render();

			// 2) Re-read only playlists that are new or have changed since they were indexed.
			let checked = 0;
			status.textContent = cachedCount
				? `Checking ${playlists.length} playlists for changes…`
				: `Reading ${playlists.length} playlists (first time only; later lookups are instant)…`;
			const readSlot = limiter(PARALLEL);
			await runPool(playlists, CHECK_PARALLEL, async p => {
				try {
					if (await isStale(p.uri)) {
						const entry = await readSlot(() => readPlaylist(p.uri));
						if (matches(entry, trackUri)) found.set(p.uri, p); else found.delete(p.uri);
						render();
					}
				} catch (err) {
					failed++;
					console.warn(LOG, "Could not read", p.name, p.uri, err);
				}
				checked++;
				if (!cachedCount) status.textContent = `Read ${checked} of ${playlists.length} playlists…`;
			});

			status.textContent =
				(found.size
					? `Found in ${found.size} of ${playlists.length} playlists.`
					: `Not in any of your ${playlists.length} playlists.`) +
				(failed ? ` (${failed} couldn't be read, see console.)` : "");
		} catch (err) {
			console.error(LOG, err);
			status.textContent = `Error: ${err?.message || err}. Open DevTools (Ctrl+Shift+I) → Console for details.`;
			status.style.color = "#f15e6c";
			status.style.opacity = "1";
		}
	}

	new S.ContextMenu.Item(
		"Show playlists with this song",
		run,
		(uris) => uris.length === 1 && (S.URI.isTrack(uris[0]) || uris[0].startsWith("spotify:local:")),
		"playlist"
	).register();

	console.log(LOG, "loaded");
})();
