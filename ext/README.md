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
| `Alt+Shift+M` while not muted | Mutes manually until you press it again, or the scoreboard disappears and comes back. If the scoreboard is gone (a commercial it missed), it also learns what's playing as ad sound, so that ad and similar ones get muted on their own later. |
| **Wrong!** | Same as the hotkey, plus it's logged as a detector mistake. While muted, it also learns what's playing (studio show, interview…) as "not a commercial", so similar audio stays on later. |
| `Alt+Shift+P` or **Pause auto** | Turns auto-mute off (toolbar badge shows **II**) until you resume. Remembered across sessions. |

You can change the shortcuts at `chrome://extensions/shortcuts`, or right-click the toolbar icon
and choose **Change keyboard shortcuts**. The badge also works when the player is fullscreen.

### Debug panel

Right-click the toolbar icon and choose **Open debug panel**. It shows the live view: video area,
learned scoreboard, signals, a chart, and the auto-mute toggle. Labeling with **A** and
**Export log** work as before. Exported logs now also record the actual mute state, your
overrides, and **Wrong!** presses.

## How it decides

**Learning the scoreboard:** for 30 s it looks for graphics that are unchanged and sharp in most frames (not all), so score bars that hide for replays or have panels sliding in and out are still learned. If it only finds a small graphic, like the network logo, it keeps looking for the bigger scoreboard a few more times. Frozen frames (buffering, paused) are skipped, so learning pauses instead of picking up field lines. After learning it **keeps looking in the background**: if a separate graphic that wasn't learned (e.g. the score bar, when learning happened during replays) stays put during play, it's added, and a note says "Found the scoreboard". The game sound is only learned once a scoreboard-sized graphic is known, not from a logo alone.

Scoreboard visible: game. Scoreboard gone: it could be a commercial, or a replay, interview,
studio segment or halftime show. The deciding signal is **whether the audio still sounds like
this broadcast**. While the scoreboard is up, it learns the game's sound (commentators, crowd,
venue) from YAMNet embeddings. That similarity stays at 80–98% during play, replays and the
halftime show, and drops to about 0–10% within seconds of a commercial. Once it has heard a long break (scoreboard gone 40 s+, with music), it also keeps fingerprints of this broadcast's **ads** and scores new audio by whether it is closer to the game or to the ads. That catches talky ads that sound like commentary. **Reset learned sounds** in the debug panel starts the sound learning over. Music, black+silent cuts,
persistent graphics and on-screen text (OCR) only nudge the result.

- **Sound score:** once both banks are learned, "sounds like the game" is the average of the game-vs-ad comparison and the plain similarity to the game sound. Each alone fails: the comparison misses talky ads the ad bank hasn't heard, the plain similarity dips during play.
- **Mute:** scoreboard gone for 3 s or more and ad probability ≥ 75% for 2 s. The lead-in music into a break counts as the break. A black+silent cut within 20 s of the scoreboard leaving mutes at once: black frames only showed up at break boundaries and between ads, never during play.
- **Ambient sound:** in the first 30 s the scoreboard is gone (replays, dead balls), seconds with neither speech nor music (crowd, squeaking shoes) count as neither game nor ad, so a quiet stretch of play doesn't mute.
- **Unmute:** the scoreboard is back, or the audio sounded like the broadcast (≥ 70%) in 5 of the last 6 s while the scoreboard is still gone (e.g. the halftime show after ads). Talky ads sound like the game in 2–4 s bursts, so they don't unmute. Before the game sound is learned, only the scoreboard unmutes.
- **Channel logo:** the learned overlay is split into separate graphics (yellow boxes in the debug preview). If any one of them is at least 80% visible (channel logo, part of the score bar), the game counts as on: it unmutes right away and won't mute.
- **Stale scoreboard:** if part of the learned graphic changes for good (the score bar switched layout), that part never matches again and the scoreboard would sit around 50% visible. Every 30 s it drops the pixels that matched in under 20% of the frames where the scoreboard was at least partly there, if it matched under 70% on average. Ads stay below about 20%, so they don't count.
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
