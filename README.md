# Commercial Mute

A Chrome extension that **mutes commercial breaks** in sports streams (NFL, college football,
soccer, …) and unmutes when the game is back. Replays, interviews and the halftime show stay on.

It learns each stream on the fly: the scoreboard and channel logo, what the game sounds like
(commentators, crowd), and what that broadcast's ads sound like. Everything runs locally in your
browser. No screenshots or audio leave your computer, and there is no account or server.

## Install

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
| `Alt+Shift+M` / **Unmute** | Unmute now and ignore the rest of this break (or mute now if it isn't muted; during a missed commercial it also learns that ad's sound) |
| **Wrong!** | Same, plus it learns from the mistake |
| `Alt+Shift+P` / **Pause auto** | Turn auto-mute off until you resume |

### During commercials (optional)

Right-click the toolbar icon → **During commercials…** to pick what else happens while a break
is muted:

| Option | What it does |
|---|---|
| **Just mute** | Default. Nothing else. |
| **YouTube video or playlist** | Opens it next to the game and plays it; paused when the game is back, resumed next break. |
| **Spotify playlist, album or podcast** | Opens the Spotify web player and presses play (sign in at open.spotify.com first). |
| **A tab you already have open** | Switches to it and resumes what it was playing (YouTube Music, SoundCloud, Twitch…). |

It only switches tabs if you're watching the game at that moment, and only switches back if
you're still on that tab. Switching tabs leaves the player's fullscreen. **Start a test break**
on that page shows what happens without waiting for a commercial. If Chrome blocks autoplay on a
music tab, click play there once; after that it resumes on its own.

Right-click the toolbar icon → **Open debug panel** to see what it detects. Change the shortcuts
at `chrome://extensions/shortcuts`.

## Good to know

- The first break of a session can be caught late: it's still learning the game and ad sounds.
- It mutes 0–3 s into a break (the lead-in music counts as the break) and unmutes as soon
  as the scoreboard is back, or about 5 s after the game sound is back if the scoreboard isn't.
- If the scoreboard moves (the stream changed its layout), it notices after about a minute of game
  sound without the scoreboard and relearns it.
- If the debug panel shows only the channel logo learned (yellow box), it keeps looking for the
  scoreboard in the background; **Relearn scoreboard** forces a fresh start.

How it works and all tuning values: [`ext/README.md`](ext/README.md).
Third-party libraries and models: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
