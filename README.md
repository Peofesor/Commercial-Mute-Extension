# Commercial Mute

A Chrome extension that **mutes commercial breaks** in sports streams (NFL, college football,
soccer, …) and unmutes when the game is back. Replays, interviews and the halftime show stay on.

It learns each stream on the fly: the scoreboard and channel logo, what the game sounds like
(commentators, crowd), and what that broadcast's ads sound like. Everything runs locally in your
browser. No screenshots or audio leave your computer, and there is no account or server.

## Install (for you and friends)

1. **Download** this repository: green **Code** button → **Download ZIP**. Unzip it somewhere it
   can stay (Chrome loads the extension from that folder, so don't delete it afterwards).
2. Open `chrome://extensions` in Chrome (Edge works too: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the **`ext`** folder inside the unzipped folder.
5. Pin it: puzzle icon in the toolbar → pin **Commercial Mute** (red muted-speaker icon).

Chrome asks for access to all sites. The extension needs it to show its small on-screen badge
inside the stream's player, which usually comes from a different site than the page.

**Updating:** download the new ZIP, replace the old folder's contents, then click the reload
arrow on Commercial Mute in `chrome://extensions`.

## Use

1. Open the stream and start playback. If you want fullscreen, switch to it **before** step 2.
2. Click the extension icon on the stream tab. The badge shows **ON**.
3. After about 30 s of game footage you'll see "Scoreboard learned: auto-mute is active".
   From then on, commercials fade to silent and the game fades back in.

| Shortcut / button | What it does |
|---|---|
| `Alt+Shift+M` / **Unmute** | Unmute now and ignore the rest of this break (or mute now if it isn't muted) |
| **Wrong!** | Same, plus it learns from the mistake |
| `Alt+Shift+P` / **Pause auto** | Turn auto-mute off until you resume |

Right-click the toolbar icon → **Open debug panel** to see what it detects. Change the shortcuts
at `chrome://extensions/shortcuts`.

## Good to know

- The first break of a session can be caught late: it's still learning the game and ad sounds.
- It waits ~10 s after the scoreboard disappears before muting, so the lead-in music before a
  break stays audible.
- If the debug panel shows only the channel logo learned (yellow box), it keeps looking for the
  scoreboard in the background; **Relearn scoreboard** forces a fresh start.

How it works and all tuning values: [`ext/README.md`](ext/README.md).
Third-party libraries and models: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
