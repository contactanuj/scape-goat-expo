/*
 * make-icon.js — renders assets/icon.png (1024x1024) with zero dependencies.
 *
 * A clean gold billy-goat head emblem inside a thin gold ring, on the app's deep
 * slate brand background. Drawn with signed-distance shapes for crisp antialiasing,
 * then encoded as a PNG via Node's built-in zlib. Run: node make-icon.js
 */
'use strict';
var fs = require('fs');
var zlib = require('zlib');
var path = require('path');

var W = 1024, H = 1024;
var CX = 512;

// palette
var SLATE = [12, 15, 20];
var SLATE_LT = [22, 28, 38];
var GOLD = [217, 164, 65];
var GOLD_LT = [233, 188, 96];

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }
function dist(x, y, ax, ay) { return Math.hypot(x - ax, y - ay); }

// distance to a segment (for capsule shapes)
function sdSeg(px, py, ax, ay, bx, by) {
  var pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  var denom = bax * bax + bay * bay;
  var h = denom > 0 ? clamp((pax * bax + pay * bay) / denom, 0, 1) : 0; // a==b -> distance to the point
  return Math.hypot(pax - bax * h, pay - bay * h);
}
function mir(x) { return 1024 - x; } // mirror across CX=512

// capsule list [ax,ay,bx,by,thick]; goat head built as a union of capsules + circles.
var caps = [];
function cap(ax, ay, bx, by, t) { caps.push([ax, ay, bx, by, t]); }
function circ(cx, cy, r) { caps.push([cx, cy, cx, cy, r]); }

// ---- face (round forehead, broad cheeks, tapering to a chin) ----
circ(512, 488, 142);
circ(512, 550, 118);
cap(512, 596, 512, 672, 82);
cap(512, 650, 512, 706, 48);
// ---- ears (slim, drooping downward, tucked under the horns) ----
cap(450, 492, 398, 582, 25); cap(398, 582, 380, 628, 13);
cap(mir(450), 492, mir(398), 582, 25); cap(mir(398), 582, mir(380), 628, 13);
// ---- horns (bold, thick at the base, sweeping up and OUT then curling) ----
cap(460, 410, 432, 350, 46); cap(432, 350, 392, 312, 37); cap(392, 312, 366, 256, 26); cap(366, 256, 378, 212, 15);
cap(mir(460), 410, mir(432), 350, 46); cap(mir(432), 350, mir(392), 312, 37); cap(mir(392), 312, mir(366), 256, 26); cap(mir(366), 256, mir(378), 212, 15);
// ---- beard (chunky pointed tuft) ----
cap(512, 686, 512, 738, 38); cap(512, 728, 512, 770, 22);

function goatSDF(x, y) {
  var d = 1e9;
  for (var i = 0; i < caps.length; i++) {
    var c = caps[i];
    d = Math.min(d, sdSeg(x, y, c[0], c[1], c[2], c[3]) - c[4]);
  }
  return d;
}

// eyes + nostrils (slate cut-outs on the gold face)
function ellipseVal(x, y, cx, cy, rx, ry) { var dx = (x - cx) / rx, dy = (y - cy) / ry; return Math.sqrt(dx * dx + dy * dy); }

var buf = Buffer.alloc(W * H * 4);
for (var y = 0; y < H; y++) {
  for (var x = 0; x < W; x++) {
    var px = x + 0.5, py = y + 0.5;

    // background: subtle radial slate
    var rc = dist(px, py, 512, 512) / 720;
    var col = mix(SLATE_LT, SLATE, clamp(rc, 0, 1));

    // thin gold ring (badge)
    var rd = dist(px, py, 512, 512);
    var ring = Math.max(rd - 470, 442 - rd); // annulus 442..470
    var ringCov = clamp(0.5 - ring / 1.6, 0, 1);
    if (ringCov > 0) col = mix(col, GOLD, ringCov * 0.9);

    // goat body (gold), with a soft top-light vertical gradient
    var gd = goatSDF(px, py);
    var goatCov = clamp(0.5 - gd / 1.6, 0, 1);
    if (goatCov > 0) {
      var shade = clamp((py - 230) / 540, 0, 1);
      var goatCol = mix(GOLD_LT, GOLD, shade);
      col = mix(col, goatCol, goatCov);
    }

    // eyes + nostrils cut back to slate, but only where on the gold face
    if (gd < -2) {
      var eL = ellipseVal(px, py, 474, 500, 30, 21);
      var eR = ellipseVal(px, py, mir(474), 500, 30, 21);
      var eye = Math.min(eL, eR);
      var eyeCov = clamp((1 - eye) / 0.05, 0, 1);
      var nL = dist(px, py, 502, 652) - 9, nR = dist(px, py, mir(502), 652) - 9;
      var nose = Math.min(nL, nR);
      var noseCov = clamp(0.5 - nose / 1.6, 0, 1);
      var cut = Math.max(eyeCov, noseCov);
      if (cut > 0) col = mix(col, [16, 19, 26], cut);
    }

    var o = (y * W + x) * 4;
    buf[o] = Math.round(clamp(col[0], 0, 255));
    buf[o + 1] = Math.round(clamp(col[1], 0, 255));
    buf[o + 2] = Math.round(clamp(col[2], 0, 255));
    buf[o + 3] = 255;
  }
}

// ---- encode PNG (RGBA, no external deps) ----
function crc32(buf) {
  var c, table = crc32.t || (crc32.t = (function () {
    var t = [];
    for (var n = 0; n < 256; n++) { c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })());
  c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  var t = Buffer.from(type, 'ascii');
  var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
var ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
// raw scanlines with filter byte 0
var raw = Buffer.alloc(H * (1 + W * 4));
for (var yy = 0; yy < H; yy++) {
  raw[yy * (1 + W * 4)] = 0;
  buf.copy(raw, yy * (1 + W * 4) + 1, yy * W * 4, (yy + 1) * W * 4);
}
var idat = zlib.deflateSync(raw, { level: 9 });
var png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
]);
fs.writeFileSync(path.join(__dirname, 'assets', 'icon.png'), png);
console.log('Wrote assets/icon.png (' + png.length + ' bytes, ' + W + 'x' + H + ').');
