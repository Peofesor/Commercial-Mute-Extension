# Commercial Mute

Chrome extension that mutes commercial breaks in sports streams. It learns each stream's
scoreboard, what the game sounds like, and the team names, then tells commercials apart from
replays, interviews and the halftime show, which you still get to hear.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked**, then select this `ext` folder. If it's already loaded, click the reload arrow.
   - v1.0 asks for access to all sites. It needs that to show the on-screen badge inside the
     stream's player frames, which often come from a different site than the page.
4. Pin the extension (puzzle icon, then the pin)

## Use

1. Open the stream and start playback.
2. Click the extension icon. A short message on the stream says it's learning the scoreboard.
   The toolbar badge shows **ON**.
   - The tab's sound now plays through the extension. That's how it can mute while still listening.
3. After about 30 s of game footage you'll see "Scoreboard learned: auto-mute is active". From then on:
   - **Commercial:** the tab fades to silent. A badge appears top-right with **Unmute**, **Wrong!**
     and **Pause auto**, and the toolbar badge shows **MUTE**.
   - **Game back:** sound fades back in, with a short "Back to the game" note.
4. Click the extension icon again to stop.

### Overrides

| You do | What happens |
|---|---|
| `Alt+Shift+M` or **Unmute** while auto-muted | Unmutes now and ignores the rest of this break. Auto-mute is back for the next one. |
| `Alt+Shift+M` while not muted | Mutes manually until you press it again, or the scoreboard disappears and comes back. Pressed during a break, it also ends when the detector (once it has muted too) says the break is over. If the scoreboard is gone (a commercial it missed), it also learns what's playing as ad sound, so that ad and similar ones get muted on their own later. |
| **Wrong!** | Same as the hotkey, plus it's logged as a detector mistake. While muted, it also learns what's playing (studio show, interview…) as "not a commercial", so similar audio stays on later. |
| `Alt+Shift+P` or **Pause auto** | Turns auto-mute off (toolbar badge shows **II**) until you resume. Remembered across sessions. |
| `Alt+Shift+N`, right-click the toolbar icon → **Switched stream: learn again**, or **New stream** in the debug panel | Forgets the scoreboard, channel logo, game sound, ad sound and team names and learns them again from the stream that's playing now. Capture keeps running. |

### Switching streams

Each stream has its own scoreboard, logo and sound, so after switching, everything has to be learned
again. If the tab opens a different page (the address changes), that happens on its own, with a short
"Other page opened" note. If you switch channels inside the same player and the address stays the same,
press `Alt+Shift+N`.

Turning the extension off and on again on the same page keeps what it learned: scoreboard, logo, game and ad
sound, your Wrong! fixes and team names ("using what it learned about this stream"). Turned on during a
commercial, it mutes at once (1–2 s, as soon as the first frame and the first second of sound are
checked): scoreboard and logo gone and the sound like an ad. Switched on during a replay, game sound keeps it on. On a different page, or after a browser restart, it learns from scratch.

You can change the shortcuts at `chrome://extensions/shortcuts`, or right-click the toolbar icon
and choose **Change keyboard shortcuts**. The badge also works when the player is fullscreen.

### Debug panel

Right-click the toolbar icon and choose **Open debug panel**. It shows the live view: video area,
learned scoreboard (yellow box) and channel logo (magenta box), signals, a chart with a separate line
for each, and the auto-mute toggle. A dashed line in the chart marks where learning started over for a new stream.
**Edit boxes** under the preview shows the boxes it detected (yellow: scoreboard, magenta: logo). Drag a
box to move it, or its corners and edges to resize it. Rename a box between scoreboard and logo in the list
under the preview, or double-click it. Delete it with its ✕ in the list (or select it and press **Delete**). **+ Scoreboard box** / **+ Logo box** add new ones. **Apply**:
learned pixels inside a box take its role, pixels outside every box are dropped (e.g. a stats panel that
was folded out while it learned and kept the percentage low). A box with hardly anything learned inside
is watched for 5 s, and the pixels that stay sharp with steady brightness are learned, so keep it on screen.
**Automatic** forgets your boxes and goes back to the detector's rules (deleted graphics stay deleted
until the background search finds them again). Edited boxes stay until a new stream or **Relearn scoreboard**.
While no logo is known, the "channel logo" row shows when the next background search runs and what the
last one found ("skipped" means the scoreboard was on screen less than half of those 30 s). Labeling with **A** and
**Export log** work as before. Exported logs now also record the actual mute state, your
overrides, and **Wrong!** presses.

## How it decides

**Learning the scoreboard:** for 30 s it looks for graphics that are unchanged and sharp in most frames (not all), so score bars that hide for replays or have panels sliding in and out are still learned. If it only finds a small graphic, like the network logo, it keeps looking for the bigger scoreboard a few more times. Frozen frames (buffering, paused) are skipped, so learning pauses instead of picking up field lines. After learning it **keeps looking in the background**: if a separate graphic that wasn't learned (e.g. the score bar, when learning happened during replays) stays put during play, it's added, and a note says "Found the scoreboard". The game sound is only learned while the scoreboard is up, not from a logo alone.

**Scoreboard and channel logo:** the learned graphics are split into two indicators, each with its own visibility score. The biggest group of graphics is the scoreboard (graphics close to each other count as one group, since a score bar is often learned as several boxes, each smaller than the logo). A graphic near a corner, at most 4.5× wider than tall (wordmarks like "NFL NETWORK / LIVE" are about 3×, score bars 5× and more) and well away from the scoreboard, is the channel logo.

**White on white:** a white logo over a bright background (court, white jerseys, sky) has no edges in those frames. So in the corners, a pixel also counts if it's unchanged in 75% of frames and sharp on average, even if it isn't sharp in most frames. While a graphic is scored, a pixel with the right brightness but no edge counts as "can't tell" rather than "gone". Presence is the share that matches among the pixels that can tell, and holds when fewer than 30% can.

**See-through logos** (e.g. "sky sports" on a translucent box): their brightness shifts with what's behind them, so they're never "unchanged". In the corners, a pixel also counts if it's an edge (Sobel 60+) in 85% of frames and changes by less than 20 per frame in 70% of them. Such pixels are matched within twice the brightness spread they showed while learning (28–40), not the fixed 28. If only a logo is found, it keeps looking for the scoreboard, and the background search adds whichever one is missing later.

Scoreboard or channel logo visible: game. Both gone: it could be a commercial, or a replay, interview,
studio segment or halftime show. The deciding signal is **whether the audio still sounds like
this broadcast**. While the scoreboard is up, it learns the game's sound (commentators, crowd,
venue) from YAMNet embeddings. That similarity stays at 80–98% during play, replays and the
halftime show, and drops to about 0–10% within seconds of a commercial. Once it has heard a long break (scoreboard gone 40 s+, with music), or has muted with the scoreboard gone 8 s+ and music that sounds nothing like the game, it also keeps fingerprints of this broadcast's **ads** and scores new audio by whether it is closer to the game or to the ads. That catches talky ads that sound like commentary. **Reset learned sounds** in the debug panel starts the sound learning over. Music, black+silent cuts,
persistent graphics and on-screen text (OCR) only nudge the result.

- **Sound score:** once both banks are learned, "sounds like the game" is the average of the game-vs-ad comparison and the plain similarity to the game sound. Each alone fails: the comparison misses talky ads the ad bank hasn't heard, the plain similarity dips during play.
- **Mute:** scoreboard gone for 3 s or more and ad probability ≥ 75% for 2 s. Until this broadcast's ads are learned (first long break), it only knows "doesn't sound like the game", and a replay transition or a sideline shot with engine noise also sounds like that for a few seconds. So until then it needs the scoreboard gone 8 s and ad probability ≥ 75% for 4 s in a row: the first break mutes a few seconds later, but replays don't get muted. The lead-in music into a break counts as the break. A black+silent cut within 20 s of the scoreboard leaving mutes at once: black frames only showed up at break boundaries and between ads, never during play.
- **Ambient sound:** in the first 30 s the scoreboard is gone (replays, dead balls), seconds with neither speech nor music (crowd, squeaking shoes) count as neither game nor ad, so a quiet stretch of play doesn't mute.
- **Unmute:** the scoreboard is back, or the audio sounded like the broadcast (≥ 70%) in 5 of the last 6 s (7 of 8 before the ads are learned, if there's no logo to go by) while the scoreboard is still gone (e.g. the halftime show after ads). Talky ads sound like the game in 2–4 s bursts, so they don't unmute. The channel logo adjusts this: logo clearly gone (under 20%) means it's still an ad, so the sound has to be game-like in all of the last 8 s. Logo partly back (40%+) means the broadcast is returning, so 3 of the last 4 s are enough. Before the game sound is learned, only the scoreboard unmutes.
- **Channel logo:** at least 80% visible means the game counts as on: it unmutes right away and won't mute, even with the scoreboard hidden (replays, studio). A logo that stays on during commercials (a restream watermark) is caught by the sound: once it has been visible for 30 s in total while the scoreboard was gone and the audio sounded like ads, it's ignored ("ignored" in the debug panel) until the logo is relearned.
- **Stale scoreboard:** if part of the learned graphic changes for good (the score bar switched layout), that part never matches again and the scoreboard would sit around 50% visible. Every 30 s it drops the pixels that matched in under 20% of the frames where that graphic (scoreboard or logo, each on its own) was at least partly there, if it matched under 70% on average. Ads stay below about 20%, so they don't count.
- **New score bar:** logo visible but the scoreboard under 20% for 60 s means the score bar changed. The old one is dropped ("Scoreboard changed" note), the logo carries the decision, and the background search learns the new score bar.
- **Partly visible:** the scoreboard at least 40% visible for 3 s in a row starts the "gone" time over, so separate short dips (replays, camera cuts) don't add up to a commercial.
- **Scoreboard lost:** learned graphics gone for 60 s of game sound (not muted) means the stream moved them without changing size, so the scoreboard is relearned. Learning starts over whenever a commercial is muted, so it isn't learned from an ad.
- **Layout change** (e.g. fullscreen) or **Relearn scoreboard**: only the scoreboard is relearned. The learned game sound is kept, and decides on its own until the scoreboard is learned again.
- **No audio model:** it falls back to absence time, so replays shorter than about 40 s are never muted.

The timings in `DEFAULTS` at the top of `detector.js` were tuned on three labeled games (two college, one NFL), then tightened on a labeled college basketball game (63 min, five breaks) where the scoreboard was lost after the first break. A second labeled basketball game (50 min) added the black-cut and ambient rules. Replaying both logs: ads heard 241 s → 10 s and 162 s → 126 s, game muted 9 s → 29 s and 67 s → 58 s. Muted game time is unmute lag at break ends, lead-in music, and in the second game a cold start (first break 30 s after starting, before any game sound was learned). Most ads still heard in the second game are narrated ads that sound like commentary for 10+ s at a time.

## Files

| File | Role |
|---|---|
| `sw.js` | Toolbar click, hotkeys, toolbar badge, context menu, relays state to the on-screen badge |
| `offscreen.js` | Holds the capture stream, plays audio back (and mutes it), samples frames/audio, keeps the history |
| `vision.js` | Scoreboard learning + presence scoring |
| `audio.js`, `audio-tap.js` | 16 kHz resampling, YAMNet classification + embeddings |
| `ocr.js` | Team-name learning and on-screen text checks (Tesseract.js) |
| `detector.js` | Game-audio profile, black-frame cuts, combining signals into the detector's verdict |
| `controller.js` | Actual mute state: detector verdict + your overrides (hotkey, Wrong!, pause) |
| `badge.js` | On-screen badge in the stream tab (Shadow DOM, all frames, fullscreen-aware) |
| `debug.*` | Live debug panel |
| `break-actions.js` | Break action settings and the list of choices (shared by the options page and service worker) |
| `break-runner.js` | Runs the break action: opens/switches to the music tab and plays/pauses it |
| `options.*` | "During commercials" options page |
| `vendor/`, `model/` | TensorFlow.js 4.22, Tesseract.js 5.1 and the YAMNet model (bundled, no network needed) |

**Note:** `vendor/tf.min.js` has one patched line. TF.js's bundled regenerator polyfill falls back to
`Function("r", "regeneratorRuntime = r")`, which Chrome's extension CSP blocks. That stopped TF.js
loading partway through. The patch assigns through `globalThis` instead. Re-apply it if you upgrade TF.js.
