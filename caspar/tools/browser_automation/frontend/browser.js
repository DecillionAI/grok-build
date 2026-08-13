// browser_automation — the tool's front-end (a Victor "mini app").
//
// This runs on the Elpian VM inside the Decillion client (the space "desktop"),
// NOT on the Caspar node. It is deployed as the downloadable `frontend` entity on
// the browser_automation tool's own program, fetched at runtime by the client and
// run in the Victor React-Native host. It is a little browser: an address bar and
// a live screenshot of the page, backed by the browser_automation creature over
// the host bridge — every request is signed with the human user's identity by the
// host, never by this sandboxed guest.
//
// Wire to the host:
//   * `hostCall(fn, args, cb)` → askHost("host.call", …) → the client signs a
//     Caspar signal to THIS tool's back-end (`{ function: fn, payload: args }`)
//     as the logged-in user, and delivers the reply back via `__hostReply`.
//   * `__CTX` (injected by the client before this source) carries the theme.
//
// Conservative JS style (var, function expressions, no template literals) to stay
// comfortably inside js2elpian.

import 'reactnative.js';

// --------------------------------------------------------------------------- //
// Host bridge (guest side)                                                     //
// --------------------------------------------------------------------------- //

var __hostSeq = 0;
var __hostCbs = {};

function __hostReply(a) {
  var rid = '' + a[0];
  var ok = a[1];
  var data = a[2];
  var cb = __hostCbs[rid];
  if (cb != null) {
    __hostCbs[rid] = null;
    cb(ok ? null : data, ok ? data : null);
  }
}

function hostCall(method, payload, cb) {
  __hostSeq = __hostSeq + 1;
  var rid = '' + __hostSeq;
  __hostCbs[rid] = cb;
  askHost('host.call', [{ rid: rid, method: method, payload: payload }]);
}

// --------------------------------------------------------------------------- //
// Theme                                                                        //
// --------------------------------------------------------------------------- //

function ctx() {
  return (typeof __CTX !== 'undefined' && __CTX != null) ? __CTX : {};
}

function theme() {
  var t = ctx().theme;
  if (t == null) t = {};
  return {
    bg: t.bg || '#0b1220',
    surface: t.surface || '#111a2e',
    surfaceAlt: t.surfaceAlt || '#16223b',
    line: t.line || '#22304d',
    text: t.text || '#e6edf7',
    muted: t.muted || '#8ea3c4',
    accent: t.accent || '#4ade80',
    onAccent: t.onAccent || '#052e16',
    danger: t.danger || '#f87171'
  };
}

// --------------------------------------------------------------------------- //
// State                                                                        //
// --------------------------------------------------------------------------- //

var S = {
  url: '',
  loading: false,
  error: null,
  title: '',
  currentUrl: '',
  shot: null      // data URI of the latest screenshot
};

var W = {};

// The session name so the front-end shares one browser tab across calls (the
// back-end keys the session by space_id + this name).
var SESSION = 'desktop';

// --------------------------------------------------------------------------- //
// Data                                                                         //
// --------------------------------------------------------------------------- //

function shoot() {
  hostCall('screenshot', { session: SESSION, format: 'jpeg', quality: 60 }, function (err, res) {
    if (err == null && res != null && res.ok !== false && res.image) {
      S.shot = 'data:image/jpeg;base64,' + res.image;
      renderView();
    }
  });
}

function go() {
  var u = S.url || '';
  if (u === '') return;
  S.loading = true;
  S.error = null;
  renderStatus();
  hostCall('navigate', { session: SESSION, url: u }, function (err, res) {
    S.loading = false;
    if (err != null) {
      S.error = '' + err;
    } else if (res == null || res.ok === false) {
      S.error = (res && res.error) ? res.error : 'could not open this page';
    } else {
      S.error = null;
      S.title = res.title || '';
      S.currentUrl = res.url || u;
    }
    renderStatus();
    if (S.error == null) shoot();
  });
}

function reload() {
  S.loading = true;
  S.error = null;
  renderStatus();
  hostCall('reload', { session: SESSION }, function (err, res) {
    S.loading = false;
    if (err == null && res != null && res.ok !== false) {
      S.title = res.title || S.title;
      S.currentUrl = res.url || S.currentUrl;
    }
    renderStatus();
    shoot();
  });
}

function back() {
  hostCall('back', { session: SESSION }, function (err, res) {
    if (err == null && res != null && res.ok !== false) {
      S.title = res.title || '';
      S.currentUrl = res.url || S.currentUrl;
      renderStatus();
      shoot();
    }
  });
}

function scrollBy(dy) {
  hostCall('scroll', { session: SESSION, dy: dy }, function () { shoot(); });
}

// --------------------------------------------------------------------------- //
// UI                                                                           //
// --------------------------------------------------------------------------- //

var T = theme();

function iconButton(glyph, onPress) {
  var b = RN.pressable({
    onPress: onPress,
    style: {
      width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
      backgroundColor: T.surfaceAlt, borderWidth: 1, borderColor: T.line, marginLeft: 6
    }
  });
  b.add(RN.text(glyph, { fontSize: 15, color: T.text }));
  return b;
}

function build() {
  T = theme();
  var root = RN.column({ style: { flex: 1, backgroundColor: T.bg } });

  // Toolbar
  var bar = RN.row({
    style: {
      alignItems: 'center', paddingHorizontal: 10, paddingVertical: 10,
      borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface
    }
  });
  bar.add(iconButton('‹', back));
  bar.add(iconButton('⟳', reload));
  W.input = RN.input({
    placeholder: 'Enter a URL…',
    placeholderTextColor: T.muted,
    onChangeText: function (v) { S.url = v; },
    onSubmitEditing: go,
    style: {
      flex: 1, marginLeft: 8, color: T.text, backgroundColor: T.surfaceAlt, borderWidth: 1, borderColor: T.line,
      borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13
    }
  });
  bar.add(W.input);
  var goBtn = RN.pressable({
    onPress: go,
    style: { marginLeft: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, backgroundColor: T.accent }
  });
  goBtn.add(RN.text('Go', { color: T.onAccent, fontSize: 13, fontWeight: '700' }));
  bar.add(goBtn);
  root.add(bar);

  // Status line
  W.status = RN.text('', { color: T.muted, fontSize: 12, style: { paddingHorizontal: 12, paddingTop: 6 } });
  root.add(W.status);

  // Page view (screenshot)
  W.view = RN.scroll({ style: { flex: 1, backgroundColor: T.bg } });
  root.add(W.view);

  // Scroll controls
  var ctrls = RN.row({
    style: {
      justifyContent: 'center', paddingVertical: 8,
      borderTopWidth: 1, borderTopColor: T.line, backgroundColor: T.surface
    }
  });
  var up = RN.pressable({
    onPress: function () { scrollBy(-600); },
    style: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 8, backgroundColor: T.surfaceAlt, marginHorizontal: 6 }
  });
  up.add(RN.text('▲ Up', { color: T.text, fontSize: 12, fontWeight: '600' }));
  ctrls.add(up);
  var down = RN.pressable({
    onPress: function () { scrollBy(600); },
    style: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 8, backgroundColor: T.surfaceAlt, marginHorizontal: 6 }
  });
  down.add(RN.text('▼ Down', { color: T.text, fontSize: 12, fontWeight: '600' }));
  ctrls.add(down);
  root.add(ctrls);

  RN.mount(root);
  renderStatus();
  renderView();
}

function renderStatus() {
  if (W.status == null) return;
  if (S.loading) {
    W.status.set('text', 'Loading…');
    W.status.set('color', T.muted);
  } else if (S.error != null) {
    W.status.set('text', '⚠ ' + S.error);
    W.status.set('color', T.danger);
  } else if (S.currentUrl !== '') {
    W.status.set('text', (S.title ? S.title + '  ·  ' : '') + S.currentUrl);
    W.status.set('color', T.muted);
  } else {
    W.status.set('text', '');
  }
}

function renderView() {
  if (W.view == null) return;
  W.view.clear();
  if (S.shot != null) {
    // A tall image; the scroll view lets the whole capture be panned.
    W.view.add(RN.image({ source: { uri: S.shot }, style: { width: '100%', height: 1400, resizeMode: 'contain' } }));
    return;
  }
  var empty = RN.column({ style: { alignItems: 'center', paddingTop: 48 } });
  empty.add(RN.text('🌐', { fontSize: 30 }));
  empty.add(RN.text(S.loading ? 'Loading…' : 'Enter a URL and press Go', {
    color: T.muted, fontSize: 13, style: { marginTop: 8 }
  }));
  W.view.add(empty);
}

// --------------------------------------------------------------------------- //
// Compact widget (desktop grid)                                                //
// --------------------------------------------------------------------------- //

function isWidgetMode() {
  return ctx().mode === 'widget';
}

function buildWidget() {
  T = theme();
  var root = RN.column({
    style: { flex: 1, backgroundColor: T.bg, padding: 12, justifyContent: 'space-between' }
  });
  var top = RN.row({ style: { alignItems: 'center' } });
  top.add(RN.text('🌐', { fontSize: 20, style: { marginRight: 8 } }));
  var titleCol = RN.column({ style: { flex: 1 } });
  titleCol.add(RN.text('Browser', { color: T.text, fontSize: 14, fontWeight: '700' }));
  titleCol.add(RN.text('automate a real browser', { color: T.muted, fontSize: 11 }));
  top.add(titleCol);
  root.add(top);
  root.add(RN.text('Tap to open', { color: T.muted, fontSize: 11 }));
  RN.mount(root);
}

// --------------------------------------------------------------------------- //
// Boot                                                                         //
// --------------------------------------------------------------------------- //

function main() {
  if (isWidgetMode()) {
    buildWidget();
    return;
  }
  build();
}

main();
