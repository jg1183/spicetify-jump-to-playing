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
		row.scrollIntoView({ block: "center" });
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

	async function run(myRun) {
		const uri = S.Player.data?.item?.uri;
		if (!uri) return;

		// Wait for the track list to render (up to ~6s).
		let rows = [];
		for (let i = 0; i < 60 && myRun === runId; i++) {
			rows = trackRows();
			if (rows.length) break;
			await sleep(100);
		}
		if (!rows.length || myRun !== runId) return;
		await sleep(150);

		let row = findPlayingRow(uri);
		if (row) return highlight(row);

		const scroller = scrollerOf(rows[0]);
		userScrolled = false;
		const stillOurs = () => myRun === runId && !userScrolled;

		// 1) Jump to an estimate from the song's position in the playlist.
		const index = playingIndex();
		const ref = rows.find(r => r.hasAttribute("aria-rowindex"));
		if (index != null && ref) {
			const rowH = ref.getBoundingClientRect().height || 56;
			const refIndex = Number(ref.getAttribute("aria-rowindex"));
			const targetIndex = index + 2; // aria-rowindex: 1 = header, 2 = first track
			const offset = ref.getBoundingClientRect().top - scroller.getBoundingClientRect().top + (targetIndex - refIndex) * rowH;
			scroller.scrollTop += offset - scroller.clientHeight / 2;
			for (let i = 0; i < 8 && stillOurs(); i++) {
				await sleep(80);
				row = findPlayingRow(uri);
				if (row) return highlight(row);
			}
		}

		// 2) Fallback (e.g. custom sort): sweep from the top until the song shows up.
		if (!stillOurs()) return;
		scroller.scrollTop = 0;
		for (let step = 0; step < 600 && stillOurs(); step++) {
			await sleep(60);
			row = findPlayingRow(uri);
			if (row) return highlight(row);
			const before = scroller.scrollTop;
			scroller.scrollTop += scroller.clientHeight * 0.8;
			if (scroller.scrollTop === before) break; // reached the end
		}
		if (stillOurs()) console.info(LOG, "Playing song not found in this view.");
	}

	// Stop searching as soon as you scroll yourself.
	["wheel", "touchmove", "keydown"].forEach(ev => document.addEventListener(ev, () => (userScrolled = true), { capture: true, passive: true }));

	function onLocation(location) {
		const path = (location?.pathname || "").replace(/\/$/, "");
		const playing = contextPath(S.Player.data?.context?.uri);
		if (!playing || path !== playing) return;
		const myRun = ++runId;
		run(myRun).catch(err => console.error(LOG, err));
	}

	S.Platform.History.listen(onLocation);
	onLocation(S.Platform.History.location);
	console.log(LOG, "loaded");
})();
