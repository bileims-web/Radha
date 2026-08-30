/* Radha — offline service worker.
 *
 * Two versions, deliberately separate. The shell is a few hundred kilobytes
 * and is re-fetched often; the audio cache can hold half a gigabyte that took
 * a long time to download. Tying them together would mean every icon or
 * index.html change threw away every cached track.
 *
 *   SHELL_VERSION — bump when index.html, manifest.json, a font or an icon
 *                   changes. Cheap: a few hundred KB is re-fetched.
 *   AUDIO_VERSION — bump ONLY when an mp3 under audio/ is replaced. Expensive:
 *                   every track has to be downloaded again.
 */
var SHELL_VERSION = 'v12';  // v12: peacock feather removed
var AUDIO_VERSION = 'v1';
var SHELL_CACHE = 'radha-shell-' + SHELL_VERSION;
var AUDIO_CACHE = 'radha-audio-' + AUDIO_VERSION;

/* Everything the app needs to start with no network. Deliberately excludes
   audio/: half a gigabyte cannot be precached on install without blocking
   the worker and blowing the storage quota. Audio is filled in on demand,
   see below. */
var SHELL = [
  './',
  'index.html',
  'manifest.json',
  'app.webmanifest',
  'fonts/noto-serif-devanagari.css',
  'fonts/noto-serif-devanagari-devanagari.woff2',
  'fonts/noto-serif-devanagari-latin.woff2',
  'fonts/noto-serif-devanagari-latin-ext.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) {
      // addAll is all-or-nothing; add one at a time so a single missing file
      // cannot leave the app with no offline shell at all.
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL_CACHE && k !== AUDIO_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* ---------- audio ----------
 * The player seeks: it resumes from a saved position and has ±30s buttons,
 * so it issues Range requests. The Cache API cannot store a 206, so a whole
 * file is cached as one 200 and the ranges are cut out of it here.
 *
 * A track that is not cached yet goes straight to the network, exactly as it
 * did before this worker existed — playback must never wait on us. The full
 * file is fetched separately, one at a time, and stored for next time.
 */
var fillQueue = [];
var filling = false;
var outOfSpace = false;

function queueFill(url) {
  if (outOfSpace || fillQueue.indexOf(url) !== -1) return;
  fillQueue.push(url);
  runQueue();
}

function runQueue() {
  if (filling || outOfSpace || !fillQueue.length) return;
  filling = true;
  var url = fillQueue.shift();
  caches.open(AUDIO_CACHE).then(function (cache) {
    return cache.match(url).then(function (hit) {
      if (hit) return;
      // No Range header, so this is the whole file. It may come from the
      // browser's own HTTP cache, in which case it costs no extra data.
      return fetch(url).then(function (resp) {
        if (resp && resp.ok && resp.status === 200) return cache.put(url, resp);
      });
    });
  }).catch(function (err) {
    if (err && (err.name === 'QuotaExceededError' || err.code === 22)) outOfSpace = true;
  }).then(function () {
    filling = false;
    if (fillQueue.length) runQueue();
  });
}

function sliceRange(full, rangeHeader) {
  return full.blob().then(function (blob) {
    var size = blob.size;
    var m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (!m) return full;
    var start, end;
    if (m[1] === '') {                       // bytes=-500, the last 500 bytes
      var n = parseInt(m[2], 10);
      if (isNaN(n)) return full;
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
    }
    if (isNaN(start) || start > end || start >= size) {
      return new Response(null, {
        status: 416,
        statusText: 'Range Not Satisfiable',
        headers: { 'Content-Range': 'bytes */' + size }
      });
    }
    return new Response(blob.slice(start, end + 1), {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': full.headers.get('Content-Type') || 'audio/mpeg',
        'Content-Length': String(end - start + 1),
        'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
        'Accept-Ranges': 'bytes'
      }
    });
  });
}

function handleAudio(request) {
  return caches.open(AUDIO_CACHE).then(function (cache) {
    return cache.match(request.url).then(function (hit) {
      var range = request.headers.get('range');
      if (hit) return range ? sliceRange(hit, range) : hit;
      queueFill(request.url);          // fill for next time, in the background
      return fetch(request);           // this time, behave as if we were not here
    });
  }).catch(function () { return fetch(request); });
}

/* ---------- everything else ---------- */

// index.html and manifest.json: fresh when online (the app asks for
// manifest.json with cache:"no-cache" on purpose), cached copy when not.
function networkFirst(request) {
  return fetch(request).then(function (resp) {
    if (resp && resp.ok) {
      var copy = resp.clone();
      caches.open(SHELL_CACHE).then(function (c) { c.put(request, copy); }).catch(function () {});
    }
    return resp;
  }).catch(function () {
    return caches.match(request, { ignoreSearch: true }).then(function (hit) {
      return hit || caches.match('index.html');
    });
  });
}

// Fonts and icons never change under a given name: cache first.
function cacheFirst(request) {
  return caches.match(request).then(function (hit) {
    if (hit) return hit;
    return fetch(request).then(function (resp) {
      if (resp && resp.ok) {
        var copy = resp.clone();
        caches.open(SHELL_CACHE).then(function (c) { c.put(request, copy); }).catch(function () {});
      }
      return resp;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;   // never touch other hosts

  var path = url.pathname;

  if (/\/audio\//.test(path)) { e.respondWith(handleAudio(req)); return; }

  if (req.mode === 'navigate' || /\/$|index\.html$|manifest\.json$/.test(path)) {
    e.respondWith(networkFirst(req));
    return;
  }

  if (/\/(fonts|icons)\/|\.woff2$|\.png$|app\.webmanifest$/.test(path)) {
    e.respondWith(cacheFirst(req));
    return;
  }
});
