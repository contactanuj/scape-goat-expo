/*
 * ui.smoke.test.js — headless smoke + anti-leak test for ui.js.
 *
 * Stubs a minimal DOM, loads the real deck + engine + UI, and drives complete
 * games through the actual UI action handlers (not the engine directly). This
 * catches UI<->engine wiring bugs (action names, gating, the trade/frame handoffs,
 * the evidence-swap restriction) AND enforces the hidden-info contract: the shared
 * board never shows anyone's secret intel, and the scapegoat's reveal screen is
 * indistinguishable from a conspirator's (the wink-killer class of bug).
 *
 * Run: node tests/ui.smoke.test.js
 */
'use strict';

// ---- minimal DOM / browser stubs (before requiring the modules) ------------
var appEl = { innerHTML: '', scrollTop: 0, addEventListener: function () {} };
var store = {};
global.window = { addEventListener: function () {}, scrollTo: function () {} };
global.document = {
  getElementById: function () { return appEl; },
  addEventListener: function () {},
  readyState: 'complete'
};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; }
};
global.confirm = function () { return true; };

var SGDeck = require('../assets/sg-deck.js');
var SG = require('../assets/sg-engine.js');
var SGBot = require('../assets/sg-bot.js');
global.window.SG = SG; global.window.SGDeck = SGDeck; global.window.SGBot = SGBot;
var UI = require('../assets/ui.js');
UI.setAuto(false); // drive bot steps synchronously in tests (no timers)

var pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL: ' + msg); } }
function rint(n) { return Math.floor(Math.random() * n); }
function pick(a) { return a[rint(a.length)]; }
function html() { return UI.lastHtml(); }
function expectRendered(label) { ok(typeof html() === 'string' && html().length > 0, label + ': produced HTML'); }
function S() { return UI.state(); }

// ---------------------------------------------------------------------------
console.log('# headless UI smoke + anti-leak test');

// static screens render without a game
UI.setView('home'); UI.render(); expectRendered('home');
UI.setView('rules'); UI.render(); expectRendered('rules');
UI.setView('setup'); UI.setDraft(SG.defaultConfig(5)); UI.render(); expectRendered('setup');
UI.setView('home'); UI.render();

// ---------------------------------------------------------------------------
// SETUP CONFIG INTELLIGENCE: advanced panel renders for every count; the controls
// respect the player count (hand size can't drop below feasible); the start button is
// disabled (and relabelled) while invalid rather than letting the player proceed.
(function setupConfig() {
  [3, 4, 5, 6, 7, 8].forEach(function (pc) {
    UI.setView('setup'); UI.setDraft(SG.defaultConfig(pc)); UI.state().ui.advanced = true; UI.render();
    expectRendered(pc + 'p advanced setup');
  });
  // 8p with a too-small hand is clamped up to a feasible minimum by the advanced view.
  UI.setView('setup'); var d = SG.defaultConfig(8); d.handSize = 2; UI.setDraft(d); UI.state().ui.advanced = true; UI.render();
  ok(UI.state().draft.handSize >= 3, '8p advanced config clamps hand size up to a feasible minimum');
  ok(SG.validateConfig(UI.state().draft).ok, '8p clamped config is valid');
  // Invalid config disables + relabels the start button (no proceeding).
  UI.setView('setup'); var bad = SG.defaultConfig(5); bad.playerNames[0] = ''; UI.setDraft(bad); UI.state().ui.advanced = false; UI.render();
  ok(/data-action="startGame" disabled/.test(html()) && /Fix the issue/.test(html()), 'invalid config disables & relabels the start button');
  UI.setView('setup'); UI.setDraft(SG.defaultConfig(5)); UI.render();
  ok(/Deal the evidence/.test(html()) && !/Fix the issue/.test(html()), 'valid config shows the start button');
  UI.setView('home'); UI.render();
})();

// ---------------------------------------------------------------------------
// ANTI-LEAK: the scapegoat's reveal must be indistinguishable from a conspirator's,
// and the shared board must never show anyone's secret intel.
(function antiLeak() {
  UI.setDraft(SG.defaultConfig(6));
  UI.handle('startGame');
  var G = S().G;
  var sgId = G.scapegoatId;
  var conspId = G.players.filter(function (p) { return p.id !== sgId; })[0].id;

  UI.handle('revealStart');
  var scapeHtml = null, conspHtml = null;
  for (var i = 0; i < G.players.length; i++) {
    var pid = S().G.players[S().ui.revealIdx].id;
    UI.handle('revealShow');
    if (pid === sgId) scapeHtml = html();
    else if (pid === conspId) conspHtml = html();
    UI.handle('revealNext');
  }
  ok(scapeHtml && conspHtml, 'captured both the scapegoat and a conspirator intel screen');
  ok(/intelcard/.test(scapeHtml) && /intelcard/.test(conspHtml), 'both intel screens use the same card markup');
  ok(/believe the scapegoat is/i.test(scapeHtml) && /believe the scapegoat is/i.test(conspHtml), 'both intel screens are phrased identically');
  ok(!/you are the scapegoat/i.test(scapeHtml) && !/you are the patsy/i.test(scapeHtml), 'the scapegoat screen never announces the role');
  // Structural parity: the intel-card block (the role-reveal part) matches ONE identical
  // pattern for both — only the name/colour data differs. A role tell would break the match.
  var INTEL_BLOCK = /<div class="intelcard"><div class="muted">[^<]*<span class="swatch sw-\w+"><\/span><\/div><div class="small muted"[^>]*>You believe the scapegoat is<\/div><div class="big">[^<]*<span class="swatch sw-\w+"><\/span><\/div><\/div>/;
  ok(INTEL_BLOCK.test(scapeHtml), 'scapegoat intel card matches the common template');
  ok(INTEL_BLOCK.test(conspHtml), 'conspirator intel card matches the SAME common template (no role tell)');

  UI.handle('beginPlay');
  var board = html();
  ok(!/believe the scapegoat is/i.test(board), 'shared board does NOT show anyone\'s secret intel');
  ok(board.indexOf('intelcard') === -1, 'shared board renders no intel card');
  ok(!/sw-undefined|sw-null/.test(board), 'board colour swatches all resolve');

  // The gated peek DOES reveal the intel, then hides it again.
  UI.handle('peekShow');
  ok(/believe the scapegoat is/i.test(html()), 'the private peek reveals the player\'s own intel');
  UI.handle('peekHide');
  ok(!/believe the scapegoat is/i.test(html()), 'hiding the peek removes the secret again');
})();

// ---------------------------------------------------------------------------
// TIMED REVEAL + RECHECK: the secret shows a countdown, auto-hides to a neutral cover
// that leaks nothing, and "Show again" re-reveals. The cover is identical for the
// scapegoat and a conspirator (no role tell, even while hidden).
(function timedReveal() {
  UI.setDraft(SG.defaultConfig(5)); UI.handle('startGame');
  var G = S().G, sgId = G.scapegoatId;
  var conspId = G.players.filter(function (p) { return p.id !== sgId; })[0].id;
  UI.handle('revealStart');
  function advanceTo(pid) { while (S().ui.revealIdx < G.players.length && S().G.players[S().ui.revealIdx].id !== pid) { UI.handle('revealShow'); UI.handle('revealNext'); } }
  advanceTo(sgId);
  UI.handle('revealShow');
  ok(/believe the scapegoat is/.test(html()), 'reveal shows the secret');
  ok(/Auto-hides in/.test(html()), 'reveal shows the auto-hide countdown');
  // simulate the auto-hide timer elapsing
  S().ui.hidden = true; UI.render();
  var scapeCover = html();
  ok(!/believe the scapegoat is/.test(scapeCover), 'auto-hidden cover does not leak the secret');
  ok(/Hidden for privacy/.test(scapeCover) && /Show again/.test(scapeCover), 'auto-hidden shows a privacy cover + Show again');
  UI.handle('revealAgain');
  ok(/believe the scapegoat is/.test(html()), 'Show again re-reveals the secret');
  // a conspirator's cover must be byte-identical (no leak while hidden)
  UI.handle('revealNext'); advanceTo(conspId);
  if (S().ui.revealIdx < G.players.length) {
    UI.handle('revealShow'); S().ui.hidden = true; UI.render();
    ok(html() === scapeCover, 'the privacy cover is identical for scapegoat and conspirator');
  }
  UI.setView('home'); UI.render();
})();

// ---------------------------------------------------------------------------
// Full-game UI driver.
function curHand(G, pid) { return SG.getPlayer(G, pid).hand; }
function otherColor(G, cur) { return pick(G.config.playerColors.filter(function (c) { return c !== cur.color; })); }

function runReveal(G) {
  UI.handle('revealStart');
  while (S().ui.revealIdx < G.players.length) { UI.handle('revealShow'); UI.handle('revealNext'); }
  UI.handle('beginPlay');
}

function stepUI(turns, copsCap) {
  var st = S(); var G = st.G; var u = st.ui;
  switch (G.phase) {
    case 'reveal': runReveal(G); break;
    case 'round_over': UI.handle('nextHeist'); break;
    case 'movement': {
      var targets = SG.eligibleMoveTargets(G);
      var inter = SG.copsInterrupters(G);
      if (inter.length && Math.random() < 0.03) { UI.handle('copsInterrupt', inter[0]); break; }
      if (Math.random() < 0.15) { UI.handle('peekShow'); UI.handle('peekHide'); } // exercise the gated peek
      var nonCops = targets.filter(function (l) { return l !== 'cops'; });
      var pCops = Math.min(copsCap, 0.004 * turns);
      var loc;
      if (Math.random() < pCops) loc = 'cops';
      else if (!G.prepFlipped && Math.random() < 0.55) loc = 'prepare';
      else if (G.prepFlipped && SG.currentPlayer(G).prepTokens > 0 && Math.random() < 0.5) loc = 'prepare';
      else loc = pick(nonCops);
      if (targets.indexOf(loc) === -1) loc = pick(nonCops);
      UI.handle('moveTo', loc);
      break;
    }
    case 'action_spy': UI.handle('chooseSpy', pick(G.players.filter(function (p) { return p.id !== G.currentPlayerId; })).id); break;
    case 'action_spy_view': if (!u.spyShown) UI.handle('spyShow'); else UI.handle('spyDone'); break;
    case 'action_trade': UI.handle('choosePartner', pick(G.players.filter(function (p) { return p.id !== G.currentPlayerId; })).id); break;
    case 'action_trade_select': {
      if (u.tradeStep === 'initiator') UI.handle('tradeInitPick', pick(curHand(G, G.trade.initiatorId)));
      else if (u.tradeStep === 'partnerGate') UI.handle('tradePartnerGate');
      else if (u.tradeStep === 'partner') UI.handle('tradePartnerPick', pick(curHand(G, G.trade.partnerId)));
      else UI.handle('tradeCommit');
      break;
    }
    case 'action_stash': UI.handle('stashTake', rint(G.stash.length)); break;
    case 'action_stash_return': UI.handle('stashReturn', pick(curHand(G, G.currentPlayerId))); break;
    case 'action_prepare': UI.handle('doPrepare'); break;
    case 'action_framesteal': {
      var cur = SG.currentPlayer(G);
      if (cur.prepTokens >= 1) {
        if (G.config.frameMode === 'declared_target') UI.handle('pickFrameTarget', otherColor(G, cur));
        else UI.handle('frameInitiateAuto');
      } else {
        var v = SG.eligibleStealTargets(G);
        ok(v.length > 0, 'UI steal has a victim');
        UI.handle('doSteal', pick(v));
      }
      break;
    }
    case 'action_cops': UI.handle('confirmCops'); break;
    case 'frame_select': {
      if (u.frameIdx >= G.frame.participantIds.length) { UI.handle('frameReveal'); break; }
      if (u.frameGate) UI.handle('frameGateOpen');
      else UI.handle('framePick', pick(curHand(G, G.frame.participantIds[u.frameIdx])));
      break;
    }
    case 'frame_resolve': UI.handle('frameContinue'); break;
    case 'evidence_swap': {
      if (!u.swapShown) { UI.handle('swapShow'); break; }
      var outs = SG.eligibleSwapOutCards(G, G.currentPlayerId);
      ok(outs.length > 0, 'UI swap has an eligible card');
      UI.handle('doSwap', pick(outs));
      break;
    }
    default: ok(false, 'unexpected UI phase ' + G.phase); break;
  }
}

function playUI(pc, mode, scoring, copsCap, label, kinds) {
  var d = SG.defaultConfig(pc);
  d.frameMode = mode;
  if (scoring) { d.scoring.enabled = true; d.scoring.winTarget = 3; }
  if (kinds) d.playerKinds = kinds;
  UI.setDraft(d);
  UI.handle('startGame');
  expectRendered(label + ' start');
  var allBot = !kinds ? false : kinds.every(function (k) { return k === 'bot'; });
  var guard = 0, turns = 0, leak = false;
  while (S().G.phase !== 'game_over' && guard++ < 60000) {
    if (UI.botActOnce()) {                 // a bot (or auto-skip) acted
      UI.render();
      if (allBot && /believe the scapegoat is/i.test(html())) leak = true; // no human ever peeks in all-bot
      continue;
    }
    var before = S().G.phase;
    stepUI(turns, copsCap);                // a human must act
    if (before === 'movement') turns++;
    expectRendered(label + ' step');
  }
  if (allBot) ok(!leak, label + ' all-bot game never leaked intel on a shared screen');
  var fin = S().G;
  ok(fin.phase === 'game_over', label + ' reached game_over (guard ' + guard + ')');
  ok(fin.winner === 'scapegoat' || fin.winner === 'conspirators', label + ' produced a winner');
  expectRendered(label + ' game over');
  ok(/THE SCAPEGOAT WINS|THE GANG WINS/.test(html()), label + ' shows a result banner');
  return fin;
}
function kindsArr(pc, bots) { var a = []; for (var i = 0; i < pc; i++) a.push(i < bots ? 'bot' : 'human'); return a; }

// quick all-human games (cops-friendly) across counts + both frame modes
['declared_target', 'auto_detect'].forEach(function (mode) {
  [3, 4, 5, 6, 7].forEach(function (pc) {
    for (var g = 0; g < 3; g++) playUI(pc, mode, false, 0.5, pc + 'p/' + mode);
  });
});
// frame-heavy games (suppress cops) to exercise the frame UI flow hard
[4, 5, 6].forEach(function (pc) {
  for (var g = 0; g < 4; g++) playUI(pc, 'declared_target', false, 0.04, pc + 'p/frameheavy');
});
// a series game through the round-over -> next-heist UI
playUI(5, 'declared_target', true, 0.2, '5p/series');

// BOT PLAY: mixed human+bot games, and fully autonomous all-bot games (must self-run, never leak).
[4, 5, 6].forEach(function (pc) {
  for (var g = 0; g < 3; g++) playUI(pc, 'declared_target', false, 0.3, pc + 'p/mixed', kindsArr(pc, pc - 1)); // 1 human
});
[4, 5, 6].forEach(function (pc) {
  for (var g = 0; g < 3; g++) playUI(pc, 'declared_target', false, 0.3, pc + 'p/allbot', kindsArr(pc, pc));   // all bots
});

console.log('\n' + (fail === 0 ? 'ALL PASSED' : 'FAILURES PRESENT') + ': ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail === 0 ? 0 : 1);
