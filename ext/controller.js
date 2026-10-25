// Decides the actual mute state from the detector plus your overrides.
//
//   hotkey / Unmute while auto-muted  -> unmute now and ignore the rest of this break
//                                        (auto-mute works again once the detector says the break is over)
//   hotkey while not muted            -> mute manually until you press again, or the scoreboard
//                                        disappears and comes back; with the scoreboard gone, what's
//                                        playing is learned as a commercial, and the mute also ends
//                                        when the detector (once it mutes too) says the break is over
//   Wrong!                            -> same as the hotkey, logged as a detector mistake, and (while
//                                        muted) what's playing is learned as "not a commercial"
//   Pause                             -> no auto-mute until resumed

(function (root) {
  const PRESENT = 0.6;
  const ABSENT = 0.4;

  class MuteController {
    constructor(opts = {}) {
      this.autoEnabled = opts.autoEnabled ?? true;
      this.override = null; // null | 'skip' (stay unmuted this break) | 'manual' (stay muted)
      this.muted = false;
      this.sawAbsent = false;
      this.manualInBreak = false; // manual mute pressed while the scoreboard was gone
      this.detectorCaughtUp = false; // ...and the detector has muted since
      this.wrongSkip = false; // current 'skip' came from Wrong!: what's playing is not a commercial
      this.events = [];
    }

    // Once per second with the detector's verdict. Returns true if the mute state changed.
    tick(detectorMuted, presence) {
      if (this.override === 'skip' && !detectorMuted) this.override = null;
      if (this.override !== 'skip') this.wrongSkip = false;
      if (this.override === 'manual') {
        if (presence != null && presence < ABSENT) this.sawAbsent = true;
        if (this.sawAbsent && presence != null && presence >= PRESENT) this.override = null;
        // Muted during a break (a commercial it missed or unmuted too early): once the detector has caught
        // up and then says the break is over, it ends too, instead of waiting for the scoreboard.
        if (this.manualInBreak && detectorMuted) this.detectorCaughtUp = true;
        if (this.manualInBreak && this.detectorCaughtUp && !detectorMuted) this.override = null;
      }
      const want = this.override === 'manual' ? true : this.override === 'skip' ? false : this.autoEnabled && detectorMuted;
      return this.set(want, want ? 'auto-mute' : 'auto-unmute');
    }

    // Hotkey / badge button. wrong=true also records it as a detector mistake.
    toggle(detectorMuted, presence, wrong = false) {
      if (this.muted) {
        this.override = this.autoEnabled && detectorMuted ? 'skip' : null;
        this.wrongSkip = wrong && this.override === 'skip';
        return this.set(false, wrong ? 'wrong-mute' : 'user-unmute', true);
      }
      this.override = 'manual';
      this.wrongSkip = false;
      this.sawAbsent = presence != null && presence < ABSENT;
      this.manualInBreak = this.sawAbsent;
      this.detectorCaughtUp = false;
      return this.set(true, wrong ? 'wrong-unmute' : 'user-mute', true);
    }

    setAuto(on) {
      if (this.autoEnabled === on) return false;
      this.autoEnabled = on;
      this.override = null;
      this.wrongSkip = false;
      if (on) this.events.push('resumed');
      else this.set(false, 'paused', true);
      return true;
    }

    set(muted, event, force = false) {
      if (muted === this.muted) {
        if (force) this.events.push(event);
        return false;
      }
      this.muted = muted;
      this.events.push(event);
      return true;
    }

    takeEvents() {
      const e = this.events;
      this.events = [];
      return e;
    }

    // True while you've said "this is not a commercial": the audio is learned as show content.
    get learningShow() {
      return this.override === 'skip' && this.wrongSkip;
    }

    // True while you've muted a commercial it missed (pressed with the scoreboard gone): the audio
    // is learned as ad sound until the scoreboard is back.
    get learningAd() {
      return this.override === 'manual' && this.manualInBreak;
    }

    state() {
      return { muted: this.muted, autoEnabled: this.autoEnabled, override: this.override };
    }
  }

  root.MuteController = MuteController;
  if (typeof module !== 'undefined') module.exports = { MuteController };
})(typeof self !== 'undefined' ? self : globalThis);
