// What happens during a muted commercial, besides the mute. Shared by the service worker and the
// options page. Stored in chrome.storage.sync under 'breakAction'.

(function (root) {
  const BREAK_DEFAULTS = {
    mode: 'none', // one of BREAK_MODES[].id
    youtubeUrl: '',
    spotifyUrl: '',
    tab: null, // { id, url, title } for mode 'tab'
    switchTab: true, // switch to the music tab (only when you were watching the stream tab)
    returnToGame: true, // switch back when the game is back (only if you're still on that tab)
    pauseOnReturn: true,
    closeOnReturn: false, // close the tab it opened (otherwise it's reused next break)
  };

  // media: the tab's video/audio is started and paused with the break.
  const BREAK_MODES = [
    { id: 'none', label: 'Just mute', desc: 'Nothing else happens. The default.' },
    { id: 'youtube', label: 'YouTube video or playlist', media: true, field: 'youtubeUrl',
      placeholder: 'https://www.youtube.com/watch?v=…', desc: 'Opens it in a tab next to the game and plays it. Paused when the game is back, resumed next break.' },
    { id: 'spotify', label: 'Spotify playlist, album or podcast', media: true, field: 'spotifyUrl',
      placeholder: 'https://open.spotify.com/playlist/…', desc: 'Opens the Spotify web player and presses play. You need to be signed in to open.spotify.com.' },
    { id: 'tab', label: 'A tab you already have open', media: true,
      desc: 'Switches to it and resumes whatever it was playing (YouTube Music, SoundCloud, Twitch, a podcast…). Most reliable: start it once yourself, then it resumes on its own.' },
  ];

  async function getBreakSettings() {
    const { breakAction } = await chrome.storage.sync.get('breakAction');
    return { ...BREAK_DEFAULTS, ...(breakAction || {}) };
  }

  function breakMode(id) {
    return BREAK_MODES.find((m) => m.id === id) || BREAK_MODES[0];
  }

  // Accepts "youtube.com/…" without the scheme.
  function normalizeUrl(s) {
    const t = (s || '').trim();
    if (!t) return '';
    try {
      return new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`).href;
    } catch {
      return '';
    }
  }

  Object.assign(root, { BREAK_DEFAULTS, BREAK_MODES, getBreakSettings, breakMode, normalizeUrl });
})(typeof self !== 'undefined' ? self : globalThis);
