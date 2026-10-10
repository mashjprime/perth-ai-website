// Full screen for the game. Uses the browser's Fullscreen API where it can
// (desktop, Android, iPad). iPhones only allow videos to go full screen, so
// there the game fills the window instead and the page behind stops
// scrolling; the browser's own bars stay. Either way the stage gets the
// `is-fullscreen` class, which the page's CSS sizes to fill the screen.
//
// In the fill-the-window mode a history entry is added, so the back gesture
// (an easy accident mid-game on an iPhone) closes full screen rather than
// leaving the page.

const REQUEST_WAIT_MS = 1000;

const element = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;

export function createFullscreen(stage, { onChange }) {
  let fallback = false;
  let pending = false; // a request is out; don't send another
  let closing = false; // history.back() is on its way; don't send another

  const isOn = () => fallback || element() === stage;

  function sync() {
    // A slow request that came good after the window fill took over: real
    // full screen wins, and the window fill's history entry goes.
    if (fallback && element() === stage) {
      fallback = false;
      if (history.state?.quokkaRunFullscreen) {
        closing = true;
        history.back();
      }
      lockLandscape();
    }
    const on = isOn();
    stage.classList.toggle('is-fullscreen', on);
    document.documentElement.classList.toggle('qr-locked', fallback);
    onChange(on);
  }

  // Phones play better sideways. Only allowed in real full screen, and only
  // some browsers (Android Chrome) support it; elsewhere it quietly fails.
  function lockLandscape() {
    if (matchMedia('(pointer: coarse)').matches) screen.orientation?.lock?.('landscape').catch(() => {});
  }

  async function enter() {
    if (isOn() || pending) return;
    pending = true;
    try {
      const request = stage.requestFullscreen ?? stage.webkitRequestFullscreen;
      if (request) {
        // Some in-app browsers never answer a full screen request, so give it
        // a moment and then fill the window instead. Refused (not allowed
        // here) gets the same.
        const answer = await Promise.race([
          Promise.resolve(request.call(stage, { navigationUI: 'hide' })).then(
            () => 'yes',
            () => 'no'
          ),
          new Promise((resolve) => setTimeout(resolve, REQUEST_WAIT_MS, 'slow')),
        ]);
        if (answer === 'yes') {
          lockLandscape();
          return; // the fullscreenchange event calls sync()
        }
        if (element() === stage) return;
      }
      fallback = true;
      history.pushState({ quokkaRunFullscreen: true }, '');
      sync();
    } finally {
      pending = false;
    }
  }

  async function exit() {
    if (fallback) {
      if (closing) return;
      // Undo the history entry; the popstate handler below finishes the job.
      if (history.state?.quokkaRunFullscreen) {
        closing = true;
        history.back();
      } else close();
      return;
    }
    if (!element()) return;
    screen.orientation?.unlock?.();
    try {
      // Older Safari's prefixed version returns nothing rather than a promise.
      await (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
    } catch {}
  }

  function close() {
    fallback = false;
    sync();
  }

  const toggle = () => (isOn() ? exit() : enter());

  // A reload (or a return to the page) while the window fill was on lands on
  // its leftover history entry, which would make the next Back press appear
  // to do nothing. Step back over it.
  if (history.state?.quokkaRunFullscreen) history.back();

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  addEventListener('popstate', () => {
    closing = false;
    if (fallback) close();
  });

  return { enter, exit, toggle, isOn };
}
