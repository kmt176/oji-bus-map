/**
 * 王子駅バス地図 データ中継（Google Apps Script）
 *
 * ・ODPT のキーはスクリプトプロパティ「ODPT_KEY」から読む（コードには書かない）
 * ・王子駅周辺の都営バスの乗り場と、そこを通る路線をまとめて JSON で返す
 * ・バス停と路線は変化が少ないので 6 時間キャッシュする
 *
 * デプロイ：「ウェブアプリ」／実行ユーザー「自分」／アクセス「全員」
 * 呼び出し：<デプロイURL>          … キャッシュがあればキャッシュを返す
 *           <デプロイURL>?refresh=1 … キャッシュを使わず取り直す
 */

var ODPT_BASE = 'https://api.odpt.org/api/v4/';
var OJI = { lat: 35.75282, lng: 139.73784 }; // 王子駅
var STOP_RADIUS = 350;   // この範囲の乗り場をピンにする（m）
var LINE_RADIUS = 4000;  // 路線の線を描く範囲（m、ODPT の上限）
var CACHE_KEY = 'oji_v1';
var CACHE_SEC = 6 * 60 * 60;

function doGet(e) {
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
  var routes = patterns.map(function (pt) {
    var order = (pt['odpt:busstopPoleOrder'] || []).slice().sort(function (a, b) {
      return a['odpt:index'] - b['odpt:index'];
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
      path: path
    };
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

  return { updated: new Date().toISOString(), center: OJI, stops: stops, routes: routes };
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

/** エディタから実行して動作確認する用（ログに件数が出る） */
function testBuild() {
  var d = build_();
  Logger.log('乗り場 ' + d.stops.length + ' 件 / 路線 ' + d.routes.length + ' 件');
}
