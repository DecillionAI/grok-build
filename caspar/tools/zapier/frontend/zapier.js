// zapier — the tool's front-end (a Victor "mini app").
//
// This runs on the Elpian VM inside the Decillion client (the space "desktop"),
// NOT on the Caspar node. It is deployed as the downloadable `frontend` entity on
// the zapier tool's own program, fetched at runtime by the client and run in the
// Victor React-Native host. It is where a person **connects their Zapier account
// and authorizes each app**, and where they can browse and run those actions by
// hand — the same actions the space's agents then drive through the back-end.
//
// Wire to the host:
//   * `hostCall(fn, args, cb)` → askHost("host.call", …) → the client signs a
//     Caspar signal to THIS tool's back-end (`{ function: fn, payload: args }`)
//     as the logged-in user, and delivers the reply via `__hostReply`.
//   * `host:openWebview` opens Zapier's own "connect your apps" panel in an
//     in-app iframe over the tool sheet (served by the creature's embed route);
//     `host:openUrl` opens Zapier in the system browser as the fallback.
//   * `__CTX` (injected by the client before this source) carries the theme.
//
// The connect wait is server-paced: the back-end long-polls `connect_wait`, so a
// "pending" reply just re-invokes — no guest timer.
//
// Conservative JS (var, function expressions, no template literals, no string
// indexing) to stay comfortably inside js2elpian.

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

function openUrl(url) {
  if (url == null || url === '') return;
  hostCall('host:openUrl', { url: url }, function () {});
}

function openWebview(url, title) {
  if (url == null || url === '') return;
  hostCall('host:openWebview', { url: url, title: title || 'Zapier' }, function () {});
}

function closeWebview() {
  hostCall('host:closeWebview', {}, function () {});
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
    accent: t.accent || '#ff6d3f',
    accentSoft: t.accentSoft || 'rgba(255,109,63,0.14)',
    onAccent: t.onAccent || '#1a0c05',
    danger: t.danger || '#f87171',
    ok: t.ok || '#4ade80',
    link: t.link || '#7dd3fc'
  };
}

var T = theme();

// --------------------------------------------------------------------------- //
// State                                                                        //
// --------------------------------------------------------------------------- //

var S = {
  view: 'loading',   // loading | connect | apps | actions | action | result | settings
  busy: false,
  notice: null,
  noticeBad: false,

  conn: null,        // the `status` reply
  connect: null,     // the `connect` reply (embed url / steps)
  waitEpoch: 0,
  token: '',

  apps: [],
  appCount: 0,
  actionCount: 0,

  app: null,         // the app row being browsed
  query: '',
  actions: [],
  actionsNote: '',

  detail: null,      // the `describe` reply
  fields: [],        // [{ name, value, required, description }]
  instructions: '',

  result: null,
  error: null
};

var W = {};
var WW = {};

// --------------------------------------------------------------------------- //
// Helpers                                                                      //
// --------------------------------------------------------------------------- //

function trim(s) {
  if (s == null) return '';
  var v = '' + s;
  return v.trim ? v.trim() : v;
}

function errText(err, res, fallback) {
  if (res != null && res.error != null && res.error !== '') return '' + res.error;
  if (err != null) return '' + err;
  return fallback;
}

function toast(message, bad) {
  S.notice = message;
  S.noticeBad = bad === true;
  renderNotice();
}

function clearNotice() {
  S.notice = null;
  S.noticeBad = false;
  renderNotice();
}

// --------------------------------------------------------------------------- //
// Data                                                                         //
// --------------------------------------------------------------------------- //

function loadStatus(then) {
  hostCall('status', {}, function (err, res) {
    if (err != null || res == null || res.ok === false) {
      S.error = errText(err, res, 'could not reach the Zapier tool');
      S.view = 'connect';
      render();
      return;
    }
    S.conn = res;
    S.appCount = res.app_count || 0;
    S.actionCount = res.action_count || 0;
    if (then != null) { then(res); return; }
    if (res.connected === true) { loadApps(); return; }
    S.view = 'connect';
    render();
  });
}

function loadApps() {
  S.busy = true;
  S.view = 'apps';
  render();
  hostCall('apps', {}, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      S.error = errText(err, res, 'could not list the connected apps');
      S.view = 'connect';
      render();
      return;
    }
    S.error = null;
    S.apps = res.apps || [];
    S.appCount = res.app_count || S.apps.length;
    S.actionCount = res.action_count || 0;
    render();
  });
}

function loadActions(app, query) {
  S.app = app;
  S.query = query || '';
  S.actions = [];
  S.busy = true;
  S.view = 'actions';
  render();
  var args = { limit: 60 };
  if (app != null && app.app != null) args.app = app.app;
  if (S.query !== '') args.query = S.query;
  hostCall('actions', args, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      S.error = errText(err, res, 'could not list actions');
      render();
      return;
    }
    S.error = null;
    S.actions = res.actions || [];
    S.actionsNote = res.note || '';
    render();
  });
}

function openAction(row) {
  S.detail = null;
  S.fields = [];
  S.instructions = '';
  S.result = null;
  S.busy = true;
  S.view = 'action';
  render();
  hostCall('describe', { tool: row.name }, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      S.error = errText(err, res, 'could not read that action');
      render();
      return;
    }
    S.error = null;
    S.detail = res;
    var params = res.params || [];
    var list = [];
    var i = 0;
    while (i < params.length && i < 20) {
      var p = params[i];
      list.push({
        name: p.name,
        value: '',
        required: p.required === true,
        description: p.description || ''
      });
      i = i + 1;
    }
    S.fields = list;
    render();
  });
}

function runAction() {
  if (S.detail == null) return;
  var params = {};
  var any = false;
  var i = 0;
  while (i < S.fields.length) {
    var f = S.fields[i];
    var v = trim(f.value);
    if (v !== '') { params[f.name] = v; any = true; }
    i = i + 1;
  }
  var instructions = trim(S.instructions);
  if (!any && instructions === '') {
    toast('fill in a field or describe what to do', true);
    return;
  }
  S.busy = true;
  S.result = null;
  clearNotice();
  render();
  var args = { tool: S.detail.name, params: params };
  if (instructions !== '') args.instructions = instructions;
  hostCall('run', args, function (err, res) {
    S.busy = false;
    if (err != null || res == null) {
      S.error = errText(err, res, 'the action did not run');
      S.view = 'result';
      S.result = null;
      render();
      return;
    }
    S.result = res;
    S.error = (res.ok === false) ? errText(null, res, 'the action failed') : null;
    S.view = 'result';
    render();
  });
}

function refreshActions() {
  S.busy = true;
  render();
  hostCall('refresh', {}, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      toast(errText(err, res, 'could not refresh'), true);
      render();
      return;
    }
    toast('' + (res.action_count || 0) + ' actions across ' + (res.app_count || 0) + ' apps', false);
    loadApps();
  });
}

// --------------------------------------------------------------------------- //
// Connecting                                                                   //
// --------------------------------------------------------------------------- //

function startConnect() {
  S.busy = true;
  clearNotice();
  render();
  hostCall('connect', {}, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      toast(errText(err, res, 'could not start the connect flow'), true);
      render();
      return;
    }
    S.connect = res;
    render();
    if (res.embed_url != null && res.embed_url !== '') {
      openWebview(res.embed_url, 'Connect your apps');
      S.waitEpoch = S.waitEpoch + 1;
      pollConnect(S.waitEpoch, res.handshake);
    } else {
      openUrl(res.manage_url || 'https://mcp.zapier.com/');
    }
  });
}

// Server-paced wait: the back-end blocks until the embed hands back the user's
// personal Zapier server, so a "pending" reply just calls again.
function pollConnect(epoch, handshake) {
  if (epoch !== S.waitEpoch) return;
  hostCall('connect_wait', { handshake: handshake, wait_seconds: 25 }, function (err, res) {
    if (epoch !== S.waitEpoch) return;
    if (err != null || res == null || res.ok === false) {
      toast(errText(err, res, 'the connect flow failed'), true);
      return;
    }
    if (res.status === 'connected' || res.connected === true) {
      S.waitEpoch = S.waitEpoch + 1;
      S.connect = null;
      closeWebview();
      toast('Zapier connected', false);
      loadStatus(function () { loadApps(); });
      return;
    }
    if (res.status === 'expired') {
      S.waitEpoch = S.waitEpoch + 1;
      S.connect = null;
      toast('the connect link timed out — try again', true);
      render();
      return;
    }
    pollConnect(epoch, handshake);
  });
}

function saveToken() {
  var token = trim(S.token);
  if (token === '') {
    toast('paste your Zapier connection token first', true);
    return;
  }
  S.busy = true;
  clearNotice();
  render();
  hostCall('connect', { token: token }, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      toast(errText(err, res, 'that token did not work'), true);
      render();
      return;
    }
    S.token = '';
    S.connect = null;
    toast('connected · ' + (res.app_count || 0) + ' apps', false);
    loadStatus(function () { loadApps(); });
  });
}

function usePlatform() {
  S.connect = null;
  loadApps();
}

function setShared(value) {
  S.busy = true;
  render();
  hostCall('set_shared', { shared: value }, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      toast(errText(err, res, 'could not change sharing'), true);
      render();
      return;
    }
    toast(res.note || 'updated', false);
    loadStatus(function () { render(); });
  });
}

function disconnect() {
  S.busy = true;
  render();
  hostCall('disconnect', {}, function (err, res) {
    S.busy = false;
    if (err != null || res == null || res.ok === false) {
      toast(errText(err, res, 'could not disconnect'), true);
      render();
      return;
    }
    S.apps = [];
    S.conn = null;
    toast('disconnected', false);
    loadStatus(function (st) {
      if (st.connected === true) { loadApps(); return; }
      S.view = 'connect';
      render();
    });
  });
}

// --------------------------------------------------------------------------- //
// UI primitives                                                                //
// --------------------------------------------------------------------------- //

function button(label, onPress, kind) {
  var bg = T.surfaceAlt;
  var fg = T.text;
  if (kind === 'primary') { bg = T.accent; fg = T.onAccent; }
  if (kind === 'danger') { bg = 'transparent'; fg = T.danger; }
  var p = RN.pressable({
    onPress: onPress,
    style: {
      paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, marginRight: 8,
      backgroundColor: bg, borderWidth: kind === 'danger' ? 1 : 0, borderColor: T.line
    }
  });
  p.add(RN.text(label, { color: fg, fontSize: 13, fontWeight: '700' }));
  return p;
}

function field(label, value, placeholder, onChange, hint) {
  var col = RN.column({ style: { marginBottom: 12 } });
  col.add(RN.text(label, { color: T.muted, fontSize: 11, fontWeight: '700' }));
  if (hint != null && hint !== '') {
    col.add(RN.text(hint, { color: T.muted, fontSize: 10, style: { marginTop: 2 } }));
  }
  col.add(RN.input({
    placeholder: placeholder || '',
    placeholderTextColor: T.muted,
    defaultValue: value || '',
    onChangeText: onChange,
    style: {
      marginTop: 5, color: T.text, backgroundColor: T.surfaceAlt, borderWidth: 1,
      borderColor: T.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 13
    }
  }));
  return col;
}

function card() {
  return RN.column({
    style: {
      backgroundColor: T.surface, borderRadius: 12, borderWidth: 1, borderColor: T.line,
      padding: 14, marginBottom: 10
    }
  });
}

function listRow(title, subtitle, onPress, badge) {
  var row = RN.pressable({
    onPress: onPress,
    style: {
      paddingHorizontal: 12, paddingVertical: 11, marginBottom: 6, borderRadius: 10,
      backgroundColor: T.surface, borderWidth: 1, borderColor: T.line
    }
  });
  var top = RN.row({ style: { alignItems: 'center' } });
  var col = RN.column({ style: { flex: 1 } });
  col.add(RN.text(title, { color: T.text, fontSize: 14, fontWeight: '600' }));
  if (subtitle != null && subtitle !== '') {
    col.add(RN.text(subtitle, { color: T.muted, fontSize: 11, style: { marginTop: 2 } }));
  }
  top.add(col);
  if (badge != null && badge !== '') {
    top.add(RN.text(badge, { color: T.accent, fontSize: 11, fontWeight: '700' }));
  }
  row.add(top);
  return row;
}

// --------------------------------------------------------------------------- //
// Shell                                                                        //
// --------------------------------------------------------------------------- //

function build() {
  T = theme();
  var root = RN.column({ style: { flex: 1, backgroundColor: T.bg } });

  W.header = RN.column({
    style: {
      paddingHorizontal: 14, paddingVertical: 12,
      borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface
    }
  });
  root.add(W.header);

  W.notice = RN.column({ style: { paddingHorizontal: 14 } });
  root.add(W.notice);

  W.body = RN.scroll({ style: { flex: 1, paddingHorizontal: 12, paddingTop: 10 } });
  root.add(W.body);

  RN.mount(root);
  render();
}

function render() {
  renderHeader();
  renderNotice();
  renderBody();
}

function backTo(view) {
  return function () {
    S.error = null;
    if (view === 'apps') { S.app = null; S.query = ''; }
    S.view = view;
    render();
  };
}

function renderHeader() {
  if (W.header == null) return;
  W.header.clear();

  var top = RN.row({ style: { alignItems: 'center' } });
  var titleCol = RN.column({ style: { flex: 1 } });
  titleCol.add(RN.text('Zapier', { color: T.text, fontSize: 16, fontWeight: '700' }));
  titleCol.add(RN.text(headerSub(), { color: T.muted, fontSize: 11, style: { marginTop: 2 } }));
  top.add(titleCol);
  if (S.busy) top.add(RN.spinner({ color: T.accent }));
  W.header.add(top);

  var bar = RN.row({ style: { marginTop: 10, alignItems: 'center', flexWrap: 'wrap' } });
  if (S.view === 'actions') bar.add(button('‹ Apps', backTo('apps')));
  if (S.view === 'action') bar.add(button('‹ Actions', backTo('actions')));
  if (S.view === 'result') bar.add(button('‹ Back', backTo('action')));
  if (S.view === 'apps') {
    bar.add(button('Refresh', refreshActions));
    bar.add(button('Settings', backTo('settings')));
  }
  if (S.view === 'settings') bar.add(button('‹ Apps', backTo('apps')));
  if (S.view === 'connect' && S.conn != null && S.conn.connected === true) {
    bar.add(button('‹ Apps', backTo('apps')));
  }
  W.header.add(bar);
}

function headerSub() {
  if (S.conn == null) return 'every app you connected, in this project';
  if (S.conn.connected !== true) return 'not connected yet';
  var label = 'connected';
  if (S.conn.active != null && S.conn.active.label != null) label = '' + S.conn.active.label;
  if (S.appCount > 0) {
    return label + ' · ' + S.appCount + ' apps · ' + S.actionCount + ' actions';
  }
  return label;
}

function renderNotice() {
  if (W.notice == null) return;
  W.notice.clear();
  if (S.notice == null || S.notice === '') return;
  var box = RN.row({
    style: {
      alignItems: 'center', marginTop: 10, paddingHorizontal: 12, paddingVertical: 8,
      borderRadius: 10, backgroundColor: S.noticeBad ? 'rgba(248,113,113,0.12)' : T.accentSoft
    }
  });
  box.add(RN.text(S.notice, {
    color: S.noticeBad ? T.danger : T.text, fontSize: 12, style: { flex: 1 }
  }));
  var x = RN.pressable({ onPress: clearNotice, style: { paddingHorizontal: 6 } });
  x.add(RN.text('✕', { color: T.muted, fontSize: 12 }));
  box.add(x);
  W.notice.add(box);
}

function renderBody() {
  if (W.body == null) return;
  W.body.clear();
  if (S.view === 'loading') {
    W.body.add(RN.spinner({ color: T.accent, style: { marginTop: 28 } }));
    return;
  }
  if (S.view === 'connect') { renderConnect(); return; }
  if (S.view === 'apps') { renderApps(); return; }
  if (S.view === 'actions') { renderActionList(); return; }
  if (S.view === 'action') { renderActionForm(); return; }
  if (S.view === 'result') { renderResult(); return; }
  if (S.view === 'settings') { renderSettings(); return; }
}

// --------------------------------------------------------------------------- //
// Connect screen                                                               //
// --------------------------------------------------------------------------- //

function stepRow(n, text, url) {
  var row = RN.row({ style: { alignItems: 'flex-start', marginTop: 8 } });
  var dot = RN.column({
    style: {
      width: 20, height: 20, borderRadius: 10, backgroundColor: T.accentSoft,
      alignItems: 'center', justifyContent: 'center', marginRight: 8
    }
  });
  dot.add(RN.text('' + n, { color: T.accent, fontSize: 11, fontWeight: '700' }));
  row.add(dot);
  var col = RN.column({ style: { flex: 1 } });
  col.add(RN.text(text, { color: T.text, fontSize: 12 }));
  if (url != null && url !== '') {
    var link = RN.pressable({ onPress: openHandler(url), style: { marginTop: 2 } });
    link.add(RN.text('Open ↗', { color: T.link, fontSize: 11, fontWeight: '700' }));
    col.add(link);
  }
  row.add(col);
  return row;
}

function openHandler(url) {
  return function () { openUrl(url); };
}

function renderConnect() {
  var intro = card();
  intro.add(RN.text('Connect your apps', { color: T.text, fontSize: 15, fontWeight: '700' }));
  intro.add(RN.text(
    'Authorize your accounts once in Zapier — Gmail, Slack, Calendar, Sheets, Notion, your CRM, ' +
    'anything it supports. After that this project’s agents can act in those apps for you, ' +
    'and Zapier keeps the credentials: no app password ever reaches an agent.',
    { color: T.muted, fontSize: 12, style: { marginTop: 6 } }
  ));
  var actions = RN.row({ style: { marginTop: 12, flexWrap: 'wrap' } });
  var embedReady = S.conn != null && S.conn.embed_available === true;
  actions.add(button(embedReady ? 'Connect apps' : 'Open Zapier ↗', startConnect, 'primary'));
  if (S.conn != null && S.conn.connections_url != null) {
    actions.add(button('My connections ↗', openHandler(S.conn.connections_url)));
  }
  intro.add(actions);
  W.body.add(intro);

  if (S.connect != null && S.connect.embed_url != null && S.connect.embed_url !== '') {
    var waiting = card();
    waiting.add(RN.text('Waiting for Zapier…', { color: T.text, fontSize: 13, fontWeight: '700' }));
    waiting.add(RN.text(
      'Authorize your apps in the panel that opened. This screen updates by itself when you are done.',
      { color: T.muted, fontSize: 12, style: { marginTop: 6 } }
    ));
    var again = RN.row({ style: { marginTop: 10 } });
    again.add(button('Reopen panel', reopenEmbed));
    waiting.add(again);
    W.body.add(waiting);
  }

  // The universal path: paste a connection token from mcp.zapier.com.
  var manual = card();
  manual.add(RN.text('…or paste a connection token', {
    color: T.text, fontSize: 13, fontWeight: '700'
  }));
  var steps = (S.connect != null && S.connect.steps != null) ? S.connect.steps : defaultSteps();
  var i = 0;
  while (i < steps.length) {
    manual.add(stepRow(steps[i].n || (i + 1), steps[i].text || '', steps[i].url));
    i = i + 1;
  }
  manual.add(RN.view({ style: { height: 10 } }));
  manual.add(field('Connection token', S.token, 'sk-… or the full server URL',
    function (v) { S.token = v; }, null));
  var save = RN.row({});
  save.add(button('Save token', saveToken, 'primary'));
  manual.add(save);
  W.body.add(manual);

  if (S.conn != null && S.conn.platform != null && S.conn.platform.configured === true) {
    var plat = card();
    plat.add(RN.text('Platform workspace', { color: T.text, fontSize: 13, fontWeight: '700' }));
    plat.add(RN.text(
      'This deployment ships a shared Zapier workspace you can use right away. Connect your own ' +
      'account above when you want agents acting in your accounts.',
      { color: T.muted, fontSize: 12, style: { marginTop: 6 } }
    ));
    var pr = RN.row({ style: { marginTop: 10 } });
    pr.add(button('Browse its apps', usePlatform));
    plat.add(pr);
    W.body.add(plat);
  }

  if (S.error != null) {
    W.body.add(RN.text('⚠ ' + S.error, { color: T.danger, fontSize: 12, style: { marginTop: 4 } }));
  }
  W.body.add(RN.view({ style: { height: 24 } }));
}

function defaultSteps() {
  return [
    { n: 1, text: 'Open Zapier MCP and sign in', url: 'https://mcp.zapier.com/' },
    { n: 2, text: 'Add the apps and actions you want, authorizing each account' },
    { n: 3, text: 'Copy your server’s connection token and paste it below' }
  ];
}

function reopenEmbed() {
  if (S.connect != null && S.connect.embed_url != null) {
    openWebview(S.connect.embed_url, 'Connect your apps');
  }
}

// --------------------------------------------------------------------------- //
// Apps / actions                                                               //
// --------------------------------------------------------------------------- //

function appHandler(row) {
  return function () { loadActions(row, ''); };
}

function renderApps() {
  if (S.error != null) {
    W.body.add(RN.text('⚠ ' + S.error, { color: T.danger, fontSize: 12, style: { marginBottom: 10 } }));
  }
  var search = card();
  search.add(field('Search every action', S.query, 'send an email, create a calendar event…',
    function (v) { S.query = v; }, null));
  var go = RN.row({});
  go.add(button('Search', function () { loadActions(null, S.query); }, 'primary'));
  go.add(button('Connect another account', backTo('connect')));
  search.add(go);
  W.body.add(search);

  if (S.busy && S.apps.length === 0) {
    W.body.add(RN.spinner({ color: T.accent, style: { marginTop: 20 } }));
    return;
  }
  if (S.apps.length === 0) {
    var empty = RN.column({ style: { alignItems: 'center', paddingTop: 30, paddingHorizontal: 16 } });
    empty.add(RN.text('🔌', { fontSize: 28 }));
    empty.add(RN.text('No apps are connected to this Zapier account yet.', {
      color: T.muted, fontSize: 13, textAlign: 'center', style: { marginTop: 8 } }));
    var er = RN.row({ style: { marginTop: 12 } });
    er.add(button('Connect apps', backTo('connect'), 'primary'));
    empty.add(er);
    W.body.add(empty);
    return;
  }
  W.body.add(RN.text('Connected apps', {
    color: T.muted, fontSize: 11, fontWeight: '700', style: { marginBottom: 6 } }));
  var i = 0;
  while (i < S.apps.length) {
    var row = S.apps[i];
    W.body.add(listRow(row.label || row.app, row.summary || '', appHandler(row),
      '' + (row.actions || '')));
    i = i + 1;
  }
  W.body.add(RN.view({ style: { height: 24 } }));
}

function actionHandler(row) {
  return function () { openAction(row); };
}

function renderActionList() {
  if (S.error != null) {
    W.body.add(RN.text('⚠ ' + S.error, { color: T.danger, fontSize: 12, style: { marginBottom: 10 } }));
  }
  var head = RN.text(
    S.app != null ? ('' + (S.app.label || S.app.app)) : ('Results for “' + S.query + '”'),
    { color: T.text, fontSize: 14, fontWeight: '700', style: { marginBottom: 8 } }
  );
  W.body.add(head);
  if (S.busy && S.actions.length === 0) {
    W.body.add(RN.spinner({ color: T.accent, style: { marginTop: 20 } }));
    return;
  }
  if (S.actions.length === 0) {
    W.body.add(RN.text(S.actionsNote || 'Nothing matched.', { color: T.muted, fontSize: 12 }));
    return;
  }
  var i = 0;
  while (i < S.actions.length) {
    var row = S.actions[i];
    W.body.add(listRow(row.title || row.name, row.summary || row.name, actionHandler(row), ''));
    i = i + 1;
  }
  W.body.add(RN.view({ style: { height: 24 } }));
}

// --------------------------------------------------------------------------- //
// Run a single action                                                          //
// --------------------------------------------------------------------------- //

function fieldSetter(entry) {
  return function (v) { entry.value = v; };
}

function renderActionForm() {
  if (S.busy && S.detail == null) {
    W.body.add(RN.spinner({ color: T.accent, style: { marginTop: 24 } }));
    return;
  }
  if (S.detail == null) {
    W.body.add(RN.text(S.error != null ? ('⚠ ' + S.error) : 'Nothing to show.',
      { color: S.error != null ? T.danger : T.muted, fontSize: 12 }));
    return;
  }
  var head = card();
  head.add(RN.text(S.detail.title || S.detail.name, {
    color: T.text, fontSize: 15, fontWeight: '700' }));
  head.add(RN.text(S.detail.name, { color: T.muted, fontSize: 11, style: { marginTop: 2 } }));
  if (S.detail.description != null && S.detail.description !== '') {
    head.add(RN.text(S.detail.description, {
      color: T.muted, fontSize: 12, style: { marginTop: 8 } }));
  }
  W.body.add(head);

  var form = card();
  form.add(field('What should happen?', S.instructions,
    'Describe it in plain English — Zapier fills anything you leave blank',
    function (v) { S.instructions = v; }, null));
  var i = 0;
  while (i < S.fields.length) {
    var f = S.fields[i];
    form.add(field(f.name + (f.required ? ' *' : ''), f.value, '', fieldSetter(f), f.description));
    i = i + 1;
  }
  var actions = RN.row({ style: { marginTop: 2 } });
  actions.add(button(S.busy ? 'Running…' : 'Run', runAction, 'primary'));
  actions.add(button('Cancel', backTo('actions')));
  form.add(actions);
  W.body.add(form);
  W.body.add(RN.view({ style: { height: 24 } }));
}

function renderResult() {
  var res = S.result;
  var head = card();
  var okRun = res != null && res.ok !== false;
  head.add(RN.text(okRun ? '✓ Done' : '⚠ Failed', {
    color: okRun ? T.ok : T.danger, fontSize: 15, fontWeight: '700' }));
  if (res != null && res.tool != null) {
    head.add(RN.text('' + res.tool, { color: T.muted, fontSize: 11, style: { marginTop: 2 } }));
  }
  W.body.add(head);

  if (res != null && res.needs_auth === true) {
    var auth = card();
    auth.add(RN.text('That app is not authorized in Zapier', {
      color: T.text, fontSize: 13, fontWeight: '700' }));
    auth.add(RN.text('Reauthorize the account, then run this again.', {
      color: T.muted, fontSize: 12, style: { marginTop: 6 } }));
    var ar = RN.row({ style: { marginTop: 10 } });
    ar.add(button('Fix in Zapier ↗', openHandler(res.connections_url || 'https://mcp.zapier.com/'), 'primary'));
    auth.add(ar);
    W.body.add(auth);
  }

  var bodyCard = card();
  var text = '';
  if (res != null && res.text != null) text = '' + res.text;
  if (text === '' && S.error != null) text = '' + S.error;
  bodyCard.add(RN.text(text !== '' ? text : 'The action returned no output.', {
    color: text !== '' ? T.text : T.muted, fontSize: 12 }));
  W.body.add(bodyCard);

  var again = RN.row({});
  again.add(button('Run again', backTo('action'), 'primary'));
  again.add(button('Apps', backTo('apps')));
  W.body.add(again);
  W.body.add(RN.view({ style: { height: 24 } }));
}

// --------------------------------------------------------------------------- //
// Settings                                                                     //
// --------------------------------------------------------------------------- //

function renderSettings() {
  var conn = S.conn;
  var info = card();
  info.add(RN.text('Connection', { color: T.text, fontSize: 14, fontWeight: '700' }));
  var label = 'not connected';
  if (conn != null && conn.active != null && conn.active.label != null) label = '' + conn.active.label;
  info.add(RN.text(label, { color: T.muted, fontSize: 12, style: { marginTop: 4 } }));
  if (conn != null && conn.active != null && conn.active.scope != null) {
    info.add(RN.text('scope: ' + conn.active.scope, {
      color: T.muted, fontSize: 11, style: { marginTop: 2 } }));
  }
  W.body.add(info);

  var isOwner = conn != null && conn.space != null && conn.space.is_owner === true;
  if (conn != null && conn.space != null && conn.space.connected === true) {
    var share = card();
    share.add(RN.text('Who can use it', { color: T.text, fontSize: 14, fontWeight: '700' }));
    share.add(RN.text(
      conn.space.shared === true
        ? 'Everyone in this project — including its agents — can act through your Zapier account.'
        : 'Only you. This project’s agents fall back to the platform workspace.',
      { color: T.muted, fontSize: 12, style: { marginTop: 6 } }
    ));
    if (isOwner) {
      var sr = RN.row({ style: { marginTop: 10 } });
      if (conn.space.shared === true) {
        sr.add(button('Make private', function () { setShared(false); }));
      } else {
        sr.add(button('Share with the project', function () { setShared(true); }, 'primary'));
      }
      share.add(sr);
    } else {
      share.add(RN.text('Only the member who connected it can change this.', {
        color: T.muted, fontSize: 11, style: { marginTop: 8 } }));
    }
    W.body.add(share);
  }

  var manage = card();
  manage.add(RN.text('Manage in Zapier', { color: T.text, fontSize: 14, fontWeight: '700' }));
  manage.add(RN.text('Add apps, add actions, or reauthorize an account.', {
    color: T.muted, fontSize: 12, style: { marginTop: 6 } }));
  var mr = RN.row({ style: { marginTop: 10, flexWrap: 'wrap' } });
  mr.add(button('MCP server ↗', openHandler((conn && conn.manage_url) || 'https://mcp.zapier.com/')));
  mr.add(button('App connections ↗',
    openHandler((conn && conn.connections_url) || 'https://zapier.com/app/connections')));
  manage.add(mr);
  W.body.add(manage);

  if (isOwner) {
    var danger = card();
    danger.add(RN.text('Disconnect', { color: T.text, fontSize: 14, fontWeight: '700' }));
    danger.add(RN.text('Removes the stored connection. Your Zapier account is untouched.', {
      color: T.muted, fontSize: 12, style: { marginTop: 6 } }));
    var dr = RN.row({ style: { marginTop: 10 } });
    dr.add(button('Disconnect Zapier', disconnect, 'danger'));
    danger.add(dr);
    W.body.add(danger);
  }
  W.body.add(RN.view({ style: { height: 24 } }));
}

// --------------------------------------------------------------------------- //
// Compact widget (desktop grid + chat replies)                                 //
// --------------------------------------------------------------------------- //

function isWidgetMode() {
  return ctx().mode === 'widget';
}

function widgetHead(root, icon, title, sub) {
  var top = RN.row({ style: { alignItems: 'center', marginBottom: 8 } });
  top.add(RN.text(icon, { fontSize: 18, style: { marginRight: 8 } }));
  var col = RN.column({ style: { flex: 1 } });
  col.add(RN.text(title, { color: T.text, fontSize: 14, fontWeight: '700' }));
  if (sub != null && sub !== '') col.add(RN.text(sub, { color: T.muted, fontSize: 11 }));
  top.add(col);
  root.add(top);
}

function widgetRow(entry) {
  var title = 'item';
  if (entry != null) {
    if (entry.title != null && entry.title !== '') title = '' + entry.title;
    else if (entry.label != null && entry.label !== '') title = '' + entry.label;
    else if (entry.name != null) title = '' + entry.name;
  }
  var sub = '';
  if (entry != null) {
    if (entry.summary != null && entry.summary !== '') sub = '' + entry.summary;
    else if (entry.subtitle != null) sub = '' + entry.subtitle;
    else if (entry.description != null) sub = '' + entry.description;
  }
  var row = RN.column({ style: { paddingVertical: 7, borderTopWidth: 1, borderTopColor: T.line } });
  row.add(RN.text(title, { color: T.text, fontSize: 13, fontWeight: '600' }));
  if (sub !== '') row.add(RN.text(sub, { color: T.muted, fontSize: 11, style: { marginTop: 2 } }));
  return row;
}

// Render a chat-command reply. The client hands us `__CTX.data` — the tool's JSON
// answer, plus the render-ready `_view` it computed from the command's widget
// template — so a `@tool zapier …` reply is a real card, never raw JSON.
function buildDataWidget(data, command) {
  T = theme();
  var root = RN.column({ style: { flex: 1, backgroundColor: T.bg, padding: 12 } });

  var rows = null;
  var heading = 'Zapier';
  var sub = '';
  if (data != null) {
    if (data.apps != null && data.apps.length > 0) {
      rows = data.apps;
      heading = 'Connected apps';
      sub = '' + (data.app_count || data.apps.length) + ' apps · ' + (data.action_count || 0) + ' actions';
    } else if (data.actions != null && data.actions.length > 0) {
      rows = data.actions;
      heading = 'Zapier actions';
      sub = (data.query != null && data.query !== '') ? ('“' + data.query + '”') : '';
    } else if (data.candidates != null && data.candidates.length > 0) {
      rows = data.candidates;
      heading = 'Did you mean';
      sub = 'several actions matched';
    }
  }

  if (rows != null) {
    widgetHead(root, '⚡', heading, sub);
    var body = RN.scroll({ style: { flex: 1 } });
    var i = 0;
    while (i < rows.length && i < 20) { body.add(widgetRow(rows[i])); i = i + 1; }
    root.add(body);
    RN.mount(root);
    return;
  }

  var okRun = data == null || data.ok !== false;
  var title = 'Zapier';
  if (data != null && data.title != null && data.title !== '') title = '' + data.title;
  else if (data != null && data.tool != null) title = '' + data.tool;
  else if (command != null && command !== '') title = '' + command;
  widgetHead(root, okRun ? '⚡' : '⚠', title,
    (data != null && data.app_label != null) ? ('' + data.app_label) : '');
  var text = '';
  if (data != null) {
    if (data.ok === false && data.error != null) text = '' + data.error;
    else if (data.text != null && data.text !== '') text = '' + data.text;
    else if (data.instructions != null) text = '' + data.instructions;
    else if (data._view != null && data._view.text != null) text = '' + data._view.text;
  }
  var out = RN.scroll({ style: { flex: 1 } });
  out.add(RN.text(text !== '' ? text : 'Done.', {
    color: okRun ? T.text : T.danger, fontSize: 12 }));
  root.add(out);
  RN.mount(root);
}

function buildWidget() {
  T = theme();
  var data = ctx().data;
  if (data != null) { buildDataWidget(data, ctx().command); return; }
  var root = RN.column({
    style: { flex: 1, backgroundColor: T.bg, padding: 12, justifyContent: 'space-between' }
  });
  var top = RN.row({ style: { alignItems: 'center' } });
  top.add(RN.text('⚡', { fontSize: 20, style: { marginRight: 8 } }));
  var col = RN.column({ style: { flex: 1 } });
  col.add(RN.text('Zapier', { color: T.text, fontSize: 14, fontWeight: '700' }));
  WW.sub = RN.text('checking…', { color: T.muted, fontSize: 11 });
  col.add(WW.sub);
  top.add(col);
  root.add(top);
  WW.hint = RN.text('Tap to connect your apps', { color: T.muted, fontSize: 11 });
  root.add(WW.hint);
  RN.mount(root);

  hostCall('status', {}, function (err, res) {
    if (err != null || res == null || res.ok === false) {
      if (WW.sub != null) { WW.sub.set('text', 'unavailable'); WW.sub.set('color', T.danger); }
      return;
    }
    if (res.connected === true) {
      if (WW.sub != null) {
        WW.sub.set('text', '' + (res.app_count || 0) + ' apps · ' + (res.action_count || 0) + ' actions');
      }
      if (WW.hint != null) WW.hint.set('text', 'Tap to browse and run actions');
    } else {
      if (WW.sub != null) WW.sub.set('text', 'not connected');
      if (WW.hint != null) WW.hint.set('text', 'Tap to connect your apps');
    }
  });
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
  loadStatus(null);
}

main();
