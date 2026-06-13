/*
 * sg-bot.js — honest computer players for Scape Goat.
 *
 * ANTI-CHEAT CONTRACT (do not break): a bot may read ONLY information a human in its
 * seat would have:
 *   - its own hand (player.hand) and the card definitions (state.cards — public shape),
 *   - its own intel / suspect (state.intel[botId]),
 *   - the public board (face-up cards, token positions, hand COUNTS, prep tokens),
 *   - its own accumulated observations (state.botMemory[botId]), filled only from
 *     things it legitimately saw (the face-up cards, a hand it Spied, a Frame reveal).
 * A bot MUST NOT read state.scapegoatId, another player's hand, or another player's
 * intel. (A test greps this file for `scapegoatId` and asserts it never appears, and
 * asserts decisions are invariant when the real scapegoat is swapped.)
 *
 * How a bot "realises" it is the scapegoat — exactly like a human: it watches its OWN
 * colour pile up in other hands / face-up (via Spying and the public board). Conspirators
 * collect the real scapegoat's colour, so only the real scapegoat sees its own colour
 * hoarded — and when the count crosses a threshold, the bot runs to the cops.
 */
(function (root, factory) {
  var SG = (typeof module !== 'undefined' && module.exports) ? require('./sg-engine.js') : (root && root.SG);
  var SGBot = factory(SG);
  if (typeof module !== 'undefined' && module.exports) module.exports = SGBot;
  if (root) root.SGBot = SGBot;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (SG) {
  'use strict';

  // local PRNG on the shared seed so bot choices stay deterministic per (config, seed)
  function brand(state) {
    var t = (state.rngState = (state.rngState + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function ri(state, n) { return Math.floor(brand(state) * n); }
  function pick(state, arr) { return arr[ri(state, arr.length)]; }

  // ---- legitimate-info helpers -------------------------------------------
  function me(state, id) { return SG.getPlayer(state, id); }
  function ownColor(state, id) { return me(state, id).color; }
  function suspectColor(state, id) { return SG.colorOf(state, state.intel[id]); } // own intel only
  function def(state, cid) { return state.cards[cid]; }
  function has(state, cid, color) { return SG.cardContainsColor(state, cid, color); }
  function handHasColor(state, id, color) {
    var h = me(state, id).hand;
    for (var i = 0; i < h.length; i++) if (has(state, h[i], color)) return true;
    return false;
  }

  function mem(state, id) {
    // seen[colour] = recency-decayed count of how often each PLAYER colour shows up in the
    // hands/cards this bot has legitimately seen (by Spying, or in a public Frame reveal).
    // The most-hoarded colour the bot observes is (reliably) the real scapegoat's, because the
    // whole gang is collecting it. So a bot only has to ask: is that dominant colour MINE
    // (-> I'm the patsy, run!) or my SUSPECT's (-> we're aligned, spring the frame)?
    if (!state.botMemory[id]) state.botMemory[id] = { seen: {} };
    return state.botMemory[id];
  }
  function bump(state, id, cardIds) {
    var m = mem(state, id), k;
    for (k in m.seen) if (m.seen.hasOwnProperty(k)) m.seen[k] *= 0.75; // decay one event
    for (var i = 0; i < cardIds.length; i++) {
      var cols = def(state, cardIds[i]).colors;
      for (var c = 0; c < cols.length; c++) m.seen[cols[c]] = (m.seen[cols[c]] || 0) + 1;
    }
  }
  function afterSpy(state, viewerId) { // call right after SG.spy: only the spying bot learns
    if (state.spy && state.spy.viewerId === viewerId) bump(state, viewerId, me(state, state.spy.targetId).hand);
  }
  function afterFrameReveal(state) { // a Frame reveal is public — every bot learns from it
    if (!state.lastFrame) return;
    var picks = state.lastFrame.picks, ids = [];
    for (var p in picks) if (picks.hasOwnProperty(p)) ids.push(picks[p]);
    state.players.forEach(function (b) { if (b.kind === 'bot') bump(state, b.id, ids); });
  }
  // The colour the bot sees hoarded the most, and the runner-up (over real player colours).
  function topColor(state, id) {
    var seen = mem(state, id).seen, cols = state.config.playerColors;
    var bestC = null, best = 0, second = 0;
    for (var i = 0; i < cols.length; i++) {
      var v = seen[cols[i]] || 0;
      if (v > best) { second = best; best = v; bestC = cols[i]; }
      else if (v > second) { second = v; }
    }
    return { color: bestC, count: best, second: second };
  }

  // ---- core judgement: am I the patsy? -----------------------------------
  // Reads ONLY memory + own colour/suspect — NOT state.scapegoatId.
  function dangerLevel(state, id) { var t = topColor(state, id); return t.color === ownColor(state, id) ? t.count : 0; }
  function wantsCops(state, id) {
    var t = topColor(state, id);
    if (t.color !== ownColor(state, id)) return false; // my colour isn't the most-hoarded -> not the patsy
    // Require SUSTAINED evidence (count>=3 takes several spies under the 0.75 decay) so a single
    // lucky spy of a 2-of-my-colour hand can't trigger an early panic. Loosen only when it's late.
    if (t.count >= 3 && t.count >= 1.5 * t.second) return true;
    if (state.round >= 10 && t.count >= 2 && t.count >= 1.2 * t.second) return true;
    if (state.round >= 16 && t.count >= 1.5) return true; // dragging heist: if my colour leads at all, bolt
    return false;
  }
  // Confident the gang is collecting my suspect's colour (we're aligned) -> spring the frame.
  // Looser than the cops bar so the gang actually acts; the scapegoat's top colour is its OWN,
  // never its decoy, so this never fires for the scapegoat.
  function readyToFrame(state, id) {
    var t = topColor(state, id);
    return t.color === suspectColor(state, id) && t.count >= 2;
  }

  // ---- card-preference tiers (lower = more willing to give away) ---------
  function tierGive(state, id, cid) { // trade / face-up swap: shed grey first, keep suspect colour
    var own = ownColor(state, id), sus = suspectColor(state, id), d = def(state, cid);
    if (d.colors.indexOf(sus) !== -1) return 4;            // keep — needed to frame
    if (d.colors.length === 0) return 0;                   // grey-only: safest to give
    if (d.colors.indexOf(own) !== -1) return 3;            // own colour: avoid arming others
    return 1;                                              // neutral coloured
  }
  function tierStashReturn(state, id, cid) { // facedown: hide your OWN colour first
    var own = ownColor(state, id), sus = suspectColor(state, id), d = def(state, cid);
    if (d.colors.indexOf(sus) !== -1) return 4;
    if (d.colors.indexOf(own) !== -1) return 0;            // bury own colour out of sight
    if (d.colors.length === 0) return 1;
    return 2;
  }
  function bestToGive(state, id, cards, tierFn, target) {
    var best = null, bestTier = 1e9;
    for (var i = 0; i < cards.length; i++) {
      var t = tierFn(state, id, cards[i], target);
      if (t < bestTier) { bestTier = t; best = cards[i]; }
    }
    return best;
  }

  // ---- decisions ---------------------------------------------------------
  function botMove(state, id) {
    var p = me(state, id);
    var targets = SG.eligibleMoveTargets(state);
    function can(loc) { return targets.indexOf(loc) !== -1; }
    var nonCops = targets.filter(function (l) { return l !== 'cops'; });

    if (wantsCops(state, id) && can('cops')) return 'cops';

    var flipped = state.prepFlipped;
    var hasToken = p.prepTokens > 0;
    var sus = suspectColor(state, id);
    var hasSuspect = handHasColor(state, id, sus);
    var ready = readyToFrame(state, id);
    // Impatience: the longer the heist runs, the more willing a token-holder is to just spring
    // the frame even unconfirmed, so games converge instead of circling forever.
    var urgency = state.round;

    // ready to frame: token + a suspect-colour card + (confirmed, or just impatient enough)
    if (flipped && hasToken && hasSuspect && (ready || urgency >= 6) && can('prepare')) return 'prepare';
    // have a token but not yet confident -> Spy to verify others hold the suspect colour
    if (flipped && hasToken && !ready && can('spy') && brand(state) < 0.7) return 'spy';
    // no token but want one: steal occasionally
    if (flipped && !hasToken && SG.eligibleStealTargets(state).length && can('prepare') && brand(state) < 0.3) return 'prepare';
    // pre-flip: take a token / push the flip
    if (!flipped && state.prepTokensRemaining > 0 && can('prepare') && brand(state) < 0.45) return 'prepare';
    // need the suspect's colour: draw from the stash or trade for it
    if (!hasSuspect) {
      if (can('stash') && brand(state) < 0.6) return 'stash';
      if (can('trade') && brand(state) < 0.6) return 'trade';
    }
    // gather intel: who holds my colour (danger) and who holds the suspect's (frame-readiness)
    if (can('spy') && brand(state) < 0.55) return 'spy';
    return pick(state, nonCops.length ? nonCops : targets);
  }

  function botSpyTarget(state, id) {
    var others = state.players.filter(function (q) { return q.id !== id; });
    return pick(state, others).id;
  }
  function botTradePartner(state, id) {
    var others = state.players.filter(function (q) { return q.id !== id; });
    return pick(state, others).id;
  }
  function botTradeGiveCard(state, id) { return bestToGive(state, id, me(state, id).hand.slice(), tierGive); }
  function botStashTakeIndex(state, id) { return ri(state, state.stash.length); }
  function botStashReturnCard(state, id) { return bestToGive(state, id, me(state, id).hand.slice(), tierStashReturn); }
  function botFrameTargetColor(state, id) { return suspectColor(state, id); }
  function botStealVictim(state, id) { return pick(state, SG.eligibleStealTargets(state)); }

  // The colour the bot is trying to push in a frame: the publicly-declared target if
  // any (everyone hears it), otherwise its own suspicion.
  function frameTarget(state, id) {
    return (state.frame && state.frame.declaredColor) ? state.frame.declaredColor : suspectColor(state, id);
  }
  function botFrameCard(state, id) {
    var own = ownColor(state, id), target = frameTarget(state, id);
    var hand = me(state, id).hand, best = hand[0], bestTier = 1e9;
    for (var i = 0; i < hand.length; i++) {
      var d = def(state, hand[i]);
      var hasT = d.colors.indexOf(target) !== -1, hasOwn = d.colors.indexOf(own) !== -1;
      var t = hasT && !hasOwn ? 0 : (hasT && hasOwn ? 1 : (!hasT && !hasOwn ? 2 : 3));
      if (t < bestTier) { bestTier = t; best = hand[i]; }
    }
    return best;
  }
  function botEvidenceSwapCard(state, id) {
    var elig = SG.eligibleSwapOutCards(state, id); // engine restricts to own-colour when mustShed
    return bestToGive(state, id, elig.slice(), tierGive);
  }

  // ---- one engine step for the CURRENT (single-actor) bot phase ----------
  // Returns true if it performed an action. Multi-actor phases (frame_select,
  // action_trade_select) are orchestrated by the caller using the per-player picks.
  function takeAction(state, id) {
    switch (state.phase) {
      case 'movement': SG.move(state, botMove(state, id)); return true;
      case 'action_spy': SG.spy(state, botSpyTarget(state, id)); afterSpy(state, id); return true;
      case 'action_spy_view': SG.spyDone(state); return true;
      case 'action_trade': SG.tradeBegin(state, botTradePartner(state, id)); return true;
      case 'action_stash': SG.stashTake(state, botStashTakeIndex(state, id)); return true;
      case 'action_stash_return': SG.stashReturn(state, botStashReturnCard(state, id)); return true;
      case 'action_prepare': SG.prepare(state); return true;
      case 'action_framesteal': {
        var p = me(state, id);
        if (p.prepTokens >= 1) {
          if (state.config.frameMode === 'declared_target') SG.frameInitiate(state, botFrameTargetColor(state, id));
          else SG.frameInitiate(state);
        } else { SG.steal(state, botStealVictim(state, id)); }
        return true;
      }
      case 'action_cops': SG.goToCops(state); return true;
      case 'frame_resolve': SG.frameAcknowledge(state); return true;
      case 'evidence_swap': SG.evidenceSwap(state, botEvidenceSwapCard(state, id)); return true;
      default: return false;
    }
  }

  return {
    // decisions
    botMove: botMove,
    botSpyTarget: botSpyTarget,
    botTradePartner: botTradePartner,
    botTradeGiveCard: botTradeGiveCard,
    botStashTakeIndex: botStashTakeIndex,
    botStashReturnCard: botStashReturnCard,
    botFrameTargetColor: botFrameTargetColor,
    botFrameCard: botFrameCard,
    botStealVictim: botStealVictim,
    botEvidenceSwapCard: botEvidenceSwapCard,
    wantsCops: wantsCops,
    dangerLevel: dangerLevel,
    readyToFrame: readyToFrame,
    // observation hooks
    afterSpy: afterSpy,
    afterFrameReveal: afterFrameReveal,
    // one-step driver
    takeAction: takeAction
  };
});
