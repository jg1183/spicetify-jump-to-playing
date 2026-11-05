// NAME: Jump To Playing
// AUTHOR: JackG (https://github.com/JG1183)
// DESCRIPTION: When you open the playlist/album/Liked Songs that is currently playing, scrolls to the playing song.

(function jumpToPlaying() {
	const S = window.Spicetify;
	if (!S?.Player?.data || !S?.Platform?.History?.listen) {
		setTimeout(jumpToPlaying, 300);
		return;
	}

	const LOG = "[Jump To Playing]";
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	let runId = 0; // a newer navigation cancels an older search
	let userScrolled = false;

	// spotify:playlist:ID -> /playlist/ID ; Liked Songs -> /collection/tracks
	function contextPath(uri) {
		if (!uri) return null;
		if (/:collection(:|$)/.test(uri)) return "/collection/tracks";
		const parts = uri.split(":");
		return parts.length >= 3 ? `/${parts[1]}/${parts[parts.length - 1]}` : null;
	}

	function findUriFromFiber(node, maxDepth = 15) {
		const fiberKey = Object.keys(node).find(k => k.startsWith("__reactFiber$"));
		const propsKey = Object.keys(node).find(k => k.startsWith("__reactProps$"));
		let fiber = fiberKey ? node[fiberKey] : null;
		if (fiber?.alternate && propsKey && fiber.alternate.memoizedProps === node[propsKey]) fiber = fiber.alternate;
		for (let i = 0; i < maxDepth && fiber; i++) {
			const uri = fiber.memoizedProps?.uri;
			if (typeof uri === "string" && /^spotify:(track|local|episode):/.test(uri)) return uri;
			fiber = fiber.return;
		}
		return undefined;
	}

	const trackRows = () => [...document.querySelectorAll('.main-view-container [role="row"], main [role="row"]')]
		.filter((r, i, a) => a.indexOf(r) === i && findUriFromFiber(r));

	function findPlayingRow(uri) {
		const rows = trackRows().filter(r => findUriFromFiber(r) === uri);
		if (rows.length <= 1) return rows[0] || null;
		// Same song more than once: prefer the row Spotify marks as playing.
		return rows.find(r => r.querySelector('[aria-label*="Pause"], .main-trackList-playingIcon, img[src*="equaliser"]')) || rows[0];
	}

	function scrollerOf(el) {
		for (let n = el?.parentElement; n; n = n.parentElement) {
			const oy = getComputedStyle(n).overflowY;
			if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
		}
		return document.scrollingElement;
	}

	function highlight(row) {
		row.scrollIntoView({ block: "center", behavior: "instant" });
		const prev = row.style.transition, prevBg = row.style.backgroundColor;
		row.style.transition = "background-color .6s";
		row.style.backgroundColor = "rgba(255,255,255,.18)";
		setTimeout(() => { row.style.backgroundColor = prevBg; }, 900);
		setTimeout(() => { row.style.transition = prev; }, 1600);
	}

	function playingIndex() {
		const idx = S.Player.data?.index ?? S.Platform.PlayerAPI?._state?.index;
		const n = idx?.itemIndex ?? idx?.index;
		return Number.isInteger(n) && n >= 0 ? n : null;
	}

	// Position of the song in the context's own list (playlist order / Liked Songs order),
	// for when Spotify doesn't report it. Cached per context for a minute.
	const indexCache = new Map();
	async function contextUris(contextUri) {
		const hit = indexCache.get(contextUri);
		if (hit && Date.now() - hit.at < 60000) return hit.uris;
		let uris = null;
		if (/:collection(:|$)/.test(contextUri) && S.Platform.LibraryAPI?.getTracks) {
			const res = await S.Platform.LibraryAPI.getTracks({ limit: 9999999 });
			uris = (res?.items || []).map(i => i.uri);
		} else if (contextUri.startsWith("spotify:playlist:") && S.Platform.PlaylistAPI?.getContents) {
			uris = [];
			for (let offset = 0; ;) {
				const res = await S.Platform.PlaylistAPI.getContents(contextUri, { offset, limit: 1000 });
				const items = res?.items || [];
				uris.push(...items.map(i => i.uri));
				offset += items.length;
				if (!items.length || offset >= (res?.totalLength ?? 0)) break;
			}
		}
		if (uris) indexCache.set(contextUri, { at: Date.now(), uris });
		return uris;
	}

	async function findIndex(uri) {
		const reported = playingIndex();
		if (reported != null) return reported;
		try {
			const uris = await contextUris(S.Player.data?.context?.uri || "");
			const i = uris ? uris.indexOf(uri) : -1;
			return i >= 0 ? i : null;
		} catch (err) {
			console.warn(LOG, "Couldn't read the list to find the song's position", err);
			return null;
		}
	}

	const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

	function inView(row) {
		if (!row?.isConnected) return false;
		const sr = scrollerOf(row).getBoundingClientRect(), q = row.getBoundingClientRect();
		return q.height > 0 && q.bottom > sr.top && q.top < sr.bottom;
	}

	// Spotify sometimes resets/restores the scroll position after the page has finished
	// loading, undoing our jump. Check again shortly after and search again if that happened.
	async function verify(myRun, uri, retried) {
		await sleep(700);
		if (myRun !== runId || userScrolled) return;
		const row = findPlayingRow(uri);
		if (inView(row)) return;
		if (row) return row.scrollIntoView({ block: "center", behavior: "instant" });
		if (!retried) run(myRun, new Set(), true).catch(err => console.error(LOG, err));
	}

	async function run(myRun, stale, retried = false) {
		const uri = S.Player.data?.item?.uri;
		if (!uri) return;
		const indexPromise = findIndex(uri); // start fetching while the page renders

		// Wait for the NEW page's track list to render (up to ~6s). Right after you click,
		// the previous page's rows are often still on screen; using those was why it
		// sometimes did nothing until you went away and came back.
		let rows = [];
		const t0 = performance.now();
		for (let i = 0; i < 120 && myRun === runId; i++) {
			const all = trackRows();
			rows = all.filter(r => !stale.has(r));
			// Nothing new but rows still there after a while: they already were the new page.
			if (!rows.length && performance.now() - t0 > 1500) rows = all;
			if (rows.length) break;
			await sleep(50);
		}
		if (!rows.length || myRun !== runId) return;
		// Give Spotify a moment to finish laying out / restoring scroll before we move it.
		await frame();
		await sleep(150);
		if (myRun !== runId) return;
		rows = trackRows();
		if (!rows.length) return;

		let row = findPlayingRow(uri);
		if (row) { highlight(row); verify(myRun, uri, retried); return; }

		const scroller = scrollerOf(rows[0]);
		const stillOurs = () => myRun === runId && !userScrolled;
		// Spotify may animate scrolling; jump instantly while we search.
		const prevBehavior = scroller.style.scrollBehavior;
		scroller.style.scrollBehavior = "auto";
		const done = r => {
			scroller.style.scrollBehavior = prevBehavior;
			if (r) { highlight(r); verify(myRun, uri, retried); }
		};
		// After each jump, wait until Spotify has actually drawn rows in view (it renders
		// lazily and can lag behind the scroll), then look for the song.
		const oneFrame = () => new Promise(r => requestAnimationFrame(r));
		const rowsInView = () => {
			const sr = scroller.getBoundingClientRect();
			return trackRows().some(r => { const q = r.getBoundingClientRect(); return q.height && q.bottom > sr.top + 1 && q.top < sr.bottom - 1; });
		};
		const check = async () => {
			const t0 = performance.now();
			while (performance.now() - t0 < 1500) {
				await oneFrame();
				const found = findPlayingRow(uri);
				if (found) return found;
				if (rowsInView() && performance.now() - t0 > 30) {
					await frame(); // let the rest of the screen finish drawing
					return findPlayingRow(uri);
				}
			}
			return findPlayingRow(uri);
		};

		// 1) Jump to where the song should be.
		const index = await indexPromise;
		if (!stillOurs()) return done();
		if (index != null) {
			const dataRow = rows.find(r => r.hasAttribute("aria-rowindex")) || rows[0];
			const rowH = dataRow.getBoundingClientRect().height || 56;
			const refIndex = dataRow.hasAttribute("aria-rowindex")
				? Number(dataRow.getAttribute("aria-rowindex")) - 2 // 1 = header, 2 = first track
				: null;
			let offset;
			if (refIndex != null) {
				offset = dataRow.getBoundingClientRect().top - scroller.getBoundingClientRect().top + (index - refIndex) * rowH;
			} else {
				const grid = dataRow.closest('[role="grid"]') || dataRow.parentElement;
				offset = grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top + index * rowH;
			}
			scroller.scrollTop += offset - scroller.clientHeight / 2;
			if ((row = await check()) || (row = await check())) return done(row);

			// 2) Slightly off? Look a few screens either side before giving up on the estimate.
			const centre = scroller.scrollTop, stepPx = scroller.clientHeight * 0.9;
			for (const k of [1, -1, 2, -2, 3, -3]) {
				if (!stillOurs()) return done();
				scroller.scrollTop = centre + k * stepPx;
				if ((row = await check())) return done(row);
			}
		}

		// 3) Fallback (e.g. custom sort): fast sweep from the top.
		if (!stillOurs()) return done();
		scroller.scrollTop = 0;
		for (let step = 0; step < 2000 && stillOurs(); step++) {
			if ((row = await check())) return done(row);
			const before = scroller.scrollTop;
			scroller.scrollTop += scroller.clientHeight;
			if (scroller.scrollTop === before) break; // reached the end
		}
		done();
		if (stillOurs()) console.info(LOG, "Playing song not found in this view.");
	}

	// Stop searching as soon as you scroll yourself.
	["wheel", "touchmove", "keydown"].forEach(ev => document.addEventListener(ev, () => (userScrolled = true), { capture: true, passive: true }));

	function onLocation(location) {
		const path = (location?.pathname || "").replace(/\/$/, "");
		const playing = contextPath(S.Player.data?.context?.uri);
		if (!playing || path !== playing) return;
		// Remember which rows belong to the page we're leaving, so we don't search those.
		const stale = new Set(trackRows());
		userScrolled = false;
		const myRun = ++runId;
		run(myRun, stale).catch(err => console.error(LOG, err));
	}

	S.Platform.History.listen(onLocation);
	onLocation(S.Platform.History.location);
	console.log(LOG, "loaded");
})();
