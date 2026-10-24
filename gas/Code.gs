/**
 * 王子駅バス地図 データ中継（Google Apps Script）
 *
 * ・ODPT のキーはスクリプトプロパティ「ODPT_KEY」から読む（コードには書かない）
 * ・王子駅周辺の都営バスの乗り場と、そこを通る路線をまとめて JSON で返す
 * ・バス停と路線は変化が少ないので 6 時間キャッシュする
 * ・路線の線は OSRM（OpenStreetMap の道路で経路を計算する無料サービス）で道路に沿わせる。
 *   取れなかった区間はバス停どうしを直線で結ぶ
 * ・経路計算は 1 分ほどかかるので、setupTrigger を一度実行して 5 時間ごとに先に作っておく
 *
 * デプロイ：「ウェブアプリ」／実行ユーザー「自分」／アクセス「全員」
 * 呼び出し：<デプロイURL>             … 乗り場と路線（キャッシュがあればキャッシュを返す）
 *           <デプロイURL>?refresh=1    … キャッシュを使わず取り直す
 *           <デプロイURL>?type=status  … 路線ごとの遅れ・運休の推定（2 分キャッシュ）
 */

var ODPT_BASE = 'https://api.odpt.org/api/v4/';
var OJI = { lat: 35.75282, lng: 139.73784 }; // 王子駅
var STOP_RADIUS = 350;   // この範囲の乗り場をピンにする（m）
var LINE_RADIUS = 4000;  // 路線の線を描く範囲（m、ODPT の上限）
var CACHE_KEY = 'oji_v3';
var OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving/';
var CACHE_SEC = 6 * 60 * 60;

function doGet(e) {
  if (e && e.parameter && e.parameter.type === 'status') {
    var st;
    try { st = status_(); } catch (err) { st = JSON.stringify({ error: String(err && err.message || err) }); }
    return ContentService.createTextOutput(st).setMimeType(ContentService.MimeType.JSON);
  }
  var refresh = e && e.parameter && e.parameter.refresh === '1';
  var json = refresh ? null : cacheGet_(CACHE_KEY);
  if (!json) {
    try {
      json = JSON.stringify(build_());
      cachePut_(CACHE_KEY, json, CACHE_SEC);
    } catch (err) {
      json = JSON.stringify({ error: String(err && err.message || err) });
    }
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/** 王子駅周辺のデータを組み立てる */
function build_() {
  var key = PropertiesService.getScriptProperties().getProperty('ODPT_KEY');
  if (!key) throw new Error('ODPT_KEY が未設定です');

  // 1) 周辺 4km の都営バスの乗り場（線を描くための座標にも使う）
  var area = odpt_('places/odpt:BusstopPole', {
    lat: OJI.lat, lon: OJI.lng, radius: LINE_RADIUS
  }, key).filter(isToei_);
  var poleById = {};
  area.forEach(function (p) { poleById[p['owl:sameAs']] = p; });

  // 2) 王子駅の近くの乗り場と、そこを通る路線パターン
  var near = area.filter(function (p) {
    return dist_(OJI.lat, OJI.lng, p['geo:lat'], p['geo:long']) <= STOP_RADIUS;
  });
  var patternIds = {};
  near.forEach(function (p) {
    (p['odpt:busroutePattern'] || []).forEach(function (id) { patternIds[id] = true; });
  });

  // 3) 路線パターンを並行取得
  var ids = Object.keys(patternIds);
  var reqs = ids.map(function (id) {
    return { url: url_('odpt:BusroutePattern', { 'owl:sameAs': id }, key), muteHttpExceptions: true };
  });
  var patterns = [];
  for (var i = 0; i < reqs.length; i += 30) {
    UrlFetchApp.fetchAll(reqs.slice(i, i + 30)).forEach(function (res) {
      if (res.getResponseCode() !== 200) return;
      var arr = JSON.parse(res.getContentText());
      if (arr && arr[0]) patterns.push(arr[0]);
    });
  }

  // 4) 返すデータを小さくまとめる
  var nearSet = {};
  near.forEach(function (p) { nearSet[p['owl:sameAs']] = true; });
  var alongIdx = {}, along = [];   // 線の途中のバス停（王子駅の乗り場以外）
  var routes = patterns.map(function (pt, ri) {
    var order = (pt['odpt:busstopPoleOrder'] || []).slice().sort(function (a, b) {
      return a['odpt:index'] - b['odpt:index'];
    });
    // 王子駅の乗り場が並びのどこにあるかで、王子駅から出る／王子駅へ来るを決める
    var ojiPos = [];
    order.forEach(function (o, k) {
      var pid = o['odpt:busstopPole'];
      if (nearSet[pid]) { ojiPos.push(k); return; }
      var p = poleById[pid];
      if (!p) return;
      if (alongIdx[pid] == null) {
        alongIdx[pid] = along.length;
        along.push({ name: p['dc:title'] || '', lat: round_(p['geo:lat']), lng: round_(p['geo:long']), routes: [] });
      }
      var a = along[alongIdx[pid]];
      if (a.routes.indexOf(ri) < 0) a.routes.push(ri);
    });
    // 周辺 4km にある乗り場だけで線を作る（範囲外は途切れる）
    var path = [], seg = [];
    order.forEach(function (o) {
      var p = poleById[o['odpt:busstopPole']];
      if (p) { seg.push([round_(p['geo:lat']), round_(p['geo:long'])]); }
      else if (seg.length) { if (seg.length > 1) path.push(seg); seg = []; }
    });
    if (seg.length > 1) path.push(seg);
    var last = order.length ? poleById[order[order.length - 1]['odpt:busstopPole']] : null;
    return {
      id: pt['owl:sameAs'],
      title: pt['dc:title'] || '',
      note: pt['odpt:note'] || '',
      dest: last ? last['dc:title'] : '',
      fromOji: ojiPos.length > 0 && ojiPos[0] < order.length - 1,
      toOji: ojiPos.length > 0 && ojiPos[ojiPos.length - 1] > 0,
      path: path
    };
  });

  // 5) 線を道路に沿わせる（同じ並びの区間は 1 回だけ計算する）
  var roadCache = {};
  routes.forEach(function (r) {
    r.path = r.path.map(function (seg) {
      var k = JSON.stringify(seg);
      if (!roadCache[k]) roadCache[k] = roadPath_(seg) || seg;
      return roadCache[k];
    });
  });

  var stops = near.map(function (p) {
    return {
      id: p['owl:sameAs'],
      name: p['dc:title'] || '',
      num: p['odpt:busstopPoleNumber'] || '',
      lat: round_(p['geo:lat']),
      lng: round_(p['geo:long']),
      routes: (p['odpt:busroutePattern'] || []).filter(function (id) { return patternIds[id]; })
    };
  });

  // along[].routes は routes の並び番号
  return { updated: new Date().toISOString(), center: OJI, stops: stops, routes: routes, along: along };
}

/**
 * バス停の並び [[lat,lng],...] を OSRM で道路に沿った線にする。失敗したら null。
 * OSRM の公開サーバーは 1 秒に 1 回までなので、呼ぶたびに 1 秒待つ。
 */
function roadPath_(seg) {
  var coords = seg.map(function (c) { return c[1] + ',' + c[0]; }).join(';');
  var url = OSRM_BASE + coords + '?overview=full&geometries=geojson&continue_straight=true';
  Utilities.sleep(1000);
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    var d = JSON.parse(res.getContentText());
    if (d.code !== 'Ok' || !d.routes || !d.routes[0]) return null;
    return d.routes[0].geometry.coordinates.map(function (c) {
      return [Math.round(c[1] * 1e5) / 1e5, Math.round(c[0] * 1e5) / 1e5];
    });
  } catch (err) {
    return null;
  }
}

function isToei_(p) {
  return String(p['owl:sameAs'] || '').indexOf('odpt.BusstopPole:Toei.') === 0;
}

function url_(path, params, key) {
  var q = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  });
  q.push('acl:consumerKey=' + encodeURIComponent(key));
  return ODPT_BASE + path + '?' + q.join('&');
}

function odpt_(path, params, key) {
  var res = UrlFetchApp.fetch(url_(path, params, key), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('ODPT ' + path + ' : HTTP ' + res.getResponseCode());
  }
  return JSON.parse(res.getContentText());
}

function dist_(lat1, lng1, lat2, lng2) {
  var r = Math.PI / 180, R = 6371000;
  var dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

function round_(v) { return Math.round(v * 1e6) / 1e6; }

/* CacheService は 1 件 100KB までなので分割して保存する */
function cachePut_(key, str, sec) {
  var cache = CacheService.getScriptCache();
  var size = 90000, parts = {}, n = Math.ceil(str.length / size);
  for (var i = 0; i < n; i++) parts[key + '_' + i] = str.substr(i * size, size);
  parts[key + '_n'] = String(n);
  cache.putAll(parts, sec);
}

function cacheGet_(key) {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get(key + '_n'));
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '_' + i);
  var got = cache.getAll(keys), out = '';
  for (var j = 0; j < n; j++) {
    if (got[keys[j]] == null) return null;
    out += got[keys[j]];
  }
  return out;
}

/** キャッシュを作り直す（時間で動くトリガーから呼ぶ） */
function refreshCache() {
  var d = build_();
  cachePut_(CACHE_KEY, JSON.stringify(d), CACHE_SEC);
  timetables_(d.routes.map(function (r) { return r.id; }), true);
}

/** 一度だけ実行：5 時間ごとに refreshCache を動かすトリガーを作り、今すぐキャッシュも作る */
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshCache') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshCache').timeBased().everyHours(5).create();
  refreshCache();
}

/** エディタから実行して動作確認する用（ログに件数が出る） */
function testBuild() {
  var d = build_();
  var pts = d.routes.reduce(function (n, r) {
    return n + r.path.reduce(function (m, seg) { return m + seg.length; }, 0);
  }, 0);
  Logger.log('乗り場 ' + d.stops.length + ' 件 / 路線 ' + d.routes.length + ' 件 / 線の点 ' + pts + ' 個 / ' +
             Math.round(JSON.stringify(d).length / 1024) + 'KB');
}

/* ===================== 遅れ・運休の推定 ===================== */

var STATUS_KEY = 'oji_status_v1';
var STATUS_SEC = 120;          // 走行データのキャッシュ（秒）
var MIN_FEED_BUSES = 50;       // 都営バス全体でこれ未満なら走行データ自体が不調とみなす

/** 路線パターンごとの遅れ（分）と運休の推定を JSON 文字列で返す */
function status_() {
  var cached = CacheService.getScriptCache().get(STATUS_KEY);
  if (cached) return cached;

  var key = PropertiesService.getScriptProperties().getProperty('ODPT_KEY');
  var main = cacheGet_(CACHE_KEY);
  if (!main) { refreshCache(); main = cacheGet_(CACHE_KEY); }
  var ids = JSON.parse(main).routes.map(function (r) { return r.id; });
  var tt = timetables_(ids, false);

  var buses = odpt_('odpt:Bus', { 'odpt:operator': 'odpt.Operator:Toei' }, key);
  var feedOk = buses.length >= MIN_FEED_BUSES;
  var now = jstMin_(new Date());

  var out = {};
  ids.forEach(function (id) {
    var p = tt[id] || { poles: [], trips: {} };
    // 時刻表上いま走っているはずの便の数
    var expected = 0;
    Object.keys(p.trips).forEach(function (tid) {
      var t = p.trips[tid].filter(function (v) { return v >= 0; });
      if (t.length && t[0] <= now && now <= t[t.length - 1]) expected++;
    });
    out[id] = { delay: null, buses: 0, checked: 0, expected: expected, suspended: false };
  });

  buses.forEach(function (b) {
    var id = b['odpt:busroutePattern'];
    if (!out[id] || !tt[id]) return;
    out[id].buses++;
    var d = busDelay_(b, tt[id], now);
    if (d != null) out[id].checked++;
    if (d != null && (out[id].delay == null || d > out[id].delay)) out[id].delay = d;
  });

  ids.forEach(function (id) {
    var o = out[id];
    // 走っているはずの便が 2 本以上あるのに 1 台も見えない → 運休の可能性（推測）
    o.suspended = feedOk && o.expected >= 2 && o.buses === 0;
  });

  var json = JSON.stringify({ updated: new Date().toISOString(), feedOk: feedOk, patterns: out });
  CacheService.getScriptCache().put(STATUS_KEY, json, STATUS_SEC);
  return json;
}

/** 1 台のバスの遅れ（分）。比べられないときは null */
function busDelay_(b, p, now) {
  var pole = b['odpt:fromBusstopPole'], at = b['odpt:fromBusstopPoleTime'];
  if (!pole || !at) return null;
  var act = jstMin_(new Date(at));
  if (now - act > 60) return null;           // 古すぎる記録は使わない
  var idxs = [];
  p.poles.forEach(function (pid, i) { if (pid === pole) idxs.push(i); });
  if (!idxs.length) return null;

  var best = null;
  var tid = shortTt_(b['odpt:busTimetable']);
  if (tid && p.trips[tid]) {
    // 便が分かるときはその便の時刻と比べる
    idxs.forEach(function (i) {
      var s = p.trips[tid][i];
      if (s >= 0 && (best == null || Math.abs(act - s) < Math.abs(best))) best = act - s;
    });
  } else {
    // 便が分からないときは、その乗り場をいちばん近い過去に出るはずだった便と比べる
    Object.keys(p.trips).forEach(function (k) {
      idxs.forEach(function (i) {
        var s = p.trips[k][i];
        if (s < 0) return;
        var d = act - s;
        if (d >= -3 && (best == null || d < best)) best = d;
      });
    });
  }
  if (best == null || best > 90) return null;
  return Math.max(0, Math.round(best));
}

/**
 * 今日の時刻表を路線パターンごとにまとめる。{ id: { poles:[乗り場ID], trips:{ 便ID:[分,...] } } }
 * 分は 0 時からの分。深夜 3 時までは前日の続きとして 24 時以降の数にする。
 */
function timetables_(ids, force) {
  var day = serviceDay_();
  var ckey = 'oji_tt_' + day.key;
  if (!force) {
    var c = cacheGet_(ckey);
    if (c) return JSON.parse(c);
  }
  var key = PropertiesService.getScriptProperties().getProperty('ODPT_KEY');
  var out = {};
  var reqs = ids.map(function (id) {
    return { url: url_('odpt:BusTimetable', { 'odpt:busroutePattern': id }, key), muteHttpExceptions: true };
  });
  for (var i = 0; i < reqs.length; i += 10) {
    var res = UrlFetchApp.fetchAll(reqs.slice(i, i + 10));
    res.forEach(function (r, j) {
      var id = ids[i + j];
      out[id] = { poles: [], trips: {} };
      if (r.getResponseCode() !== 200) return;
      JSON.parse(r.getContentText()).forEach(function (t) {
        if (day.calendars.indexOf(t['odpt:calendar']) < 0) return;
        var objs = (t['odpt:busTimetableObject'] || []).slice().sort(function (a, b) {
          return a['odpt:index'] - b['odpt:index'];
        });
        var times = [], prev = -1;
        objs.forEach(function (o, k) {
          if (!out[id].poles[k]) out[id].poles[k] = o['odpt:busstopPole'];
          var hm = o['odpt:departureTime'] || o['odpt:arrivalTime'];
          var m = hm ? hmMin_(hm) : -1;
          if (m >= 0 && prev >= 0 && m < prev - 600) m += 1440;  // 日付をまたぐ便
          if (m >= 0) prev = m;
          times.push(m);
        });
        if (times.length && times[0] >= 0 && times[0] < 180) {
          times = times.map(function (v) { return v >= 0 ? v + 1440 : v; });
        }
        out[id].trips[shortTt_(t['owl:sameAs'])] = times;
      });
    });
  }
  cachePut_(ckey, JSON.stringify(out), CACHE_SEC);
  return out;
}

/** 運行日（深夜 3 時まで前日扱い）と、その日に使う時刻表の種類 */
function serviceDay_() {
  var d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  var ymd = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
  var dow = Number(Utilities.formatDate(d, 'Asia/Tokyo', 'u')); // 1=月 … 7=日
  var holiday = dow === 7 || isHoliday_(ymd);
  var cals = holiday ? ['odpt.Calendar:Holiday', 'odpt.Calendar:SaturdayHoliday', 'odpt.Calendar:Sunday']
           : dow === 6 ? ['odpt.Calendar:Saturday', 'odpt.Calendar:SaturdayHoliday']
           : ['odpt.Calendar:Weekday'];
  return { key: ymd, calendars: cals };
}

function isHoliday_(ymd) {
  try {
    var cal = CalendarApp.getCalendarById('ja.japanese#holiday@group.v.calendar.google.com');
    var p = ymd.split('-');
    return cal.getEventsForDay(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))).length > 0;
  } catch (err) {
    return false;
  }
}

function hmMin_(hm) {
  var p = String(hm).split(':');
  return Number(p[0]) * 60 + Number(p[1]);
}

/** 日本時間の 0 時からの分（深夜 3 時までは 24 時以降の数） */
function jstMin_(date) {
  var m = hmMin_(Utilities.formatDate(date, 'Asia/Tokyo', 'HH:mm'));
  return m < 180 ? m + 1440 : m;
}

function shortTt_(id) {
  return id ? String(id).replace('odpt.BusTimetable:', '') : '';
}

/** エディタから実行して動作確認する用：遅れ・運休の推定をログに出す */
function testStatus() {
  CacheService.getScriptCache().remove(STATUS_KEY);
  var d = JSON.parse(status_());
  var ps = d.patterns, ids = Object.keys(ps);
  var running = ids.filter(function (id) { return ps[id].buses > 0; }).length;
  var sum = function (k) { return ids.reduce(function (n, id) { return n + (ps[id][k] || 0); }, 0); };
  Logger.log('走行データ ' + (d.feedOk ? '正常' : '不調') + ' / 路線 ' + ids.length + ' 件中 ' + running + ' 件でバスを確認');
  Logger.log('対象路線のバス ' + sum('buses') + ' 台のうち、時刻表と比べられたのは ' + sum('checked') + ' 台 / 時刻表上いま走っているはずの便 ' + sum('expected') + ' 便');
  ids.forEach(function (id) {
    var o = ps[id];
    if (o.buses || o.suspended) {
      Logger.log(id.replace('odpt.BusroutePattern:Toei.', '') + '：走行 ' + o.buses + ' 台 / 比較 ' + o.checked + ' 台 / 遅れ ' +
                 (o.delay == null ? '-' : o.delay + ' 分') + ' / 予定 ' + o.expected + ' 便' + (o.suspended ? ' / 運休の可能性' : ''));
    }
  });
}

/** エディタから実行して動作確認する用：時刻表の種類と、バスの位置データの中身をログに出す */
function testTimetable() {
  var key = PropertiesService.getScriptProperties().getProperty('ODPT_KEY');
  var day = serviceDay_();
  Logger.log('運行日 ' + day.key + ' / 使う時刻表の種類 ' + day.calendars.join(', '));
  var ids = JSON.parse(cacheGet_(CACHE_KEY) || JSON.stringify(build_())).routes.map(function (r) { return r.id; });
  var raw = odpt_('odpt:BusTimetable', { 'odpt:busroutePattern': ids[0] }, key);
  var cals = {};
  raw.forEach(function (t) { cals[t['odpt:calendar']] = (cals[t['odpt:calendar']] || 0) + 1; });
  Logger.log(ids[0] + ' の時刻表 ' + raw.length + ' 便 / 種類 ' + JSON.stringify(cals));
  var tt = timetables_(ids, false);
  var trips = ids.reduce(function (n, id) { return n + Object.keys((tt[id] || { trips: {} }).trips).length; }, 0);
  Logger.log('今日の時刻表として読めた便 ' + trips + ' 便（' + ids.length + ' 路線）');
  var buses = odpt_('odpt:Bus', { 'odpt:operator': 'odpt.Operator:Toei' }, key);
  var mine = buses.filter(function (b) { return ids.indexOf(b['odpt:busroutePattern']) >= 0; });
  Logger.log('都営バス全体 ' + buses.length + ' 台 / 対象路線 ' + mine.length + ' 台');
  if (mine[0]) {
    var b = mine[0];
    Logger.log('例：' + JSON.stringify({
      pattern: b['odpt:busroutePattern'], timetable: b['odpt:busTimetable'] || null,
      from: b['odpt:fromBusstopPole'] || null, fromTime: b['odpt:fromBusstopPoleTime'] || null, to: b['odpt:toBusstopPole'] || null
    }));
  }
}
