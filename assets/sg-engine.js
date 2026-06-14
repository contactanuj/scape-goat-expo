/*
 * sg-engine.js - Scape Goat rules engine (pure, transport-agnostic).
 *
 * No DOM, no network. Deterministic given (config, seed), so it can be:
 *   - unit-tested in Node by simulating full games (tests/engine.test.js),
 *   - inlined into the pass-and-play app.html (this APK),
 *   - reused verbatim by a future "Scape Goat Online" build.
 *
 * State is a plain JSON-serializable object (survives localStorage / network sync).
 * Randomness uses a seeded PRNG stored on state.rngState so the deal + scapegoat
 * assignment are reproducible: a whole match replays from (config, seed).
 *
 * HIDDEN-INFORMATION CONTRACT (the heart of the game - read before touching the UI):
 *   - Player COLOURS are PUBLIC (every token sits on the shared board).
 *   - SECRET, and never rendered on a shared screen: who the real scapegoat is
 *     (state.scapegoatId), each player's "intel"/suspect (state.intel), and every
 *     player's HAND (player.hand).
 *   - revealInfo(state, id) returns the SAME shape for everyone (a conspirator who
 *     is told the truth and the scapegoat who is told a decoy are indistinguishable
 *     by shape) and carries NO role flag. publicState(state) is the only thing a
 *     shared screen may show. handOf()/revealInfo() must be gated behind a private
 *     "pass the device to X" handoff. trueScapegoat() is for the end screen / tests.
 *
 * Digital adaptation notes (this is the BEST way to play, not a 1:1 port):
 *   - The physical decoder dice + per-mat lookup table only exist because paper
 *     can't privately tell each player one name. The app does that directly: it
 *     secretly picks the scapegoat, tells every conspirator the truth, and tells the
 *     scapegoat a random decoy. No dice, no mats, no lookup errors.
 *   - The app owns the board, hands, the stash, face-up cards, prep tokens and the
 *     Prepare->Frame/Steal flip, and resolves frames automatically.
 *   - A FACE-UP evidence card sits beside every location except Go-to-Cops (incl. the
 *     Prepare card, whose flip side is Frame/Steal). So a steal and a FAILED frame end
 *     with a normal Evidence Swap; only a SUCCESSFUL frame or Going to the Cops end the
 *     game and skip the swap. A prep token is NOT consumed by a frame attempt.
 */
(function (root, factory) {
  var SGDeck = (typeof module !== 'undefined' && module.exports)
    ? require('./sg-deck.js')
    : (root && root.SGDeck);
  var SG = factory(SGDeck);
  if (typeof module !== 'undefined' && module.exports) module.exports = SG;
  if (root) root.SG = SG;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (SGDeck) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Static data.
  // ---------------------------------------------------------------------------
  // The 5 locations, left -> right. 'prepare' is two-faced: it shows PREPARE until
  // prepFlipped, then FRAME/STEAL. The 4 non-cop locations each hold a face-up card.
  var LOCATIONS = ['prepare', 'spy', 'trade', 'stash', 'cops'];
  var FACEUP_LOCATIONS = ['prepare', 'spy', 'trade', 'stash'];

  // Up to 8 distinct player identities (colour ids; the UI maps them to swatches).
  var COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'teal'];

  // Flavour name pool for the "Gruff Gang" of billy-goat crooks. Used only to seed a
  // fresh setup with fun, varied names (the UI shuffles + picks); fully editable. Engine
  // defaults stay "Player N" so programmatic/test behaviour is deterministic.
  var THEME_NAMES = [
    'Billy the Kid', 'Nanny McPhee', 'Vincent van Goat', 'Capricorn Capone',
    'Bill Goatstein', 'Heidi Hooves', 'Sir Bleats-a-Lot', 'Gruff McTavish',
    'The Goatfather', 'Ram Bo', 'Cashmere', 'Kid Vicious',
    'Goldie Hooves', 'Curly Horns', 'Nanny Oakley', 'Mutton Chops',
    'Billy Bonkers', 'Hoof Hearted', 'Shear Khan', 'Baa-bra Streisand'
  ];

  var DECOY_MODES = ['random_other', 'adjacent'];
  var FRAME_MODES = ['declared_target', 'auto_detect'];
  var ROTATIONS = ['random', 'clockwise', 'loser_first'];
  var ASSIST_MODES = ['off', 'hints'];

  var OUTCOMES = {
    scapegoat_escaped: 'The scapegoat noticed the trap and ran to the cops',
    cops_called_wrong: 'An innocent panicked and ran to the cops - the scapegoat walks free',
    framed_correct: 'The conspirators framed the real scapegoat',
    framed_wrong: 'An innocent was framed - the real scapegoat walks free'
  };

  var PHASES = [
    'reveal', 'movement',
    'action_spy', 'action_spy_view',
    'action_trade', 'action_trade_select',
    'action_stash', 'action_stash_return',
    'action_prepare', 'action_framesteal', 'action_cops',
    'frame_select', 'frame_resolve',
    'evidence_swap', 'round_over', 'game_over'
  ];

  // ---------------------------------------------------------------------------
  // Seeded PRNG (mulberry32) - deterministic + JSON-serializable via state.rngState.
  // ---------------------------------------------------------------------------
  function nextRand(state) {
    var t = (state.rngState = (state.rngState + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function randInt(state, n) { return Math.floor(nextRand(state) * n); }

  // ---------------------------------------------------------------------------
  // Config construction + validation.
  // ---------------------------------------------------------------------------
  function defaultNames(pc) {
    var out = [];
    for (var i = 0; i < pc; i++) out.push('Player ' + (i + 1));
    return out;
  }
  function defaultColors(pc) { return COLORS.slice(0, pc); }
  function defaultKinds(pc) { var o = []; for (var i = 0; i < pc; i++) o.push('human'); return o; }
  function handSizeFor(pc) { return pc <= 5 ? 3 : (pc === 6 ? 2 : 3); }
  var PLAYER_KINDS = ['human', 'bot'];

  function defaultConfig(playerCount, names) {
    var pc = playerCount || 4;
    return {
      playerCount: pc,
      playerNames: (names && names.slice(0, pc)) || defaultNames(pc),
      playerColors: defaultColors(pc),
      playerKinds: defaultKinds(pc),   // 'human' | 'bot' per seat (the app plays bots)

      handSize: handSizeFor(pc),
      stashSize: 3,

      deck: {
        preset: 'balanced',          // scarce | balanced | rich | chaos | custom
        spare: 1,                    // per-colour spare beyond the N-1 floor (custom)
        greyFraction: 0.16,          // share of deck that carries a grey bystander
        maxColorsPerCard: 2,         // colours per card cap (custom)
        allowThreeColor: false       // permit 3-colour cards (chaos / custom)
      },

      mustMoveEachTurn: true,        // you must move to a different location each turn
      enforceDumpOwnColor: true,     // must swap away a card showing your own colour if you hold one
      prepTokens: 2,                 // preparation tokens on the Prepare card
      flipThreshold: 2,              // tokens taken before Prepare flips to Frame/Steal

      scapegoat: {
        decoyMode: 'random_other',   // who the scapegoat is (mis)told is the scapegoat
        beginnerAssist: 'off'        // 'hints' adds a gentle, leak-safe own-colour counter
      },

      frameMode: 'declared_target',  // declared_target (clean) | auto_detect (from cards)

      cops: {
        sixPlayerInterrupt: (pc === 6), // run to the cops on the turn of the player N seats to your left
        interruptSeatsLeft: 3
      },

      scoring: {
        enabled: false,              // false = single heist (the box default)
        winTarget: 3,                // first to N points wins the series
        scoreEscape: 2,              // scapegoat reaches the cops
        scoreFrameRight: 1,          // conspirators frame the real scapegoat
        scoreFrameWrong: 2,          // scapegoat wins big when an innocent is framed
        rotateScapegoat: 'loser_first'
      },

      revealAllAtEnd: true,
      publicEventLog: true,
      turnTimerSec: 0,
      autoHideSeconds: 7        // private reveals (intel + recheck) auto-hide after N seconds
    };
  }

  // Returns { ok, errors:[], warnings:[] }. errors block starting a game (illegal /
  // breakable / unwinnable); warnings are off-spec but still playable.
  function validateConfig(config) {
    var errors = [], warnings = [];
    var c = config;
    if (!c || typeof c !== 'object') return { ok: false, errors: ['No configuration provided.'], warnings: [] };

    var pc = c.playerCount;
    if (!(pc >= 3)) errors.push('Scape Goat needs at least 3 players.');
    else if (pc < 4 || pc > 6) warnings.push('Player count ' + pc + ' is outside the official 4-6 range - playable, but balance is untested.');

    // Colours: one distinct colour per player.
    var cols = c.playerColors || [];
    if (cols.length !== pc) errors.push('You have ' + cols.length + ' colour(s) but ' + pc + ' player(s).');
    var seenCol = {};
    for (var ci = 0; ci < cols.length; ci++) {
      if (seenCol[cols[ci]]) errors.push('Two players share the colour "' + cols[ci] + '" - frames would be ambiguous.');
      seenCol[cols[ci]] = true;
    }

    // Names: one per player, non-empty (duplicates are only a warning).
    var names = c.playerNames || [];
    if (names.length !== pc) errors.push('You have ' + names.length + ' name(s) but ' + pc + ' player(s).');
    var seen = {};
    for (var i = 0; i < names.length; i++) {
      var nm = (names[i] || '').trim();
      if (!nm) { errors.push('Every player needs a name (player ' + (i + 1) + ' is blank).'); continue; }
      var key = nm.toLowerCase();
      if (seen[key]) warnings.push('Duplicate name "' + nm + '" - players may be hard to tell apart.');
      seen[key] = true;
    }

    // Player kinds (human / bot).
    var kinds = c.playerKinds || [];
    if (kinds.length !== pc) errors.push('You have ' + kinds.length + ' player kind(s) but ' + pc + ' player(s).');
    var humans = 0;
    for (var ki = 0; ki < kinds.length; ki++) {
      if (PLAYER_KINDS.indexOf(kinds[ki]) === -1) errors.push('Player kind must be "human" or "bot".');
      if (kinds[ki] === 'human') humans++;
    }
    if (kinds.length === pc && humans === 0) warnings.push('Every seat is a bot - the game will play itself as a demo.');
    if (kinds.length === pc && humans === 1) warnings.push('Only one human - fun for practice against bots, but social deduction shines with more people.');

    if (!(c.handSize >= 1)) errors.push('Each player needs at least 1 card in hand.');
    else if (c.handSize !== handSizeFor(pc)) warnings.push('Hand size ' + c.handSize + ' differs from the suggested ' + handSizeFor(pc) + ' for ' + pc + ' players - balance untested.');
    if (!(c.stashSize >= 1)) errors.push('The stash needs at least 1 card (the Stash action draws from it).');

    if (!(c.prepTokens >= 1)) errors.push('There must be at least 1 preparation token, or the board never flips to Frame/Steal.');
    if (!(c.flipThreshold >= 1)) errors.push('The flip threshold must be at least 1.');
    else if (c.flipThreshold > c.prepTokens) errors.push('The board flips after ' + c.flipThreshold + ' tokens are taken, but there are only ' + c.prepTokens + ' - it could never flip, so no frame could ever happen.');
    else if (c.prepTokens > c.flipThreshold) warnings.push('There are more preparation tokens (' + c.prepTokens + ') than needed to flip (' + c.flipThreshold + '); the extras become unreachable once the board flips.');
    if (c.prepTokens > pc) warnings.push('More preparation tokens than players is unusual.');

    if (FRAME_MODES.indexOf(c.frameMode) === -1) errors.push('Frame mode must be one of: declared_target, auto_detect.');
    if (c.scapegoat && DECOY_MODES.indexOf(c.scapegoat.decoyMode) === -1) errors.push('Decoy mode must be one of: random_other, adjacent.');
    if (c.scapegoat && ASSIST_MODES.indexOf(c.scapegoat.beginnerAssist) === -1) errors.push('Beginner assist must be one of: off, hints.');
    if (c.deck && SGDeck.DECK_PRESETS.indexOf(c.deck.preset) === -1) errors.push('Deck preset must be one of: ' + SGDeck.DECK_PRESETS.join(', ') + '.');

    // Cops interrupt range.
    if (c.cops && c.cops.sixPlayerInterrupt) {
      if (!(c.cops.interruptSeatsLeft >= 1 && c.cops.interruptSeatsLeft <= pc - 1)) {
        errors.push('The cops interrupt offset must be between 1 and ' + (pc - 1) + '.');
      }
      if (pc !== 6) warnings.push('The out-of-turn cops interrupt is officially a 6-player rule.');
    }

    // Deck feasibility - the load-bearing check: every colour must appear on >= N-1
    // cards or that player can never be framed (and if they are the scapegoat, the
    // conspirators literally cannot win).
    if (errors.length === 0 || (cols.length === pc && c.handSize >= 1 && c.stashSize >= 1)) {
      try {
        var composed = SGDeck.composeDeck(c);
        var st = composed.stats;
        if (!st.feasible || st.minIncidence < pc - 1) {
          errors.push('The deck cannot give every player ' + (pc - 1) + ' evidence cards (needed to frame them). Increase hand size, lower the player count, or raise the deck colour cap.');
        } else {
          if (st.maxIncidence >= pc + 2) warnings.push('Some colour appears on ' + st.maxIncidence + ' cards - framing that player may be too easy, leaving the scapegoat little chance.');
          if (st.minIncidence === pc - 1) warnings.push('Every colour sits at the bare minimum (' + (pc - 1) + ' cards) - frames will be hard to assemble; expect long games.');
          if ((c.deck && c.deck.greyFraction > 0) && st.greyCards === 0) warnings.push('No room for grey bystander cards at this count - the scapegoat loses an easy safe card to shed.');
        }
      } catch (e) {
        errors.push('Deck could not be generated for this configuration.');
      }
    }

    if (c.enforceDumpOwnColor === false) warnings.push('House rule: not forcing players to shed their own colour makes the scapegoat far harder to catch.');
    if (c.frameMode === 'auto_detect' && SGDeck.effectiveMaxColors(c, SGDeck.presetKnobs(c)) >= 3) warnings.push('Auto-detect framing with 3-colour cards can resolve in surprising ways - declared-target is clearer.');

    if (c.scoring && c.scoring.enabled) {
      if (ROTATIONS.indexOf(c.scoring.rotateScapegoat) === -1) errors.push('Scapegoat rotation must be one of: random, clockwise, loser_first.');
      if (!(c.scoring.winTarget >= 1)) errors.push('The series win target must be at least 1 point.');
      else if (c.scoring.winTarget > 10) warnings.push('A win target above 10 makes for a very long series.');
      if (!(c.scoring.scoreEscape >= 0) || !(c.scoring.scoreFrameRight >= 0) || !(c.scoring.scoreFrameWrong >= 0)) errors.push('Point values cannot be negative.');
      else if (c.scoring.scoreEscape === 0 && c.scoring.scoreFrameRight === 0 && c.scoring.scoreFrameWrong === 0) warnings.push('All point values are 0 - nobody can ever win the series.');
    }

    if (c.turnTimerSec > 0 && c.turnTimerSec < 15) warnings.push('A turn timer under 15 seconds may frustrate players.');
    if (!(c.autoHideSeconds >= 1)) errors.push('Auto-hide seconds must be at least 1.');
    else if (c.autoHideSeconds < 3) warnings.push('Auto-hiding the secret in under 3 seconds may be too fast to read.');

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  // ---------------------------------------------------------------------------
  // Helpers.
  // ---------------------------------------------------------------------------
  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
  function uid(i) { return 'p' + i; }
  function getPlayer(state, id) {
    for (var i = 0; i < state.players.length; i++) if (state.players[i].id === id) return state.players[i];
    return null;
  }
  function nameOf(state, id) { var p = getPlayer(state, id); return p ? p.name : '?'; }
  function colorOf(state, id) { var p = getPlayer(state, id); return p ? p.color : null; }
  function seatOf(state, id) { var p = getPlayer(state, id); return p ? p.seat : -1; }
  function currentPlayer(state) { return getPlayer(state, state.currentPlayerId); }
  function pushLog(state, text) { state.log.push({ round: state.round, text: text }); }
  function ownerOfColor(state, color) {
    for (var i = 0; i < state.players.length; i++) if (state.players[i].color === color) return state.players[i].id;
    return null;
  }
  function cardDef(state, cardId) { return state.cards[cardId]; }
  function cardContainsColor(state, cardId, color) {
    var d = state.cards[cardId];
    return !!d && d.colors.indexOf(color) !== -1;
  }
  function isScapegoat(state, id) { return state.scapegoatId === id; } // internal / tests only
  function isBot(state, id) { var p = getPlayer(state, id); return !!p && p.kind === 'bot'; }
  function currentIsBot(state) { return isBot(state, state.currentPlayerId); }

  // ---------------------------------------------------------------------------
  // Lifecycle.
  // ---------------------------------------------------------------------------
  function newGame(config, seed) {
    var state = {
      config: deepClone(config),
      rngState: (seed >>> 0) || 1,
      players: [],
      cards: {},
      faceup: {},
      stash: [],
      scapegoatId: null,
      intel: {},
      prepFlipped: false,
      prepTokensRemaining: 0,
      round: 1,
      seriesRound: 1,
      turnIndex: 0,
      currentPlayerId: null,
      phase: 'reveal',
      movedTo: null,
      trade: null,
      spy: null,
      frame: null,
      stashAction: null,
      swap: null,
      outcome: null,
      winner: null,            // 'conspirators' | 'scapegoat'
      winReason: '',
      framedId: null,
      copsCallerId: null,
      lastFrame: null,
      scores: {},
      matchWinnerIds: null,
      suspicions: null,
      botMemory: {},           // per-bot private observation memory (owned by sg-bot.js)
      log: []
    };

    var names = config.playerNames, cols = config.playerColors, kinds = config.playerKinds || [];
    for (var i = 0; i < names.length; i++) {
      var id = uid(i);
      state.players.push({ id: id, name: names[i], color: cols[i], seat: i, kind: (kinds[i] === 'bot' ? 'bot' : 'human'), location: null, hand: [], prepTokens: 0 });
      state.scores[id] = 0;
    }

    dealAndAssign(state, true);
    return state;
  }

  // (Re)deal the board, assign the scapegoat + everyone's intel, reset the turn.
  // firstRound keeps things simple; series rounds rotate the scapegoat.
  function dealAndAssign(state, firstRound) {
    var config = state.config;
    var players = state.players;
    var N = players.length;

    // Reset bot memory (the bot module owns the contents; engine just clears it).
    state.botMemory = {};

    // Reset board / per-round.
    state.cards = {};
    state.faceup = {};
    state.stash = [];
    state.prepFlipped = false;
    state.prepTokensRemaining = config.prepTokens;
    state.movedTo = null;
    state.trade = state.spy = state.frame = state.stashAction = state.swap = null;
    state.outcome = null;
    state.winner = null;
    state.winReason = '';
    state.framedId = null;
    state.copsCallerId = null;
    state.lastFrame = null;
    state.suspicions = null;
    for (var p = 0; p < N; p++) { players[p].hand = []; players[p].prepTokens = 0; players[p].location = FACEUP_LOCATIONS[p % FACEUP_LOCATIONS.length]; }

    // Build + deal the deck (closed economy: deckSize == N*H + 4 + stashSize).
    var deck = SGDeck.synthesizeDeck(config, state);
    for (var d = 0; d < deck.length; d++) state.cards[deck[d].id] = deck[d];
    var idx = 0;
    for (var h = 0; h < N; h++) {
      for (var k = 0; k < config.handSize; k++) players[h].hand.push(deck[idx++].id);
    }
    for (var f = 0; f < FACEUP_LOCATIONS.length; f++) state.faceup[FACEUP_LOCATIONS[f]] = deck[idx++].id;
    for (var s = 0; s < config.stashSize; s++) state.stash.push(deck[idx++].id);

    // Assign the scapegoat + intel.
    assignScapegoat(state, firstRound);

    // First player is the one on the Prepare location (seat 0 by placement).
    state.turnIndex = 0;
    state.currentPlayerId = players[0].id;
    state.phase = 'reveal';
  }

  function assignScapegoat(state, firstRound) {
    var players = state.players, N = players.length, config = state.config;
    var prevScapegoat = state.scapegoatId;

    var sgIdx;
    if (firstRound || !config.scoring || !config.scoring.enabled) {
      sgIdx = randInt(state, N);
    } else {
      switch (config.scoring.rotateScapegoat) {
        case 'clockwise':
          sgIdx = (seatOf(state, prevScapegoat) + 1) % N; break;
        case 'loser_first':
          // Anyone but the previous scapegoat (keeps the fun role moving around).
          do { sgIdx = randInt(state, N); } while (N > 1 && players[sgIdx].id === prevScapegoat);
          break;
        default:
          sgIdx = randInt(state, N);
      }
    }
    state.scapegoatId = players[sgIdx].id;

    // Conspirators are told the TRUTH; the scapegoat is told a DECOY (a random other
    // player). Same field for everyone -> nobody can tell their role from their intel.
    state.intel = {};
    for (var i = 0; i < N; i++) {
      var pid = players[i].id;
      if (pid !== state.scapegoatId) {
        state.intel[pid] = state.scapegoatId;
      } else {
        state.intel[pid] = pickDecoy(state, pid);
      }
    }
  }

  function pickDecoy(state, scapegoatId) {
    var players = state.players, N = players.length;
    if (state.config.scapegoat && state.config.scapegoat.decoyMode === 'adjacent') {
      return players[(seatOf(state, scapegoatId) + 1) % N].id; // never self
    }
    // random_other: any player except the scapegoat themselves.
    var pool = [];
    for (var i = 0; i < N; i++) if (players[i].id !== scapegoatId) pool.push(players[i].id);
    return pool[randInt(state, pool.length)];
  }

  function beginPlay(state) {
    state.phase = 'movement';
    pushLog(state, 'The heist is done. ' + nameOf(state, state.currentPlayerId) + ' takes the first turn.');
    return state;
  }

  // ---------------------------------------------------------------------------
  // Queries (UI + tests).
  // ---------------------------------------------------------------------------
  function eligibleMoveTargets(state) {
    var cur = currentPlayer(state);
    var out = [];
    for (var i = 0; i < LOCATIONS.length; i++) {
      if (state.config.mustMoveEachTurn && LOCATIONS[i] === cur.location) continue;
      out.push(LOCATIONS[i]);
    }
    return out;
  }

  function eligibleStealTargets(state) {
    var cur = currentPlayer(state);
    return state.players.filter(function (p) { return p.id !== cur.id && p.prepTokens > 0; }).map(function (p) { return p.id; });
  }

  // Who (if anyone) may run to the cops out of turn right now (6-player rule).
  function copsInterrupters(state) {
    var c = state.config;
    if (!c.cops || !c.cops.sixPlayerInterrupt || state.phase !== 'movement') return [];
    var N = state.players.length;
    var targetSeat = ((state.turnIndex - c.cops.interruptSeatsLeft) % N + N) % N;
    var out = [];
    for (var i = 0; i < N; i++) {
      if (state.players[i].seat === targetSeat && state.players[i].id !== state.currentPlayerId) out.push(state.players[i].id);
    }
    return out;
  }

  function mustShedOwnColor(state, playerId) {
    var p = getPlayer(state, playerId);
    for (var i = 0; i < p.hand.length; i++) if (cardContainsColor(state, p.hand[i], p.color)) return true;
    return false;
  }

  function eligibleSwapOutCards(state, playerId) {
    var p = getPlayer(state, playerId);
    if (state.config.enforceDumpOwnColor && mustShedOwnColor(state, playerId)) {
      return p.hand.filter(function (cid) { return cardContainsColor(state, cid, p.color); });
    }
    return p.hand.slice();
  }

  // Private per-player view. IDENTICAL SHAPE for conspirator and scapegoat; NO role flag.
  function revealInfo(state, playerId) {
    var me = getPlayer(state, playerId);
    var hand = me.hand.map(function (cid) { return deepClone(state.cards[cid]); });
    var visibleOwnColor = 0; // leak-safe assist: only counts what THIS player can already see
    if (state.config.scapegoat && state.config.scapegoat.beginnerAssist === 'hints') {
      for (var i = 0; i < me.hand.length; i++) if (cardContainsColor(state, me.hand[i], me.color)) visibleOwnColor++;
      for (var f = 0; f < FACEUP_LOCATIONS.length; f++) {
        if (cardContainsColor(state, state.faceup[FACEUP_LOCATIONS[f]], me.color)) visibleOwnColor++;
      }
    }
    return {
      you: { id: me.id, name: me.name, color: me.color },
      suspectId: state.intel[playerId],
      suspectName: nameOf(state, state.intel[playerId]),
      hand: hand,
      visibleOwnColor: visibleOwnColor
    };
  }

  // The ONLY snapshot a shared screen may render. No scapegoatId, no intel, no hands.
  function publicState(state) {
    var faceup = {};
    for (var f = 0; f < FACEUP_LOCATIONS.length; f++) faceup[FACEUP_LOCATIONS[f]] = deepClone(state.cards[state.faceup[FACEUP_LOCATIONS[f]]]);
    return {
      round: state.round,
      seriesRound: state.seriesRound,
      phase: state.phase,
      currentPlayerId: state.currentPlayerId,
      movedTo: state.movedTo,
      prepFlipped: state.prepFlipped,
      prepTokensRemaining: state.prepTokensRemaining,
      faceup: faceup,
      stashCount: state.stash.length,
      players: state.players.map(function (p) {
        return { id: p.id, name: p.name, color: p.color, seat: p.seat, kind: p.kind, location: p.location, handCount: p.hand.length, prepTokens: p.prepTokens };
      }),
      scores: deepClone(state.scores)
    };
  }

  function handOf(state, playerId) { // gated: only behind a private handoff (spy / own reveal)
    var p = getPlayer(state, playerId);
    return p.hand.map(function (cid) { return deepClone(state.cards[cid]); });
  }

  function trueScapegoat(state) { // end screen / tests only
    return {
      id: state.scapegoatId,
      name: nameOf(state, state.scapegoatId),
      decoyId: state.intel[state.scapegoatId],
      decoyName: nameOf(state, state.intel[state.scapegoatId])
    };
  }

  // ---------------------------------------------------------------------------
  // Turn: 1. Movement.
  // ---------------------------------------------------------------------------
  function move(state, loc) {
    if (state.phase !== 'movement') throw new Error('Not in the movement phase.');
    if (LOCATIONS.indexOf(loc) === -1) throw new Error('Unknown location "' + loc + '".');
    var cur = currentPlayer(state);
    if (state.config.mustMoveEachTurn && loc === cur.location) throw new Error('You must move to a different location.');
    cur.location = loc;
    state.movedTo = loc;

    if (loc === 'spy') state.phase = 'action_spy';
    else if (loc === 'trade') state.phase = 'action_trade';
    else if (loc === 'stash') state.phase = 'action_stash';
    else if (loc === 'cops') state.phase = 'action_cops';
    else if (loc === 'prepare') state.phase = state.prepFlipped ? 'action_framesteal' : 'action_prepare';
    pushLog(state, nameOf(state, cur.id) + ' moved to ' + locLabel(loc) + '.');
    return state;
  }

  function locLabel(loc) {
    return { prepare: 'Prepare', spy: 'Spy', trade: 'Trade', stash: 'Stash', cops: 'the Cops' }[loc] || loc;
  }

  // ---------------------------------------------------------------------------
  // Turn: 2. Action - Spy.
  // ---------------------------------------------------------------------------
  function spy(state, targetId) {
    if (state.phase !== 'action_spy') throw new Error('Not at the Spy location.');
    var cur = currentPlayer(state);
    if (targetId === cur.id) throw new Error('Spy on someone else.');
    if (!getPlayer(state, targetId)) throw new Error('Unknown player.');
    state.spy = { viewerId: cur.id, targetId: targetId };
    state.phase = 'action_spy_view';
    pushLog(state, nameOf(state, cur.id) + ' spied on ' + nameOf(state, targetId) + '’s hand.');
    return state;
  }
  function spyDone(state) {
    if (state.phase !== 'action_spy_view') throw new Error('Not viewing a spied hand.');
    state.spy = null;
    enterEvidenceSwap(state);
    return state;
  }

  // ---------------------------------------------------------------------------
  // Turn: 2. Action - Trade (two private selections, then a simultaneous swap).
  // ---------------------------------------------------------------------------
  function tradeBegin(state, partnerId) {
    if (state.phase !== 'action_trade') throw new Error('Not at the Trade location.');
    var cur = currentPlayer(state);
    if (partnerId === cur.id) throw new Error('Trade with someone else.');
    var partner = getPlayer(state, partnerId);
    if (!partner) throw new Error('Unknown player.');
    state.trade = { initiatorId: cur.id, partnerId: partnerId, initiatorCard: null, partnerCard: null };
    state.phase = 'action_trade_select';
    return state;
  }
  function tradeSelect(state, playerId, cardId) {
    if (state.phase !== 'action_trade_select') throw new Error('Not selecting a trade card.');
    var t = state.trade;
    var p = getPlayer(state, playerId);
    if (!p || p.hand.indexOf(cardId) === -1) throw new Error('You can only give a card from your own hand.');
    if (playerId === t.initiatorId) t.initiatorCard = cardId;
    else if (playerId === t.partnerId) t.partnerCard = cardId;
    else throw new Error('You are not part of this trade.');
    return state;
  }
  function allTradePicksIn(state) {
    return !!(state.trade && state.trade.initiatorCard && state.trade.partnerCard);
  }
  function tradeCommit(state) {
    if (state.phase !== 'action_trade_select') throw new Error('Not in a trade.');
    if (!allTradePicksIn(state)) throw new Error('Both players must choose a card first.');
    var t = state.trade;
    var a = getPlayer(state, t.initiatorId), b = getPlayer(state, t.partnerId);
    a.hand.splice(a.hand.indexOf(t.initiatorCard), 1);
    b.hand.splice(b.hand.indexOf(t.partnerCard), 1);
    a.hand.push(t.partnerCard);
    b.hand.push(t.initiatorCard);
    pushLog(state, nameOf(state, t.initiatorId) + ' and ' + nameOf(state, t.partnerId) + ' traded a card.');
    state.trade = null;
    enterEvidenceSwap(state);
    return state;
  }

  // ---------------------------------------------------------------------------
  // Turn: 2. Action - Stash (take one facedown, then return one).
  // ---------------------------------------------------------------------------
  function stashTake(state, index) {
    if (state.phase !== 'action_stash') throw new Error('Not at the Stash location.');
    if (!(index >= 0 && index < state.stash.length)) throw new Error('Invalid stash card.');
    var cur = currentPlayer(state);
    var taken = state.stash.splice(index, 1)[0];
    cur.hand.push(taken);
    state.stashAction = { takenId: taken };
    state.phase = 'action_stash_return';
    return state;
  }
  function stashReturn(state, cardId) {
    if (state.phase !== 'action_stash_return') throw new Error('Not returning a stash card.');
    var cur = currentPlayer(state);
    var at = cur.hand.indexOf(cardId);
    if (at === -1) throw new Error('You can only return a card from your hand (you may return the one you took).');
    cur.hand.splice(at, 1);
    state.stash.push(cardId);
    state.stashAction = null;
    pushLog(state, nameOf(state, cur.id) + ' used the Stash.');
    enterEvidenceSwap(state);
    return state;
  }

  // ---------------------------------------------------------------------------
  // Turn: 2. Action - Prepare (take a token; flip the board at the threshold).
  // ---------------------------------------------------------------------------
  function prepare(state) {
    if (state.phase !== 'action_prepare') throw new Error('Not at the Prepare location (or it has already flipped).');
    var cur = currentPlayer(state);
    if (state.prepTokensRemaining <= 0) throw new Error('No preparation tokens left to take.');
    cur.prepTokens++;
    state.prepTokensRemaining--;
    var taken = state.config.prepTokens - state.prepTokensRemaining;
    pushLog(state, nameOf(state, cur.id) + ' took a preparation token.');
    if (!state.prepFlipped && taken >= state.config.flipThreshold) {
      state.prepFlipped = true;
      pushLog(state, 'The board flips to FRAME / STEAL - the heist can now be pinned on someone.');
    }
    enterEvidenceSwap(state);
    return state;
  }

  // ---------------------------------------------------------------------------
  // Turn: 2. Action - Frame / Steal (only after the flip).
  // ---------------------------------------------------------------------------
  function frameInitiate(state, declaredColor) {
    if (state.phase !== 'action_framesteal') throw new Error('Frame/Steal is not available yet.');
    var cur = currentPlayer(state);
    if (cur.prepTokens < 1) throw new Error('You need a preparation token to initiate a frame (otherwise steal one).');
    var declared = null;
    if (state.config.frameMode === 'declared_target') {
      if (state.config.playerColors.indexOf(declaredColor) === -1) throw new Error('Declare a valid colour to frame.');
      if (declaredColor === cur.color) throw new Error('You would not frame yourself.');
      declared = declaredColor;
    }
    state.frame = {
      initiatorId: cur.id,
      declaredColor: declared,
      participantIds: state.players.map(function (p) { return p.id; }),
      picks: {},
      revealed: false
    };
    state.phase = 'frame_select';
    pushLog(state, nameOf(state, cur.id) + ' initiated a FRAME ATTEMPT' + (declared ? ' (declaring "' + declared + '")' : '') + '. Everyone picks a card.');
    return state;
  }
  function frameSelect(state, playerId, cardId) {
    if (state.phase !== 'frame_select') throw new Error('No frame attempt in progress.');
    var p = getPlayer(state, playerId);
    if (!p || p.hand.indexOf(cardId) === -1) throw new Error('Pick a card from your own hand.');
    state.frame.picks[playerId] = cardId;
    return state;
  }
  function allFramePicksIn(state) {
    if (!state.frame) return false;
    for (var i = 0; i < state.frame.participantIds.length; i++) {
      if (!state.frame.picks[state.frame.participantIds[i]]) return false;
    }
    return true;
  }

  // A colour C frames its owner iff the owner participated AND every OTHER participant
  // revealed a card containing C. The owner's own card is exempt (they shed their colour).
  function colorQualifies(state, color) {
    var owner = ownerOfColor(state, color);
    if (!owner || !state.frame.picks[owner]) return false;
    var ids = state.frame.participantIds;
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] === owner) continue;
      if (!cardContainsColor(state, state.frame.picks[ids[i]], color)) return false;
    }
    return true;
  }

  function frameResolve(state) {
    if (state.phase !== 'frame_select') throw new Error('No frame attempt to resolve.');
    if (!allFramePicksIn(state)) throw new Error('Everyone must pick a card first.');
    state.frame.revealed = true;

    var framedColor = null;
    if (state.config.frameMode === 'declared_target') {
      framedColor = colorQualifies(state, state.frame.declaredColor) ? state.frame.declaredColor : null;
    } else {
      var qualifying = [];
      for (var i = 0; i < state.config.playerColors.length; i++) {
        if (colorQualifies(state, state.config.playerColors[i])) qualifying.push(state.config.playerColors[i]);
      }
      framedColor = (qualifying.length === 1) ? qualifying[0] : null; // ambiguity => fails
    }

    state.lastFrame = {
      initiatorId: state.frame.initiatorId,
      declaredColor: state.frame.declaredColor,
      picks: deepClone(state.frame.picks),
      framedColor: framedColor,
      framedId: framedColor ? ownerOfColor(state, framedColor) : null,
      success: !!framedColor
    };

    if (!framedColor) {
      pushLog(state, 'The frame attempt FAILED - no single colour was on everyone else’s card.');
      state.frame = null;
      state.phase = 'frame_resolve'; // a screen to show the failed reveal before continuing
      return state;
    }

    var framedId = ownerOfColor(state, framedColor);
    state.framedId = framedId;
    if (framedId === state.scapegoatId) {
      return concludeRound(state, 'framed_correct', 'The conspirators framed ' + nameOf(state, framedId) + ' - the real scapegoat!');
    }
    return concludeRound(state, 'framed_wrong', nameOf(state, framedId) + ' was framed, but they were innocent - the real scapegoat walks free!');
  }

  function frameAcknowledge(state) {
    if (state.phase !== 'frame_resolve') throw new Error('No failed frame to acknowledge.');
    enterEvidenceSwap(state); // the framer still completes their turn with an evidence swap
    return state;
  }

  function steal(state, victimId) {
    if (state.phase !== 'action_framesteal') throw new Error('Frame/Steal is not available yet.');
    var cur = currentPlayer(state);
    if (cur.prepTokens >= 1) throw new Error('You hold a preparation token, so you must frame, not steal.');
    var victim = getPlayer(state, victimId);
    if (!victim || victim.id === cur.id || victim.prepTokens < 1) throw new Error('Pick a player who holds a preparation token.');
    victim.prepTokens--;
    cur.prepTokens++;
    pushLog(state, nameOf(state, cur.id) + ' stole a preparation token from ' + nameOf(state, victimId) + '.');
    enterEvidenceSwap(state);
    return state;
  }

  // ---------------------------------------------------------------------------
  // Turn: 2. Action - Go to the Cops (ends the game; the scapegoat wins).
  // ---------------------------------------------------------------------------
  function goToCops(state) {
    if (state.phase !== 'action_cops') throw new Error('You must move to the Cops location first.');
    return resolveCops(state, state.currentPlayerId);
  }
  function goToCopsInterrupt(state, interrupterId) {
    if (copsInterrupters(state).indexOf(interrupterId) === -1) throw new Error('You cannot run to the cops right now.');
    return resolveCops(state, interrupterId);
  }
  function resolveCops(state, callerId) {
    state.copsCallerId = callerId;
    var outcome = (callerId === state.scapegoatId) ? 'scapegoat_escaped' : 'cops_called_wrong';
    return concludeRound(state, outcome, nameOf(state, callerId) + ' ran to the cops. ' +
      (callerId === state.scapegoatId ? 'They were the scapegoat - they escape!' : 'They were NOT the scapegoat - but the scapegoat still walks free!'));
  }

  // ---------------------------------------------------------------------------
  // Turn: 3. Evidence Swap (swap one hand card with the face-up card here).
  // ---------------------------------------------------------------------------
  function enterEvidenceSwap(state) {
    var loc = state.movedTo;
    if (FACEUP_LOCATIONS.indexOf(loc) === -1) { // no face-up card here (cops) -> shouldn't happen
      return nextTurn(state);
    }
    state.swap = { playerId: state.currentPlayerId, mustShed: mustShedOwnColor(state, state.currentPlayerId) };
    state.phase = 'evidence_swap';
    return state;
  }
  function evidenceSwap(state, handCardId) {
    if (state.phase !== 'evidence_swap') throw new Error('Not in the evidence-swap phase.');
    var cur = currentPlayer(state);
    var at = cur.hand.indexOf(handCardId);
    if (at === -1) throw new Error('Swap a card from your own hand.');
    if (state.config.enforceDumpOwnColor && mustShedOwnColor(state, cur.id) && !cardContainsColor(state, handCardId, cur.color)) {
      throw new Error('You hold your own colour and must swap one of those cards out.');
    }
    var loc = state.movedTo;
    var faceCard = state.faceup[loc];
    cur.hand.splice(at, 1);
    cur.hand.push(faceCard);
    state.faceup[loc] = handCardId;
    state.swap = null;
    pushLog(state, nameOf(state, cur.id) + ' swapped evidence at ' + locLabel(loc) + '.');
    return nextTurn(state);
  }

  // ---------------------------------------------------------------------------
  // Turn advance.
  // ---------------------------------------------------------------------------
  function nextTurn(state) {
    if (state.winner) return state;
    var N = state.players.length;
    state.turnIndex = (state.turnIndex + 1) % N;
    if (state.turnIndex === 0) state.round++;
    state.currentPlayerId = state.players[state.turnIndex].id;
    state.movedTo = null;
    state.trade = state.spy = state.frame = state.stashAction = state.swap = null;
    state.phase = 'movement';
    return state;
  }

  // ---------------------------------------------------------------------------
  // Round / match conclusion + scoring.
  // ---------------------------------------------------------------------------
  function concludeRound(state, outcome, message) {
    state.outcome = outcome;
    state.winner = (outcome === 'framed_correct') ? 'conspirators' : 'scapegoat';
    state.winReason = OUTCOMES[outcome];
    pushLog(state, message);

    var c = state.config;
    if (c.scoring && c.scoring.enabled) {
      applyScoring(state, outcome);
      var leaders = matchLeaders(state);
      if (leaders.atTarget.length > 0) {
        state.matchWinnerIds = leaders.atTarget;
        state.phase = 'game_over';
        pushLog(state, 'Series over - ' + leaders.atTarget.map(function (id) { return nameOf(state, id); }).join(', ') + ' reached ' + c.scoring.winTarget + ' points.');
      } else {
        state.phase = 'round_over';
      }
    } else {
      state.phase = 'game_over';
    }
    return state;
  }

  function applyScoring(state, outcome) {
    var c = state.config.scoring;
    var add = {};
    state.players.forEach(function (p) { add[p.id] = 0; });
    if (outcome === 'scapegoat_escaped' || outcome === 'cops_called_wrong') {
      add[state.scapegoatId] += c.scoreEscape;
    } else if (outcome === 'framed_wrong') {
      add[state.scapegoatId] += c.scoreFrameWrong;
    } else if (outcome === 'framed_correct') {
      state.players.forEach(function (p) { if (p.id !== state.scapegoatId) add[p.id] += c.scoreFrameRight; });
    }
    for (var id in add) if (add.hasOwnProperty(id)) state.scores[id] += add[id];
    state.roundScores = add;
  }

  function matchLeaders(state) {
    var c = state.config.scoring;
    var max = -Infinity, atMax = [], atTarget = [];
    state.players.forEach(function (p) {
      var s = state.scores[p.id];
      if (s > max) { max = s; atMax = [p.id]; }
      else if (s === max) atMax.push(p.id);
    });
    if (c && c.enabled) atMax.forEach(function (id) { if (state.scores[id] >= c.winTarget) atTarget.push(id); });
    return { max: max, atMax: atMax, atTarget: atTarget };
  }

  function standings(state) {
    return state.players.map(function (p) { return { id: p.id, name: p.name, color: p.color, score: state.scores[p.id] }; })
      .sort(function (a, b) { return b.score - a.score; });
  }

  // Next round of a series (scores persist; scapegoat rotates).
  function nextRound(state) {
    if (state.phase === 'game_over') throw new Error('The series is over.');
    if (!(state.config.scoring && state.config.scoring.enabled)) throw new Error('Single-heist games have no next round (use rematch).');
    state.round++;
    state.seriesRound++;
    dealAndAssign(state, false);
    pushLog(state, 'New heist (round ' + state.seriesRound + ').');
    return state;
  }

  // Fresh game, same players & config (scores reset).
  function rematch(state, seed) { return newGame(state.config, seed); }

  // Optional pre-reveal secret suspicion poll (for end-screen banter). Leak-safe:
  // collected privately, only surfaced at game over.
  function recordSuspicion(state, playerId, suspectId) {
    if (!state.suspicions) state.suspicions = {};
    state.suspicions[playerId] = suspectId;
    return state;
  }

  return {
    // constants
    LOCATIONS: LOCATIONS,
    FACEUP_LOCATIONS: FACEUP_LOCATIONS,
    COLORS: COLORS,
    THEME_NAMES: THEME_NAMES,
    DECOY_MODES: DECOY_MODES,
    FRAME_MODES: FRAME_MODES,
    ROTATIONS: ROTATIONS,
    ASSIST_MODES: ASSIST_MODES,
    PLAYER_KINDS: PLAYER_KINDS,
    OUTCOMES: OUTCOMES,
    PHASES: PHASES,
    // config
    defaultConfig: defaultConfig,
    defaultNames: defaultNames,
    defaultColors: defaultColors,
    defaultKinds: defaultKinds,
    handSizeFor: handSizeFor,
    validateConfig: validateConfig,
    // lifecycle
    newGame: newGame,
    beginPlay: beginPlay,
    nextRound: nextRound,
    rematch: rematch,
    // queries
    getPlayer: getPlayer,
    nameOf: nameOf,
    colorOf: colorOf,
    seatOf: seatOf,
    currentPlayer: currentPlayer,
    isScapegoat: isScapegoat,
    isBot: isBot,
    currentIsBot: currentIsBot,
    ownerOfColor: ownerOfColor,
    cardContainsColor: cardContainsColor,
    eligibleMoveTargets: eligibleMoveTargets,
    eligibleStealTargets: eligibleStealTargets,
    copsInterrupters: copsInterrupters,
    mustShedOwnColor: mustShedOwnColor,
    eligibleSwapOutCards: eligibleSwapOutCards,
    allTradePicksIn: allTradePicksIn,
    allFramePicksIn: allFramePicksIn,
    revealInfo: revealInfo,
    publicState: publicState,
    handOf: handOf,
    trueScapegoat: trueScapegoat,
    standings: standings,
    matchLeaders: matchLeaders,
    // actions
    move: move,
    spy: spy,
    spyDone: spyDone,
    tradeBegin: tradeBegin,
    tradeSelect: tradeSelect,
    tradeCommit: tradeCommit,
    stashTake: stashTake,
    stashReturn: stashReturn,
    prepare: prepare,
    frameInitiate: frameInitiate,
    frameSelect: frameSelect,
    frameResolve: frameResolve,
    frameAcknowledge: frameAcknowledge,
    steal: steal,
    goToCops: goToCops,
    goToCopsInterrupt: goToCopsInterrupt,
    evidenceSwap: evidenceSwap,
    recordSuspicion: recordSuspicion
  };
});
