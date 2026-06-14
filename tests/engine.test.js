/*
 * engine.test.js - exercises sg-deck.js + sg-engine.js with no dependencies.
 *
 * Run: node tests/engine.test.js   (or: npm test)
 *
 * Covers:
 *   - config defaults + validation (the "scrutinize the configurations" requirement)
 *   - deck synthesis invariants (closed economy + the N-1 frame-feasibility floor)
 *   - targeted rules (frame success/fail in both modes incl. ambiguity; scapegoat
 *     framed vs innocent framed; cops; prep-flip; steal-has-a-victim; shed-own-colour)
 *   - the HIDDEN-INFO contract: revealInfo shape parity, no role flag anywhere,
 *     publicState leaks nothing (this is the wink-killer class of bug we must avoid)
 *   - conservation invariants (cards + prep tokens) checked every step
 *   - fuzz: many full random-but-legal playthroughs for every count, both frame
 *     modes, single + series, asserting termination + invariants + no-throw.
 */
'use strict';

var SGDeck = require('../assets/sg-deck.js');
var SG = require('../assets/sg-engine.js');
var SGBot = require('../assets/sg-bot.js');
var fs = require('fs');

var pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL: ' + msg); } }
function section(name) { console.log('\n# ' + name); }
function throws(fn, msg) { var t = false; try { fn(); } catch (e) { t = true; } ok(t, msg); }
function rint(n) { return Math.floor(Math.random() * n); }
function pick(a) { return a[rint(a.length)]; }

// ---------------------------------------------------------------------------
section('config defaults & validation');

for (var pc = 3; pc <= 8; pc++) {
  var cfg = SG.defaultConfig(pc);
  var v = SG.validateConfig(cfg);
  ok(v.ok, 'default config for ' + pc + ' players validates (errors: ' + JSON.stringify(v.errors) + ')');
  ok(cfg.playerColors.length === pc, pc + 'p has ' + pc + ' distinct colours');
  // 4-6 should be warning-free on defaults; 3 and 7-8 carry an off-spec warning.
  if (pc >= 4 && pc <= 6) ok(v.warnings.length === 0, pc + 'p default has no warnings (' + JSON.stringify(v.warnings) + ')');
  else ok(v.warnings.some(function (w) { return /official 4-6/.test(w); }), pc + 'p default warns about off-spec count');
}

(function () { var c = SG.defaultConfig(2); ok(!SG.validateConfig(c).ok, '2 players is an error'); })();
(function () { var c = SG.defaultConfig(4); c.playerNames[1] = ''; ok(!SG.validateConfig(c).ok, 'blank name is an error'); })();
(function () { var c = SG.defaultConfig(4); c.playerColors[1] = c.playerColors[0]; ok(!SG.validateConfig(c).ok, 'duplicate colour is an error'); })();
(function () { var c = SG.defaultConfig(4); c.stashSize = 0; ok(!SG.validateConfig(c).ok, 'empty stash is an error'); })();
(function () { var c = SG.defaultConfig(4); c.prepTokens = 1; c.flipThreshold = 2; ok(!SG.validateConfig(c).ok, 'flip threshold above prep tokens is an error (board never flips)'); })();
(function () { var c = SG.defaultConfig(8); c.handSize = 2; var r = SG.validateConfig(c); ok(!r.ok && r.errors.some(function (e) { return /every player/.test(e); }), '8p hand-size 2 is infeasible -> error'); })();
(function () { var c = SG.defaultConfig(4); c.enforceDumpOwnColor = false; var r = SG.validateConfig(c); ok(r.ok && r.warnings.length > 0, 'relaxing shed-own-colour is a warning, still playable'); })();
(function () { var c = SG.defaultConfig(5); c.scoring.enabled = true; ok(SG.validateConfig(c).ok, 'series scoring config validates'); })();
(function () { var c = SG.defaultConfig(5); c.scoring.enabled = true; c.scoring.scoreEscape = -1; ok(!SG.validateConfig(c).ok, 'negative points is an error'); })();
// Player-count vs config: the out-of-turn cops interrupt is a 6-player rule.
(function () { var c = SG.defaultConfig(3); c.cops.sixPlayerInterrupt = true; ok(!SG.validateConfig(c).ok, '6p interrupt at 3 players is an error (offset out of range)'); })();
(function () { var c = SG.defaultConfig(6); c.cops.sixPlayerInterrupt = true; ok(SG.validateConfig(c).ok, '6p interrupt is valid at 6 players'); })();
(function () { for (var n = 3; n <= 8; n++) ok(SG.defaultConfig(n).cops.sixPlayerInterrupt === (n === 6), n + 'p default enables the interrupt only at 6'); })();

// ---------------------------------------------------------------------------
section('deck synthesis invariants');

['scarce', 'balanced', 'rich', 'chaos'].forEach(function (preset) {
  for (var n = 3; n <= 8; n++) {
    var c = SG.defaultConfig(n); c.deck.preset = preset;
    var composed = SGDeck.composeDeck(c);
    var expected = SGDeck.deckSizeFor(c);
    ok(composed.cards.length === expected, preset + '/' + n + 'p deck size == N*H+4+stash (' + expected + ')');
    ok(composed.stats.minIncidence >= n - 1, preset + '/' + n + 'p every colour appears >= N-1 (' + (n - 1) + ') times');
    // no card shows a colour twice
    var dup = composed.cards.some(function (cd) { var s = {}; for (var i = 0; i < cd.colors.length; i++) { if (s[cd.colors[i]]) return true; s[cd.colors[i]] = 1; } return false; });
    ok(!dup, preset + '/' + n + 'p no card repeats a colour');
    // No card may carry >= N colours (would auto-frame); cap is min(3, N-1) for chaos else 2.
    var cap = SGDeck.effectiveMaxColors(c, SGDeck.presetKnobs(c));
    ok(composed.cards.every(function (cd) { return cd.colors.length <= cap; }), preset + '/' + n + 'p respects the colour cap (' + cap + ')');
  }
});
// The "chaos" preset actually produces 3-colour cards once there are enough colours.
[4, 5, 6, 7, 8].forEach(function (n) {
  var c = SG.defaultConfig(n); c.deck.preset = 'chaos';
  var st = SGDeck.composeDeck(c).stats;
  ok(st.triples > 0, 'chaos/' + n + 'p produces 3-colour cards (matches its label)');
  ok(st.minIncidence >= n - 1, 'chaos/' + n + 'p still meets the frame floor');
});
(function () { var c = SG.defaultConfig(3); c.deck.preset = 'chaos'; ok(SGDeck.composeDeck(c).stats.triples === 0, 'chaos/3p has no 3-colour cards (only 2 other colours exist)'); })();

// ---------------------------------------------------------------------------
section('hidden-information contract (anti-leak)');

(function () {
  var s = SG.newGame(SG.defaultConfig(6), 4242);
  var sgId = s.scapegoatId;
  var conspirator = s.players.filter(function (p) { return p.id !== sgId; })[0];

  // revealInfo: identical key shape for the scapegoat and a conspirator; no role flag.
  var riScape = SG.revealInfo(s, sgId);
  var riConsp = SG.revealInfo(s, conspirator.id);
  ok(JSON.stringify(Object.keys(riScape).sort()) === JSON.stringify(Object.keys(riConsp).sort()),
    'revealInfo has identical keys for scapegoat and conspirator');
  ok(!('isScapegoat' in riScape) && !('role' in riScape) && !('scapegoatId' in riScape),
    'revealInfo carries no role flag');
  // The scapegoat is told a decoy (!= self, != the truth); conspirators are told the truth.
  ok(riScape.suspectId !== sgId && riScape.suspectId !== riScape.you.id, 'scapegoat is fed a decoy (not themselves)');
  ok(riConsp.suspectId === sgId, 'a conspirator is told the true scapegoat');

  // No player object carries any role/secret field.
  var leakedField = s.players.some(function (p) {
    return ('role' in p) || ('isScapegoat' in p) || ('scapegoat' in p) || ('intel' in p) || ('suspect' in p);
  });
  ok(!leakedField, 'no player object exposes a role/intel field');

  // publicState (the only thing a shared screen may render) leaks nothing secret.
  var pub = SG.publicState(s);
  var json = JSON.stringify(pub);
  ok(!('scapegoatId' in pub) && !('intel' in pub), 'publicState has no scapegoatId/intel keys');
  ok(json.indexOf('"hand"') === -1, 'publicState exposes no hands (only handCount)');
  ok(pub.players.every(function (p) { return typeof p.handCount === 'number' && !('hand' in p); }), 'publicState players show handCount, not hand');
  // The decoy/scapegoat ids must not be derivable from publicState beyond the public colour list.
  ok(json.indexOf('suspect') === -1, 'publicState mentions no suspicions');
})();

// ---------------------------------------------------------------------------
section('targeted rules');

// Build a controlled frame: give the engine known cards and hands, then resolve.
function injectCard(s, colors, hasBystander) {
  var id = 'inj-' + Object.keys(s.cards).length + '-' + colors.join('');
  s.cards[id] = { id: id, colors: colors.slice(), hasBystander: !!hasBystander };
  return id;
}
// Force a frame attempt where every non-owner of `targetColor` reveals a target card.
function setupFrame(seed, frameMode, makeQualify, extraColorForAmbiguity) {
  var c = SG.defaultConfig(5); c.frameMode = frameMode;
  var s = SG.newGame(c, seed);
  SG.beginPlay(s);
  var cur = SG.currentPlayer(s);
  s.prepFlipped = true; cur.prepTokens = 1;
  cur.location = 'prepare'; s.movedTo = 'prepare'; s.phase = 'action_framesteal';
  var target = s.players.filter(function (p) { return p.id !== cur.id; })[0]; // someone other than the framer
  var targetColor = target.color;
  // declared mode declares the target colour
  SG.frameInitiate(s, frameMode === 'declared_target' ? targetColor : undefined);
  // Give every participant a hand we control, then pick.
  s.players.forEach(function (p) {
    var colors = [];
    if (p.id === target.id) {
      colors = ['__none__']; // owner sheds their colour -> a card without targetColor
    } else {
      colors = makeQualify ? [targetColor] : (p.seat === (target.seat + 1) % s.players.length ? ['__none__'] : [targetColor]);
    }
    if (extraColorForAmbiguity) colors = [targetColor, extraColorForAmbiguity];
    var cid = injectCard(s, colors);
    p.hand = [cid];
    SG.frameSelect(s, p.id, cid);
  });
  return { s: s, target: target, targetColor: targetColor, framer: cur };
}

// Declared frame succeeds when every other player holds the target colour.
(function () {
  var f = setupFrame(7, 'declared_target', true);
  SG.frameResolve(f.s);
  ok(f.s.lastFrame.success && f.s.framedId === f.target.id, 'declared frame succeeds, frames the declared target');
  ok(f.s.phase === 'game_over', 'a successful frame ends the game');
})();

// Declared frame fails if one non-owner lacks the colour.
(function () {
  var f = setupFrame(7, 'declared_target', false);
  SG.frameResolve(f.s);
  ok(!f.s.lastFrame.success && f.s.phase === 'frame_resolve', 'declared frame fails when a non-owner lacks the colour');
  SG.frameAcknowledge(f.s);
  ok(f.s.phase === 'evidence_swap', 'after a failed frame the framer still does an evidence swap');
})();

// Auto-detect: multiple qualifying colours -> ambiguous -> fails (never silently picks).
(function () {
  var c = SG.defaultConfig(4); c.frameMode = 'auto_detect';
  var s = SG.newGame(c, 31); SG.beginPlay(s);
  var cur = SG.currentPlayer(s); s.prepFlipped = true; cur.prepTokens = 1;
  cur.location = 'prepare'; s.movedTo = 'prepare'; s.phase = 'action_framesteal';
  SG.frameInitiate(s);
  var a = s.config.playerColors[0], b = s.config.playerColors[1];
  s.players.forEach(function (p) { var cid = injectCard(s, [a, b]); p.hand = [cid]; SG.frameSelect(s, p.id, cid); });
  SG.frameResolve(s);
  ok(!s.lastFrame.success, 'auto-detect with two qualifying colours is ambiguous and fails');
})();

// Framing the real scapegoat -> conspirators win; framing an innocent -> scapegoat wins.
(function () {
  // Force the framed target to BE the scapegoat by aligning ids.
  var f = setupFrame(99, 'declared_target', true);
  // Re-point the engine's scapegoat at the target we are framing.
  f.s.scapegoatId = f.target.id;
  SG.frameResolve(f.s);
  ok(f.s.winner === 'conspirators' && f.s.outcome === 'framed_correct', 'framing the real scapegoat => conspirators win');

  var g = setupFrame(98, 'declared_target', true);
  // Make sure the scapegoat is NOT the framed target.
  g.s.scapegoatId = g.framer.id;
  SG.frameResolve(g.s);
  ok(g.s.winner === 'scapegoat' && g.s.outcome === 'framed_wrong', 'framing an innocent => the scapegoat wins');
})();

// Going to the cops always makes the scapegoat win (whoever calls it).
(function () {
  var s = SG.newGame(SG.defaultConfig(5), 5); SG.beginPlay(s);
  var sgId = s.scapegoatId;
  // Make the scapegoat the current player and run to the cops.
  s.turnIndex = SG.seatOf(s, sgId); s.currentPlayerId = sgId;
  SG.move(s, 'cops'); SG.goToCops(s);
  ok(s.winner === 'scapegoat' && s.outcome === 'scapegoat_escaped', 'scapegoat running to the cops => scapegoat wins');
})();
(function () {
  var s = SG.newGame(SG.defaultConfig(5), 6); SG.beginPlay(s);
  var notSg = s.players.filter(function (p) { return p.id !== s.scapegoatId; })[0];
  s.turnIndex = SG.seatOf(s, notSg.id); s.currentPlayerId = notSg.id;
  SG.move(s, 'cops'); SG.goToCops(s);
  ok(s.winner === 'scapegoat' && s.outcome === 'cops_called_wrong', 'an innocent running to the cops still hands the scapegoat the win');
})();

// Prepare flips the board at the threshold.
(function () {
  var s = SG.newGame(SG.defaultConfig(4), 11); SG.beginPlay(s);
  ok(!s.prepFlipped, 'board starts unflipped');
  // Two players each take a prep token.
  s.phase = 'action_prepare'; s.movedTo = 'prepare'; SG.currentPlayer(s).location = 'prepare';
  SG.prepare(s);
  ok(!s.prepFlipped, 'still unflipped after 1 token');
  SG.evidenceSwap(s, SG.eligibleSwapOutCards(s, s.currentPlayerId)[0]);
  // next player takes the second token
  SG.move(s, 'prepare'); ok(s.phase === 'action_prepare', 'still Prepare side before the flip');
  SG.prepare(s);
  ok(s.prepFlipped, 'board flips after the 2nd token taken');
})();

// Post-flip, a tokenless player at Frame/Steal always has someone to steal from.
(function () {
  var s = SG.newGame(SG.defaultConfig(5), 13); SG.beginPlay(s);
  s.prepFlipped = true; s.players[1].prepTokens = 1; s.players[2].prepTokens = 1;
  var cur = SG.currentPlayer(s); cur.prepTokens = 0;
  cur.location = 'prepare'; s.movedTo = 'prepare'; s.phase = 'action_framesteal';
  ok(SG.eligibleStealTargets(s).length >= 1, 'a tokenless framer always has a steal victim');
  SG.steal(s, SG.eligibleStealTargets(s)[0]);
  ok(cur.prepTokens === 1, 'stealing gives the thief a token');
})();

// Shed-own-colour is enforced on the evidence swap.
(function () {
  var s = SG.newGame(SG.defaultConfig(4), 21); SG.beginPlay(s);
  var cur = SG.currentPlayer(s);
  var own = injectCard(s, [cur.color]);
  var other = injectCard(s, [s.players[1].color]);
  cur.hand = [own, other];
  s.movedTo = 'spy'; cur.location = 'spy'; s.faceup['spy'] = injectCard(s, []);
  s.phase = 'evidence_swap'; s.swap = { playerId: cur.id, mustShed: true };
  ok(SG.mustShedOwnColor(s, cur.id), 'engine knows the player must shed their own colour');
  throws(function () { SG.evidenceSwap(s, other); }, 'swapping a non-own-colour card while holding own colour throws');
  SG.evidenceSwap(s, own);
  ok(cur.hand.indexOf(own) === -1, 'shedding the own-colour card succeeds');
})();

// 6-player out-of-turn cops interrupt: exactly the player N seats away may interrupt.
(function () {
  var c = SG.defaultConfig(6); c.cops.sixPlayerInterrupt = true; c.cops.interruptSeatsLeft = 3;
  var s = SG.newGame(c, 71); SG.beginPlay(s);
  s.turnIndex = 0; s.currentPlayerId = s.players[0].id; s.phase = 'movement';
  var who = SG.copsInterrupters(s);
  ok(who.length === 1 && SG.seatOf(s, who[0]) === 3, 'the player 3 seats left of the active player may interrupt');
  SG.goToCopsInterrupt(s, who[0]);
  ok(s.winner === 'scapegoat', 'an out-of-turn cops interrupt ends the game with the scapegoat winning');
})();

// ---------------------------------------------------------------------------
section('series scoring');
(function () {
  var c = SG.defaultConfig(4); c.scoring.enabled = true; c.scoring.winTarget = 4; c.scoring.scoreEscape = 2;
  var s = SG.newGame(c, 1234); SG.beginPlay(s);
  var sgId = s.scapegoatId;
  s.turnIndex = SG.seatOf(s, sgId); s.currentPlayerId = sgId;
  SG.move(s, 'cops'); SG.goToCops(s);
  ok(s.scores[sgId] === 2 && s.phase === 'round_over', 'series: scapegoat escape scores 2, round (not series) ends');
  SG.nextRound(s);
  ok(s.phase === 'reveal' && s.seriesRound === 2, 'series: nextRound re-deals and bumps the series round');
})();

// ---------------------------------------------------------------------------
section('bot play: anti-cheat + autonomy');

// STATIC anti-cheat: the bot module must never reference the hidden scapegoat id.
(function () {
  var src = fs.readFileSync(require.resolve('../assets/sg-bot.js'), 'utf8');
  var code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); // strip comments
  ok(code.indexOf('scapegoatId') === -1, 'sg-bot.js never references state.scapegoatId');
})();

// BEHAVIOURAL anti-cheat: a bot's decisions must be INVARIANT when we swap who the real
// scapegoat is (keeping the bot's own observations identical). If a decision changed, the
// bot must be peeking at hidden state.
(function () {
  var c = SG.defaultConfig(6); c.playerKinds = c.playerKinds.map(function () { return 'bot'; });
  var s = SG.newGame(c, 24680); SG.beginPlay(s);
  // give a bot some observations by simulating a few spies
  var botId = s.players[2].id;
  for (var k = 0; k < 4; k++) {
    s.spy = { viewerId: botId, targetId: s.players[(k + 3) % 6].id };
    SGBot.afterSpy(s, botId);
  }
  s.spy = null;
  var before = {
    cops: SGBot.wantsCops(s, botId),
    ready: SGBot.readyToFrame(s, botId),
    frameColor: SGBot.botFrameTargetColor(s, botId),
    danger: SGBot.dangerLevel(s, botId)
  };
  // Re-point the real scapegoat at every other seat; the bot's reads must not move.
  var stable = true;
  for (var i = 0; i < s.players.length; i++) {
    s.scapegoatId = s.players[i].id;
    if (SGBot.wantsCops(s, botId) !== before.cops) stable = false;
    if (SGBot.readyToFrame(s, botId) !== before.ready) stable = false;
    if (SGBot.botFrameTargetColor(s, botId) !== before.frameColor) stable = false;
    if (SGBot.dangerLevel(s, botId) !== before.danger) stable = false;
  }
  ok(stable, 'bot decisions are invariant to who the real scapegoat is (no cheating)');
})();

// Autonomy + invariants: full all-bot games must terminate and conserve everything.
function botAutoStep(s) {
  var ph = s.phase;
  if (ph === 'frame_select') { s.frame.participantIds.forEach(function (pid) { SG.frameSelect(s, pid, SGBot.botFrameCard(s, pid)); }); SG.frameResolve(s); SGBot.afterFrameReveal(s); return; }
  if (ph === 'action_trade_select') { var t = s.trade; SG.tradeSelect(s, t.initiatorId, SGBot.botTradeGiveCard(s, t.initiatorId)); SG.tradeSelect(s, t.partnerId, SGBot.botTradeGiveCard(s, t.partnerId)); SG.tradeCommit(s); return; }
  if (SGBot.takeAction(s, s.currentPlayerId)) return;
  throw new Error('bot stuck at ' + ph);
}
(function () {
  var botWins = { scapegoat: 0, conspirators: 0 };
  for (var n = 3; n <= 6; n++) {
    for (var g = 0; g < 25; g++) {
      var c = SG.defaultConfig(n); c.playerKinds = c.playerKinds.map(function () { return 'bot'; });
      var s = SG.newGame(c, 333000 + n * 100 + g); SG.beginPlay(s);
      var guard = 0;
      while (s.phase !== 'game_over' && guard++ < 4000) {
        if (s.phase === 'round_over') { SG.nextRound(s); SG.beginPlay(s); continue; }
        botAutoStep(s);
        checkInvariants(s, n + 'p/allbot');
      }
      ok(s.phase === 'game_over', n + 'p all-bot game terminated (guard ' + guard + ')');
      if (s.winner) botWins[s.winner]++;
    }
  }
  ok(botWins.scapegoat > 0 && botWins.conspirators > 0, 'all-bot games produce BOTH outcomes (scapegoat ' + botWins.scapegoat + ' / gang ' + botWins.conspirators + ')');
})();

// ---------------------------------------------------------------------------
section('fuzz: full random playthroughs + invariants');

function deckSize(s) { return s.config.playerCount * s.config.handSize + 4 + s.config.stashSize; }
function checkInvariants(s, label) {
  // card conservation across hands + faceup + stash
  var total = 0;
  s.players.forEach(function (p) { total += p.hand.length; });
  total += SG.FACEUP_LOCATIONS.length;
  total += s.stash.length;
  ok(total === deckSize(s), label + ' cards conserved (' + total + '/' + deckSize(s) + ')');
  // prep-token conservation
  var held = 0; s.players.forEach(function (p) { held += p.prepTokens; });
  ok(held + s.prepTokensRemaining === s.config.prepTokens, label + ' prep tokens conserved');
  // anti-leak: no role field ever appears on a player
  ok(s.players.every(function (p) { return !('role' in p) && !('isScapegoat' in p); }), label + ' no role field leaked onto players');
}

var framesResolved = 0;
function pickHandCard(s, pid) { var p = SG.getPlayer(s, pid); return pick(p.hand); }
function otherPlayer(s) { return pick(s.players.filter(function (p) { return p.id !== s.currentPlayerId; })).id; }
function randomOtherColor(s, cur) { return pick(s.config.playerColors.filter(function (c) { return c !== cur.color; })); }

function step(s, turns, copsCap) {
  if (copsCap == null) copsCap = 0.6;
  switch (s.phase) {
    case 'movement': {
      var targets = SG.eligibleMoveTargets(s);
      // occasionally exercise the 6p interrupt
      var interrupters = SG.copsInterrupters(s);
      if (interrupters.length && Math.random() < 0.02) { SG.goToCopsInterrupt(s, interrupters[0]); return; }
      var pCops = Math.min(copsCap, 0.004 * turns);
      var nonCops = targets.filter(function (l) { return l !== 'cops'; });
      var loc;
      if (Math.random() < pCops) loc = 'cops';                 // cops ONLY via this gate
      else if (!s.prepFlipped && Math.random() < 0.55) loc = 'prepare';
      else if (s.prepFlipped && SG.currentPlayer(s).prepTokens > 0 && Math.random() < 0.5) loc = 'prepare';
      else loc = pick(nonCops);
      if (targets.indexOf(loc) === -1) loc = pick(nonCops);
      SG.move(s, loc);
      break;
    }
    case 'action_spy': SG.spy(s, otherPlayer(s)); break;
    case 'action_spy_view': SG.spyDone(s); break;
    case 'action_trade': SG.tradeBegin(s, otherPlayer(s)); break;
    case 'action_trade_select': {
      var t = s.trade;
      SG.tradeSelect(s, t.initiatorId, pickHandCard(s, t.initiatorId));
      SG.tradeSelect(s, t.partnerId, pickHandCard(s, t.partnerId));
      SG.tradeCommit(s);
      break;
    }
    case 'action_stash': SG.stashTake(s, rint(s.stash.length)); break;
    case 'action_stash_return': SG.stashReturn(s, pickHandCard(s, s.currentPlayerId)); break;
    case 'action_prepare': SG.prepare(s); break;
    case 'action_framesteal': {
      var cur = SG.currentPlayer(s);
      if (cur.prepTokens >= 1) {
        SG.frameInitiate(s, s.config.frameMode === 'declared_target' ? randomOtherColor(s, cur) : undefined);
      } else {
        var victims = SG.eligibleStealTargets(s);
        ok(victims.length > 0, 'steal has a victim at ' + s.config.playerCount + 'p');
        SG.steal(s, pick(victims));
      }
      break;
    }
    case 'action_cops': SG.goToCops(s); break;
    case 'frame_select': {
      s.frame.participantIds.forEach(function (pid) { SG.frameSelect(s, pid, pickHandCard(s, pid)); });
      framesResolved++;
      SG.frameResolve(s);
      break;
    }
    case 'frame_resolve': SG.frameAcknowledge(s); break;
    case 'evidence_swap': {
      var outs = SG.eligibleSwapOutCards(s, s.currentPlayerId);
      ok(outs.length > 0, 'has a swap-out card');
      SG.evidenceSwap(s, pick(outs));
      break;
    }
    default: throw new Error('unexpected phase ' + s.phase);
  }
}

function playRandomGame(pc, seed, frameMode, scoring, copsCap) {
  var c = SG.defaultConfig(pc);
  c.frameMode = frameMode;
  if (scoring) { c.scoring.enabled = true; c.scoring.winTarget = 3; }
  var s = SG.newGame(c, seed);
  SG.beginPlay(s);
  var guard = 0, turns = 0;
  var label = pc + 'p/' + frameMode + (scoring ? '/series' : '') + (copsCap != null ? '/frameheavy' : '');
  while (s.phase !== 'game_over' && guard++ < 40000) {
    if (s.phase === 'round_over') { SG.nextRound(s); SG.beginPlay(s); continue; }
    step(s, turns++, copsCap);
    checkInvariants(s, label);
  }
  ok(s.phase === 'game_over', label + ' seed ' + seed + ' terminated (guard ' + guard + ')');
  ok(s.winner === 'conspirators' || s.winner === 'scapegoat', label + ' produced a winner');
  return s;
}

var outcomeTally = {};
['declared_target', 'auto_detect'].forEach(function (mode) {
  for (var n = 3; n <= 8; n++) {
    for (var g = 0; g < 18; g++) {
      var s = playRandomGame(n, n * 1000 + g + 1, mode, false);
      outcomeTally[s.outcome] = (outcomeTally[s.outcome] || 0) + 1;
    }
  }
});
// series mode for the official counts
[4, 5, 6].forEach(function (n) {
  for (var g = 0; g < 12; g++) playRandomGame(n, 500000 + n * 100 + g, 'declared_target', true);
});
// frame-heavy: suppress the cops escape so games run long and resolve MANY frames,
// stressing the frame phases and the conservation invariants during them.
['declared_target', 'auto_detect'].forEach(function (mode) {
  [4, 5, 6].forEach(function (n) {
    for (var g = 0; g < 10; g++) {
      var s = playRandomGame(n, 700000 + n * 100 + g, mode, false, 0.04);
      outcomeTally[s.outcome] = (outcomeTally[s.outcome] || 0) + 1;
    }
  });
});
console.log('  random-play outcome split:', JSON.stringify(outcomeTally), '+ ' + framesResolved + ' frame attempts resolved (sanity only, not a balance claim)');
ok(framesResolved > 0, 'fuzz exercised the frame-resolution machinery (' + framesResolved + ' attempts)');
ok((outcomeTally['scapegoat_escaped'] || 0) + (outcomeTally['cops_called_wrong'] || 0) > 0, 'fuzz exercised the cops path');

// ---------------------------------------------------------------------------
console.log('\n' + (fail === 0 ? 'ALL PASSED' : 'FAILURES PRESENT') + ': ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail === 0 ? 0 : 1);
