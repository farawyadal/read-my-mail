/**
 * Read My Mail (PWA) — pengganti Apps Script.
 * Memanggil Gmail / Calendar / Drive API terus dari browser dengan log masuk Google (OAuth).
 * Antara muka (index.html) guna RMM.run.<fungsi>() — sama seperti google.script.run sebelum ini.
 * Tetapan & status (selesai, tindakan...) disimpan dalam Drive appDataFolder (tersembunyi, segerak PC <-> telefon).
 */
(function () {
  'use strict';
  var CFG = window.RMM_CONFIG || {};
  var SCOPES = ['https://www.googleapis.com/auth/gmail.modify',
                'https://www.googleapis.com/auth/calendar.readonly',
                'https://www.googleapis.com/auth/drive.appdata'].join(' ');
  var GM = 'https://gmail.googleapis.com/gmail/v1/users/me';
  var CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  var DRIVE = 'https://www.googleapis.com/drive/v3/files';
  var LIMITS = { MAX_THREADS: 60, EMAIL_THRESHOLD: 3, EVENT_THRESHOLD: 2, DAYS_AHEAD: 3, KEEP_IDS: 300, CONC: 8 };

  var DEFAULTS = {
    vip: [], muted: [],
    keywords: ['urgent', 'segera', 'penting', 'deadline', 'tarikh akhir', 'tindakan', 'arahan', 'jemputan', 'mesyuarat', 'meeting'],
    eventKeywords: ['mesyuarat', 'meeting', 'taklimat', 'lawatan', 'deadline', 'temu janji', 'presentation', 'penting', 'urgent'],
    actionWords: ['sila hantar', 'sila kemukakan', 'sila sediakan', 'sila kemaskini', 'sila lengkapkan',
                  'sila semak', 'sila ambil tindakan', 'sila bentang', 'sila beri maklum balas', 'sila isi',
                  'untuk tindakan', 'dimohon hantar', 'dimohon untuk', 'dimohon mengemukakan',
                  'perlu menghantar', 'perlu mengemukakan', 'perlu menyediakan', 'perlu membentang',
                  'tindakan segera', 'bentangkan', 'please send', 'please submit', 'please prepare',
                  'please review', 'please confirm', 'please provide', 'action required',
                  'for your action', 'kindly send', 'kindly submit', 'due by'],
    meetingWords: ['invitation:', 'updated invitation', 'jemputan', 'panggilan mesyuarat', 'mesyuarat',
                   'meeting', 'google meet', 'zoom', 'teams meeting'],
    refresh: 60, days: 7, lang: 'ms', theme: 'system', navPos: 'side', autoDemote: false
  };
  var LIST_KEYS = ['vip', 'muted', 'keywords', 'eventKeywords', 'actionWords', 'meetingWords'];

  // ---------- storan setempat ----------
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // ---------- Log masuk (Google Identity Services, token client) ----------
  var tokenClient = null, tok = lsGet('rmm_tok'), pendingTok = null, refreshing = false;
  function authErr(msg) { var e = new Error(msg); e.code = 'AUTH'; return e; }
  function tokenValid(margin) { return !!(tok && tok.t && tok.exp > Date.now() + (margin || 60000)); }

  function initClient() {
    if (tokenClient) return true;
    if (!(window.google && google.accounts && google.accounts.oauth2)) return false;
    tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CFG.CLIENT_ID, scope: SCOPES, callback: function () {} });
    return true;
  }
  function requestToken(prompt) {
    if (pendingTok) return pendingTok;
    pendingTok = new Promise(function (res, rej) {
      if (!CFG.CLIENT_ID || /PASTE/i.test(CFG.CLIENT_ID)) return rej(authErr('CFG'));
      if (!initClient()) return rej(authErr('GIS'));
      tokenClient.callback = function (r) {
        if (r.error) return rej(authErr(r.error));
        tok = { t: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
        lsSet('rmm_tok', tok); res(tok.t);
      };
      tokenClient.error_callback = function (e) { rej(authErr((e && e.type) || 'popup')); };
      var o = { prompt: prompt }, hint = lsGet('rmm_me');
      if (hint) o.hint = hint;
      tokenClient.requestAccessToken(o);
    });
    var clear = function () { pendingTok = null; };
    pendingTok.then(clear, clear);
    return pendingTok;
  }
  // Tanpa token sah -> minta pengguna log masuk (buka tetingkap Google tanpa sentuhan akan disekat browser)
  function ensureToken() {
    return tokenValid() ? Promise.resolve(tok.t) : Promise.reject(authErr('AUTH'));
  }
  // Token Google tamat selepas ~1 jam. Perbaharui secara senyap bila pengguna menyentuh skrin (gerak isyarat dibenarkan buka tetingkap).
  document.addEventListener('click', function () {
    if (refreshing || !tok || tokenValid(10 * 60000) || !initClient()) return;
    refreshing = true;
    requestToken('').catch(function () {}).then(function () { refreshing = false; });
  }, true);

  function signIn() {
    return requestToken('').then(function () {
      if (window.hideAuth) window.hideAuth();
      if (window.load) window.load();
    }).catch(function (e) { if (window.showAuth) window.showAuth(e.message); });
  }
  function signOut() {
    try { if (tok && window.google && google.accounts) google.accounts.oauth2.revoke(tok.t, function () {}); } catch (e) {}
    ['rmm_tok', 'rmm_me', 'rmm_tc', 'rmm_state', 'rmm_fid'].forEach(lsDel);
    location.reload();
  }

  function gfetch(url, opt, retried) {
    return ensureToken().then(function (t) {
      opt = opt || {};
      opt.headers = Object.assign({ Authorization: 'Bearer ' + t }, opt.headers || {});
      return fetch(url, opt).then(function (r) {
        if (r.status === 401 && !retried) { tok = null; lsDel('rmm_tok'); return gfetch(url, opt, true); }
        if (!r.ok) return r.text().then(function (tx) { throw new Error('API ' + r.status + ': ' + String(tx).substring(0, 180)); });
        return r.status === 204 ? null : r.json().catch(function () { return null; });
      });
    });
  }
  var JSONH = { 'Content-Type': 'application/json' };

  // ---------- Status & tetapan (Drive appDataFolder) ----------
  var STATE = null, FILE_ID = lsGet('rmm_fid'), saveT = null, dirty = false;
  function emptyState() { return { settings: {}, done: [], manual: [], dismissed: [], pinned: [] }; }
  function normState(s) { var e = emptyState(); s = s || {}; Object.keys(e).forEach(function (k) { if (s[k] !== undefined) e[k] = s[k]; }); return e; }

  function findFile() {
    return gfetch(DRIVE + '?spaces=appDataFolder&fields=files(id)&q=' + encodeURIComponent("name='rmm-state.json'"))
      .then(function (r) { return r && r.files && r.files[0] ? r.files[0].id : null; });
  }
  function createFile() {
    var b = 'rmm' + Date.now();
    var body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name: 'rmm-state.json', parents: ['appDataFolder'] }) +
               '\r\n--' + b + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(STATE) + '\r\n--' + b + '--';
    return gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body })
      .then(function (r) { FILE_ID = r.id; lsSet('rmm_fid', FILE_ID); });
  }
  function loadState(force) {
    if (STATE && !force) return Promise.resolve(STATE);
    if (dirty) return Promise.resolve(STATE);
    var local = normState(lsGet('rmm_state'));
    return findFile().then(function (id) {
      if (!id) { STATE = local; return createFile().then(function () { return STATE; }); }
      FILE_ID = id; lsSet('rmm_fid', id);
      return gfetch(DRIVE + '/' + id + '?alt=media').then(function (d) { STATE = normState(d); lsSet('rmm_state', STATE); return STATE; });
    }).catch(function (e) { if (e && e.code === 'AUTH') throw e; STATE = STATE || local; return STATE; });
  }
  function persist() {
    lsSet('rmm_state', STATE); dirty = true; clearTimeout(saveT);
    saveT = setTimeout(function () {
      var p = FILE_ID ? Promise.resolve() : findFile().then(function (id) { if (id) FILE_ID = id; else return createFile(); });
      p.then(function () {
        return gfetch('https://www.googleapis.com/upload/drive/v3/files/' + FILE_ID + '?uploadType=media', { method: 'PATCH', headers: JSONH, body: JSON.stringify(STATE) });
      }).then(function () { dirty = false; }).catch(function () { setTimeout(persist, 15000); });
    }, 400);
  }
  function needState() { return loadState(false); }
  function listOf(k) { return STATE[k] || (STATE[k] = []); }
  function addMany(k, ids) { STATE[k] = listOf(k).filter(function (x) { return ids.indexOf(x) < 0; }).concat(ids).slice(-LIMITS.KEEP_IDS); }
  function removeMany(k, ids) { STATE[k] = listOf(k).filter(function (x) { return ids.indexOf(x) < 0; }); }

  // Lalai + tambahan pengguna - yang pengguna buang
  function getSettings() {
    var saved = (STATE && STATE.settings) || {}, add = saved.add || {}, del = saved.del || {}, out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = DEFAULTS[k]; });
    LIST_KEYS.forEach(function (k) {
      var base = DEFAULTS[k].slice();
      (add[k] || []).forEach(function (x) { if (base.indexOf(x) < 0) base.push(x); });
      var dl = del[k] || [];
      out[k] = base.filter(function (x) { return dl.indexOf(x) < 0; });
    });
    ['refresh', 'days', 'lang', 'theme', 'navPos', 'autoDemote'].forEach(function (k) { if (saved[k] !== undefined) out[k] = saved[k]; });
    return out;
  }
  function saveSettings(s) {
    var list = function (a) { return (a || []).map(function (x) { return String(x).trim().toLowerCase().substring(0, 60); }).filter(Boolean).slice(0, 200); };
    var clamp = function (n, lo, hi, d) { n = parseInt(n, 10); return isNaN(n) ? d : Math.min(hi, Math.max(lo, n)); };
    var add = {}, del = {};
    LIST_KEYS.forEach(function (k) {
      var lst = list(s[k]);
      add[k] = lst.filter(function (x) { return DEFAULTS[k].indexOf(x) < 0; });
      del[k] = DEFAULTS[k].filter(function (x) { return lst.indexOf(x) < 0; });
    });
    STATE.settings = {
      add: add, del: del, refresh: clamp(s.refresh, 30, 600, DEFAULTS.refresh), days: clamp(s.days, 1, 30, DEFAULTS.days),
      lang: s.lang === 'en' ? 'en' : 'ms', theme: ['light', 'dark', 'system'].indexOf(s.theme) > -1 ? s.theme : 'system',
      navPos: s.navPos === 'top' ? 'top' : 'side', autoDemote: s.autoDemote === true || s.autoDemote === 'true'
    };
    persist();
    return getSettings();
  }

  // ---------- util ----------
  function b64(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function padB64(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return s; }
  function addrs(s) { return (s || '').toLowerCase().match(/[\w.+\-]+@[\w\-]+(\.[\w\-]+)+/g) || []; }
  function uniq(arr, exclude) { var seen = {}, out = []; arr.forEach(function (a) { if (a !== exclude && !seen[a]) { seen[a] = 1; out.push(a); } }); return out; }
  function has(hay, words) { return words.some(function (w) { return hay.indexOf(w) > -1; }); }
  function cleanHtml(h) {
    h = String(h || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<meta[^>]+http-equiv=["']?refresh[^>]*>/gi, '');
    return h.length > 500000 ? h.substring(0, 500000) : h;
  }
  function stripHtml(h) {
    return h.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  }
  function hdr(m, n) {
    var hs = (m && m.payload && m.payload.headers) || [];
    for (var i = 0; i < hs.length; i++) if (hs[i].name.toLowerCase() === n) return hs[i].value;
    return '';
  }
  function findPart(p, mime) {
    if (!p) return null;
    if (p.mimeType === mime && p.body && p.body.data) return p;
    var ps = p.parts || [];
    for (var i = 0; i < ps.length; i++) { var r = findPart(ps[i], mime); if (r) return r; }
    return null;
  }
  function bodyText(p) {
    var t = findPart(p, 'text/plain'); if (t) return b64(t.body.data);
    var h = findPart(p, 'text/html'); return h ? stripHtml(b64(h.body.data)) : '';
  }
  function walk(p, fn) { if (!p) return; fn(p); (p.parts || []).forEach(function (c) { walk(c, fn); }); }

  // ---------- Emel ----------
  var TC = lsGet('rmm_tc') || {};

  function parseThread(th, h) {
    var msgs = th.messages || [], first = msgs[0], last = msgs[msgs.length - 1], labels = {};
    msgs.forEach(function (m) { (m.labelIds || []).forEach(function (l) { labels[l] = 1; }); });
    return { id: th.id, h: h || th.historyId, subject: hdr(first, 'subject') || '(tiada subjek)', from: hdr(last, 'from'),
             date: new Date(Number(last.internalDate)).toISOString(), unread: !!labels.UNREAD, starred: !!labels.STARRED, imp: !!labels.IMPORTANT,
             body: bodyText(last.payload).substring(0, 1500) };
  }

  function needsAction(subject, body, from, cfg) {
    var s = subject.toLowerCase(), b = body.toLowerCase(), f = from.toLowerCase();
    if (f.indexOf('calendar-notification') > -1) return false;
    if (has(s + ' ' + b.substring(0, 160), cfg.meetingWords)) return false;
    return has(s + ' ' + b.substring(0, 1500), cfg.actionWords);
  }

  function buildEmail(c, cfg) {
    var done = listOf('done'), manual = listOf('manual'), dismissed = listOf('dismissed'), pinned = listOf('pinned');
    var hay = (c.subject + ' ' + c.from).toLowerCase(), muted = has(c.from.toLowerCase(), cfg.muted), score = 0;
    if (c.imp) score += 3;
    if (c.starred) score += 3;
    if (has(hay, cfg.vip)) score += 3;
    if (has(hay, cfg.keywords)) score += 2;
    if (muted) score = 0;

    var id = c.id, isDone = done.indexOf(id) > -1, isPinned = pinned.indexOf(id) > -1, isDism = dismissed.indexOf(id) > -1;
    var action = false, important = false;
    if (isDone) important = true;
    else {
      action = manual.indexOf(id) > -1 || (!muted && !isPinned && !isDism && needsAction(c.subject, c.body, c.from, cfg));
      if (!action) {
        if (isPinned) important = true;
        else if (isDism) important = false;
        else { important = score >= LIMITS.EMAIL_THRESHOLD; if (important && cfg.autoDemote && !c.unread) important = false; }
      }
    }
    return { id: id, subject: c.subject, from: c.from, date: c.date, unread: c.unread, starred: c.starred,
             preview: c.body.replace(/\s+/g, ' ').substring(0, 220), action: action, done: isDone, important: important };
  }

  function getEmails(cfg) {
    var q = 'in:inbox newer_than:' + cfg.days + 'd';
    return gfetch(GM + '/threads?maxResults=' + LIMITS.MAX_THREADS + '&q=' + encodeURIComponent(q)).then(function (r) {
      var list = (r && r.threads) || [], out = [], i = 0;
      function worker() {
        if (i >= list.length) return Promise.resolve();
        var t = list[i++], c = TC[t.id];
        var p = (c && c.h === t.historyId) ? Promise.resolve(c)
          : gfetch(GM + '/threads/' + t.id + '?format=full').then(function (th) { var c2 = parseThread(th, t.historyId); TC[t.id] = c2; return c2; });
        return p.then(function (cc) { out.push(cc); }, function (e) { if (e && e.code === 'AUTH') throw e; }).then(worker);
      }
      var ws = []; for (var k = 0; k < LIMITS.CONC; k++) ws.push(worker());
      return Promise.all(ws).then(function () {
        var keep = {}; list.forEach(function (t) { if (TC[t.id]) keep[t.id] = TC[t.id]; });
        TC = keep; lsSet('rmm_tc', TC);
        return out.map(function (c) { return buildEmail(c, cfg); }).sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
      });
    });
  }

  // gambar dibenamkan (cid:) -> data URI supaya muncul dalam paparan emel
  function inlineCids(msg, html) {
    if (!/cid:/i.test(html)) return Promise.resolve(html);
    var parts = [];
    walk(msg.payload, function (p) {
      var cid = hdr({ payload: { headers: p.headers || [] } }, 'content-id').replace(/[<>]/g, '');
      if (cid && p.body && (p.body.attachmentId || p.body.data) && parts.length < 12) parts.push({ cid: cid, mime: p.mimeType, body: p.body });
    });
    return Promise.all(parts.map(function (x) {
      var get = x.body.data ? Promise.resolve(x.body.data)
        : gfetch(GM + '/messages/' + msg.id + '/attachments/' + x.body.attachmentId).then(function (a) { return a && a.data; });
      return get.then(function (d) { return d && d.length < 2000000 ? [x.cid, 'data:' + x.mime + ';base64,' + padB64(d)] : null; }, function () { return null; });
    })).then(function (rs) {
      var map = {}; rs.forEach(function (r) { if (r) map[r[0]] = r[1]; });
      return html.replace(/cid:([^"'\s)>]+)/gi, function (m, id) { return map[id] || m; });
    });
  }

  function getEmailDetail(id) {
    return gfetch(GM + '/threads/' + id + '?format=full').then(function (th) {
      var msgs = th.messages || [], last = msgs[msgs.length - 1], me = (lsGet('rmm_me') || '').toLowerCase();
      if (msgs.some(function (m) { return (m.labelIds || []).indexOf('UNREAD') > -1; })) {
        gfetch(GM + '/threads/' + id + '/modify', { method: 'POST', headers: JSONH, body: JSON.stringify({ removeLabelIds: ['UNREAD'] }) }).catch(function () {});
      }
      var from = hdr(last, 'from'), to = hdr(last, 'to'), cc = hdr(last, 'cc');
      var replyTo = addrs(hdr(last, 'reply-to') || from);
      var all = uniq(replyTo.concat(addrs(to)), me);
      var ccl = uniq(addrs(cc), me).filter(function (a) { return all.indexOf(a) < 0; });
      var hp = findPart(last.payload, 'text/html'), html = hp ? cleanHtml(b64(hp.body.data)) : '';
      return inlineCids(last, html).then(function (h2) {
        return { subject: hdr(msgs[0], 'subject'), from: from, to: to, cc: cc, date: new Date(Number(last.internalDate)).toISOString(), count: msgs.length,
                 body: bodyText(last.payload).substring(0, 4000), html: h2, replyTo: replyTo.join(','), replyAllTo: all.join(','), replyAllCc: ccl.join(',') };
      });
    });
  }

  function trashThreads(ids) {
    return Promise.all(ids.map(function (id) { return gfetch(GM + '/threads/' + id + '/trash', { method: 'POST' }); })).then(function () { return ids.length; });
  }

  // ---------- Kalendar ----------
  var ST = { accepted: 'YES', declined: 'NO', tentative: 'MAYBE', needsAction: 'INVITED' };
  function getEvents(cfg) {
    var s = new Date(); s.setHours(0, 0, 0, 0);
    var e = new Date(s.getTime() + (LIMITS.DAYS_AHEAD + 1) * 86400000);
    var url = CAL + '?singleEvents=true&orderBy=startTime&maxResults=100&timeMin=' + encodeURIComponent(s.toISOString()) + '&timeMax=' + encodeURIComponent(e.toISOString());
    return gfetch(url).then(function (r) {
      return ((r && r.items) || []).filter(function (x) { return x.status !== 'cancelled'; }).map(function (x) {
        var allDay = !!(x.start && x.start.date), att = x.attendees || [];
        var self = att.filter(function (a) { return a.self; })[0];
        var status = (!att.length || (x.organizer && x.organizer.self)) ? 'OWNER' : (self ? (ST[self.responseStatus] || 'INVITED') : 'INVITED');
        var title = x.summary || '(tiada tajuk)', guests = att.filter(function (a) { return !a.self; }).length;
        var hay = (title + ' ' + (x.location || '')).toLowerCase(), score = 0;
        if (!allDay) score += 1;
        if (guests > 0) score += 2;
        if (x.location) score += 1;
        if (has(hay, cfg.eventKeywords)) score += 2;
        var org = x.organizer ? (x.organizer.displayName ? x.organizer.displayName + ' <' + (x.organizer.email || '') + '>' : (x.organizer.email || '')) : '';
        var join = x.hangoutLink || ((x.conferenceData && x.conferenceData.entryPoints || []).filter(function (p) { return p.entryPointType === 'video'; })[0] || {}).uri || '';
        return {
          title: title, allDay: allDay,
          start: allDay ? new Date(x.start.date + 'T00:00:00').toISOString() : new Date(x.start.dateTime).toISOString(),
          end: allDay ? new Date(x.end.date + 'T00:00:00').toISOString() : new Date(x.end.dateTime).toISOString(),
          location: x.location || '', descHtml: cleanHtml(x.description || '').substring(0, 8000), join: join,
          guests: guests, creators: org, status: status, important: score >= LIMITS.EVENT_THRESHOLD, link: x.htmlLink || '',
          guestList: att.slice(0, 40).map(function (a) { return { name: a.displayName || '', email: a.email, status: a.organizer ? 'OWNER' : (ST[a.responseStatus] || 'INVITED') }; })
        };
      });
    });
  }

  function getMe() {
    var m = lsGet('rmm_me'); if (m) return Promise.resolve(m);
    return gfetch(GM + '/profile').then(function (p) { lsSet('rmm_me', p.emailAddress); return p.emailAddress; });
  }

  // ---------- API (nama sama seperti fungsi Apps Script) ----------
  var API = {
    getDashboardData: function () {
      return loadState(true).then(function () {
        var cfg = getSettings();
        return Promise.all([getMe(), getEmails(cfg), getEvents(cfg)]).then(function (r) {
          var me = r[0];
          r[2].forEach(function (e) { if (e.link) e.link += (e.link.indexOf('?') > -1 ? '&' : '?') + 'authuser=' + encodeURIComponent(me); });
          return { me: me, settings: cfg, emails: r[1], events: r[2], updated: new Date().toISOString() };
        });
      });
    },
    getEmailDetail: getEmailDetail,
    trashThreads: trashThreads,
    saveSettings: function (s) { return needState().then(function () { return saveSettings(s); }); },
    resetLists: function () { return needState().then(function () { var st = STATE.settings || {}; st.add = {}; st.del = {}; STATE.settings = st; persist(); return getSettings(); }); },
    muteSender: function (from) {
      return needState().then(function () {
        var a = addrs(from)[0]; if (!a) throw new Error('Alamat pengirim tidak dijumpai / Sender address not found');
        var cfg = getSettings(); if (cfg.muted.indexOf(a) < 0) cfg.muted.push(a);
        return saveSettings(cfg);
      });
    },
    markDone: function (id) { return needState().then(function () { addMany('done', [id]); ['manual', 'dismissed', 'pinned'].forEach(function (k) { removeMany(k, [id]); }); persist(); return true; }); },
    setActions: function (ids) { return needState().then(function () { addMany('manual', ids); ['done', 'dismissed', 'pinned'].forEach(function (k) { removeMany(k, ids); }); persist(); return true; }); },
    pinImportant: function (ids) { return needState().then(function () { addMany('pinned', ids); ['dismissed', 'manual', 'done'].forEach(function (k) { removeMany(k, ids); }); persist(); return true; }); },
    dismissThread: function (id) { return needState().then(function () { addMany('dismissed', [id]); removeMany('pinned', [id]); persist(); return true; }); }
  };

  // ---------- RMM.run: serasi dengan google.script.run ----------
  function mk(ok, err) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (f) { return mk(f, err); };
        if (name === 'withFailureHandler') return function (f) { return mk(ok, f); };
        return function () {
          var args = arguments;
          Promise.resolve().then(function () { return API[name].apply(null, args); }).then(function (r) {
            try { if (ok) ok(r); } catch (x) { console.error(x); }
          }, function (e) {
            if (e && e.code === 'AUTH') { if (window.showAuth) window.showAuth(e.message); return; }
            if (err) err(e); else console.error(e);
          });
        };
      }
    });
  }

  // ---------- Pasang sebagai app ----------
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    var b = document.getElementById('inst'); if (b) b.style.display = '';
  });
  window.addEventListener('appinstalled', function () { var b = document.getElementById('inst'); if (b) b.style.display = 'none'; });
  function install() {
    if (!deferred) return;
    deferred.prompt(); deferred = null;
    var b = document.getElementById('inst'); if (b) b.style.display = 'none';
  }

  window.RMM = { run: mk(null, null), signIn: signIn, signOut: signOut, install: install, _api: API };
})();
