'use strict';

// No-op outside the packaged Android app: window.Capacitor only exists inside the native shell.
// Wires the clipsync://pair deep link (opened when the user scans the PC's "app" QR code with
// their camera) to the pairing flow already implemented in app.js.
(function () {
  const plugins = window.Capacitor && window.Capacitor.Plugins;
  const AppPlugin = plugins && plugins.App;
  if (!AppPlugin || typeof AppPlugin.addListener !== 'function') return;

  AppPlugin.addListener('appUrlOpen', (data) => {
    if (data && typeof data.url === 'string' && typeof window.__clipsyncHandleDeepLink === 'function') {
      window.__clipsyncHandleDeepLink(data.url);
    }
  });

  AppPlugin.getLaunchUrl().then((launch) => {
    if (launch && launch.url && typeof window.__clipsyncHandleDeepLink === 'function') {
      window.__clipsyncHandleDeepLink(launch.url);
    }
  }).catch(() => {
    // getLaunchUrl isn't available on every Capacitor version; appUrlOpen alone still covers
    // the case where the app was already running when the link was tapped.
  });
})();
