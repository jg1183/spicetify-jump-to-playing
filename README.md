# Playlists With Song

A Spicetify extension that shows every playlist in your library containing a given song, fast, even with hundreds of playlists.

![Preview](preview.png)

## Usage

Right-click any song (including local files) and choose **Show playlists with this song**. A popup lists every playlist in your library that contains it, with the owner and folder. Click a result to open that playlist.

## How it stays fast

- **Background index:** shortly after Spotify starts, the extension quietly reads your playlists and remembers which songs are in which, so lookups are near-instant.
- **Only changed playlists are re-read:** each lookup shows known results straight away, then checks every playlist's song count and re-reads only the ones that changed. If you've just added the song to a playlist, it appears a moment later.
- **Light refresh:** every 10 minutes it re-checks song counts in the background (one tiny request per playlist).

With 150 playlists, a lookup takes about half a second.

## Install

**Marketplace:** search for "Playlists With Song" and click Install.

**Manual:**
1. Run `spicetify config-dir` and copy `playlistsWithSong.js` into the `Extensions` folder.
2. Run:
   ```
   spicetify config extensions playlistsWithSong.js
   spicetify apply
   ```

## Notes

- The very first lookup after starting Spotify can take a second or two if the background index isn't ready yet.
- A playlist is only re-read when its song count changes. If you swap one song for another and keep the same count, the change is picked up the next time Spotify starts (or after Ctrl+Shift+R).
- Tested on Spotify 1.3.6 with Spicetify 2.46.4.
- Written from scratch for recent Spotify versions as a replacement for huhridge's `listPlaylistsWithSong`, which no longer works.
- If something breaks, open DevTools (run `spicetify enable-devtools`, then press Ctrl+Shift+I) → Console, copy any line starting with `[PlaylistsWithSong]`, and open an issue.
