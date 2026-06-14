/*
 * ui.js - pass-and-play UI for Scape Goat. Browser-only (uses the DOM).
 * Depends on window.SG (engine) and window.SGDeck, inlined before this by build.js.
 *
 * HIDDEN-INFO DISCIPLINE (the wink-killer lesson):
 *   - Shared/board screens render ONLY SG.publicState(G): token positions, face-up
 *     cards, hand COUNTS, prep tokens, whose turn. Player colours are PUBLIC identity
 *     swatches, never a role tell. Nothing here distinguishes the scapegoat.
 *   - Secret info (a player's hand; their "intel"/suspect) is shown ONLY behind a
 *     "pass the device to X" gate, and the intel/role-reveal screen looks IDENTICAL
 *     for the scapegoat and the conspirators (same as SG.revealInfo's flat shape).
 *   - There is deliberately NO "review everyone's roles" screen.
 */
(function () {
  'use strict';
  var SG = window.SG;
  var SGBot = window.SGBot;
  var app = document.getElementById('app');
  var KEY = 'sg_state_v1';

  var G = null;        // engine game state (or null)
  var draft = null;    // setup config being edited
  var view = 'home';   // 'home' | 'setup' | 'rules' | 'game' | 'log'
  var ui = {};         // transient per-screen UI state
  var autoEnabled = (typeof setTimeout === 'function'); // bot auto-play timer (off in headless tests)
  var BOT_DELAY = 850; // ms between visible bot steps
  var botTimer = null;
  var lastScreenKey = null; // only scroll-to-top on a real screen change, not in-place updates
  var revealTimer = null;   // countdown that auto-hides a private reveal (wink-killer style)

  // ---- timed private reveal (always on; auto-hides the secret so it can't linger) --------
  function autoHideSecs() { return (G && G.config && G.config.autoHideSeconds) || 7; }
  function stopCountdown() { if (revealTimer) { clearInterval(revealTimer); revealTimer = null; } }
  function startCountdown() {
    stopCountdown();
    ui.hidden = false;
    ui.countdown = autoHideSecs();
    if (!autoEnabled || typeof setInterval !== 'function') return; // headless tests: no timer
    revealTimer = setInterval(function () {
      ui.countdown--;
      if (ui.countdown <= 0) { ui.hidden = true; stopCountdown(); }
      render();
    }, 1000);
  }

  // ---- persistence -------------------------------------------------------
  function save() { try { if (G) localStorage.setItem(KEY, JSON.stringify(G)); } catch (e) {} }
  function loadSaved() { try { var s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function clearSaved() { try { localStorage.removeItem(KEY); } catch (e) {} }

  // ---- helpers -----------------------------------------------------------
  function esc(s) {
    return ('' + (s == null ? '' : s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function seed() { return ((Date.now() >>> 0) ^ Math.floor(Math.random() * 0xffffffff)) >>> 0; }
  function nameOf(id) { return G ? SG.nameOf(G, id) : '?'; }
  function colorOf(id) { return G ? SG.colorOf(G, id) : null; }
  function swatch(color, lg) { return '<span class="swatch ' + (lg ? 'lg ' : '') + 'sw-' + esc(color) + '"></span>'; }
  function locLabel(loc) { return { prepare: 'Prepare', spy: 'Spy', trade: 'Trade', stash: 'Stash', cops: 'Cops' }[loc] || loc; }

  function setUiPhase() {
    if (ui.phase !== G.phase) {
      ui.phase = G.phase;
      ui.gate = true;            // most cross-player private screens start gated
      ui.peekShown = false;
      ui.spyShown = false;
      ui.swapShown = false;
      ui.tradeStep = 'initiator';
      ui.tradeGate = true;
      ui.frameIdx = 0;
      ui.frameGate = true;
      ui.selCard = null;
      ui.frameTarget = null;
    }
  }

  // ===========================================================================
  // RENDER DISPATCH
  // ===========================================================================
  function render() {
    if (view === 'game' && G) setUiPhase();
    var html;
    if (view === 'home') html = renderHome();
    else if (view === 'setup') html = renderSetup();
    else if (view === 'rules') html = renderRules();
    else if (view === 'log') html = renderLog();
    else if (view === 'game') html = renderGame();
    else html = renderHome();
    // Safety: stop the auto-hide timer whenever a live private reveal isn't on screen.
    var showingSecret = view === 'game' && G && !ui.hidden && (
      (G.phase === 'reveal' && ui.revealShown && ui.revealIdx < G.players.length) ||
      (G.phase === 'movement' && ui.peekShown));
    if (revealTimer && !showingSecret) stopCountdown();

    app.innerHTML = html;
    // Only jump to the top on a real screen change - not on in-place updates (typing a
    // name, tapping a stepper/toggle/select in Setup), which would otherwise yank the
    // page back to the top mid-edit.
    var key = screenKey();
    if (key !== lastScreenKey) {
      app.scrollTop = 0;
      if (window.scrollTo) window.scrollTo(0, 0);
      lastScreenKey = key;
    }
    scheduleBots();
  }

  // A stable id for "which screen am I on" - re-renders that keep this key keep the scroll.
  function screenKey() {
    if (view !== 'game' || !G) return view;
    return ['game', G.phase, G.currentPlayerId,
      ui.revealIntro ? 'i' : '', ui.revealIdx || 0, ui.revealShown ? 'rs' : '',
      ui.peekShown ? 'pk' : '', ui.spyShown ? 'sy' : '', ui.swapShown ? 'sw' : '',
      ui.frameIdx || 0, ui.frameGate ? 'fg' : '', ui.tradeStep || ''
    ].join('|');
  }

  // ===========================================================================
  // HOME
  // ===========================================================================
  function renderHome() {
    var saved = loadSaved();
    var resume = (saved && saved.phase !== 'game_over')
      ? '<button class="btn primary" data-action="resume">Resume game (' + esc(saved.players.length) + ' players)</button>'
      : '';
    return [
      '<div class="center" style="padding-top:26px">',
      '<h1>SCAPE GOAT</h1>',
      '<p class="muted">Pass-and-play · one device · 3-8 players</p>',
      '</div>',
      '<div class="spacer"></div>',
      resume,
      '<button class="btn primary" data-action="newgame">New game</button>',
      '<button class="btn" data-action="rules">How to play</button>',
      '<div class="spacer"></div>',
      '<p class="small muted center">You pulled off the heist of the century - but the cops are coming and someone has to take the fall. Frame the scapegoat… unless the scapegoat is <i>you</i>, in which case run to the cops!</p>',
      '<p class="small muted center">This app privately deals everyone their evidence and their belief about who the scapegoat is, runs the board, and resolves frames - you bring the table talk, bluffs and winks.</p>'
    ].join('');
  }

  // ===========================================================================
  // SETUP + CONFIG (live validation)
  // ===========================================================================
  // Seed `pc` flavourful, distinct names - keeping any already entered, padding the rest
  // from a shuffled "Gruff Gang" pool (falls back to "Player N" if the pool runs out).
  function themedNames(pc, existing) {
    existing = (existing || []).slice(0, pc);
    var used = {}; existing.forEach(function (n) { used[('' + n).trim().toLowerCase()] = true; });
    var pool = SG.THEME_NAMES.slice();
    for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    var out = existing.slice(), p = 0;
    while (out.length < pc) {
      if (p < pool.length) { var nm = pool[p++]; if (!used[nm.toLowerCase()]) { out.push(nm); used[nm.toLowerCase()] = true; } }
      else out.push('Player ' + (out.length + 1));
    }
    return out;
  }
  function newDraft(pc) {
    var names = (draft && draft.playerNames) ? draft.playerNames.slice() : null;
    var d = SG.defaultConfig(pc, names);
    if (!names) d.playerNames = themedNames(pc, []); // fresh New-game setup gets fun, varied names
    return d;
  }
  function resizeNames(d) {
    if (d.playerNames.length < d.playerCount) d.playerNames = themedNames(d.playerCount, d.playerNames);
    d.playerNames.length = d.playerCount;
    d.playerColors = SG.defaultColors(d.playerCount);
    if (!d.playerKinds) d.playerKinds = SG.defaultKinds(d.playerCount);
    while (d.playerKinds.length < d.playerCount) d.playerKinds.push('human');
    d.playerKinds.length = d.playerCount;
    // The out-of-turn cops interrupt is a 6-player-only rule - never leave it set otherwise.
    if (d.cops && d.playerCount !== 6) d.cops.sixPlayerInterrupt = false;
  }

  function renderSetup() {
    if (!draft) draft = newDraft(5);
    resizeNames(draft);
    var v = SG.validateConfig(draft);
    var adv = !!ui.advanced;

    var nameInputs = draft.playerNames.map(function (n, i) {
      var isBot = draft.playerKinds[i] === 'bot';
      return '<div class="row" style="margin:6px 0">' + swatch(draft.playerColors[i]) +
        '<input class="grow" type="text" data-name-idx="' + i + '" value="' + esc(n) + '" placeholder="Player ' + (i + 1) + '" maxlength="16" />' +
        '<button class="iconbtn" data-kind-idx="' + i + '">' + (isBot ? '🤖 Bot' : '🧑 Human') + '</button></div>';
    }).join('');

    return [
      topbar('New game', '<button class="iconbtn" data-action="home">Cancel</button>'),
      '<div class="panel">',
      '<h3>Players</h3>',
      stepperRow('Number of players', 'playerCount', draft.playerCount, 3, 8),
      '<label>Names &amp; colours (seating order)</label>',
      nameInputs,
      '</div>',

      '<div class="panel">',
      '<div class="collapse-h" data-action="toggleAdvanced"><h3 style="margin:0">Advanced configuration</h3><span class="iconbtn">' + (adv ? 'Hide ▲' : 'Show ▼') + '</span></div>',
      adv ? renderAdvanced(draft) : '<p class="small muted" style="margin-top:8px">Defaults match the official game for ' + draft.playerCount + ' players. Tap to tune the deck, frame style, scoring and house rules - invalid combos are blocked, off-spec ones are warned.</p>',
      '</div>',

      renderValidation(v),
      '<button class="btn primary" data-action="startGame"' + (v.ok ? '' : ' disabled') + '>' +
        (v.ok ? 'Deal the evidence &amp; start' : 'Fix the issue' + (v.errors.length > 1 ? 's' : '') + ' above to start') + '</button>',
      '<button class="btn ghost" data-action="resetDefaults">Reset to defaults</button>'
    ].join('');
  }

  // Smallest hand size that still lets the synthesized deck make every player frameable
  // for the CURRENT player count / stash / deck - so the stepper can't create a broken game.
  function feasibleMinHand(d) {
    for (var h = 1; h <= 5; h++) {
      var t = JSON.parse(JSON.stringify(d)); t.handSize = h;
      try {
        var st = window.SGDeck.composeDeck(t).stats;
        if (st.feasible && st.minIncidence >= d.playerCount - 1) return h;
      } catch (e) {}
    }
    return 1;
  }

  function renderAdvanced(d) {
    var minHand = feasibleMinHand(d);
    if (d.handSize < minHand) d.handSize = minHand; // keep the value in the legal range
    return [
      '<div class="spacer"></div>',
      '<h3>Deck</h3>',
      selectRow('deck.preset', 'Deck balance', d.deck.preset, [
        ['scarce', 'Scarce - frames hard to assemble'],
        ['balanced', 'Balanced (recommended)'],
        ['rich', 'Rich - frames easier'],
        ['chaos', 'Chaos - allows 3-suspect cards']
      ]),
      stepperRow('Cards per hand', 'handSize', d.handSize, minHand, 5),
      minHand > 1 ? '<p class="tiny muted" style="margin-top:-2px">Minimum ' + minHand + ' for ' + d.playerCount + ' players (so every player can be framed).</p>' : '',
      stepperRow('Stash size (facedown)', 'stashSize', d.stashSize, 1, 6),

      '<div class="spacer"></div>',
      '<h3>Framing</h3>',
      selectRow('frameMode', 'How a frame resolves', d.frameMode, [
        ['declared_target', 'Declared target - the framer names who (clean)'],
        ['auto_detect', 'Auto-detect - read it from the revealed cards']
      ]),
      checkboxRow('Must shed your own colour on a swap', 'enforceDumpOwnColor', d.enforceDumpOwnColor),
      checkboxRow('Must move to a new location each turn', 'mustMoveEachTurn', d.mustMoveEachTurn),
      stepperRow('Preparation tokens', 'prepTokens', d.prepTokens, 1, 6),
      stepperRow('Tokens taken before the board flips', 'flipThreshold', d.flipThreshold, 1, d.prepTokens),

      '<div class="spacer"></div>',
      '<h3>Scapegoat</h3>',
      selectRow('scapegoat.beginnerAssist', 'Beginner help', d.scapegoat.beginnerAssist, [
        ['off', 'Off - pure deduction (recommended)'],
        ['hints', 'Hints - show how much of your colour you can see']
      ]),
      selectRow('scapegoat.decoyMode', 'Decoy the scapegoat is told', d.scapegoat.decoyMode, [
        ['random_other', 'Random other player (recommended)'],
        ['adjacent', 'The player to their left']
      ]),
      stepperRow('Auto-hide the secret after (seconds)', 'autoHideSeconds', d.autoHideSeconds, 3, 30),
      // The out-of-turn "run to the cops" rule is a 6-player-only rule - only offered at 6.
      d.playerCount === 6 ? checkboxRow('Out-of-turn “run to the cops” rule (6-player)', 'cops.sixPlayerInterrupt', d.cops.sixPlayerInterrupt) : '',

      '<div class="spacer"></div>',
      '<h3>Series scoring</h3>',
      checkboxRow('Play a series (first to N points)', 'scoring.enabled', d.scoring.enabled),
      d.scoring.enabled ? stepperRow('Points to win the series', 'scoring.winTarget', d.scoring.winTarget, 1, 12) : '',
      d.scoring.enabled ? stepperRow('Points: scapegoat reaches the cops', 'scoring.scoreEscape', d.scoring.scoreEscape, 0, 9) : '',
      d.scoring.enabled ? stepperRow('Points: conspirators frame the scapegoat', 'scoring.scoreFrameRight', d.scoring.scoreFrameRight, 0, 9) : '',
      d.scoring.enabled ? stepperRow('Points: an innocent is framed (scapegoat)', 'scoring.scoreFrameWrong', d.scoring.scoreFrameWrong, 0, 9) : ''
    ].join('');
  }

  function renderValidation(v) {
    if (v.ok && v.warnings.length === 0) return '<div class="note small">Configuration is valid and balanced.</div>';
    var out = [];
    v.errors.forEach(function (e) { out.push('<div class="err">⛔ ' + esc(e) + '</div>'); });
    v.warnings.forEach(function (w) { out.push('<div class="warn">⚠ ' + esc(w) + '</div>'); });
    return '<div style="margin:12px 0">' + out.join('') + '</div>';
  }

  function stepperRow(label, path, val, min, max) {
    return ['<label>' + esc(label) + '</label>',
      '<div class="stepper" data-stepper="' + path + '" data-min="' + min + '" data-max="' + max + '">',
      '<button data-step="-1">−</button><div class="val">' + val + '</div><button data-step="1">+</button></div>'].join('');
  }
  function checkboxRow(label, path, val) {
    return '<div class="row" style="margin-top:12px"><div class="grow small">' + esc(label) + '</div>' +
      '<button class="iconbtn" data-toggle="' + path + '">' + (val ? 'On' : 'Off') + '</button></div>';
  }
  function selectRow(path, label, cur, opts) {
    return '<label>' + esc(label) + '</label><select data-cfg-select="' + path + '">' +
      opts.map(function (o) { return '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
  }

  // ===========================================================================
  // GAME
  // ===========================================================================
  function renderGame() {
    if (G.phase === 'reveal') return renderReveal();
    if (G.phase === 'game_over') return renderGameOver();
    if (G.phase === 'round_over') return renderRoundOver();

    // A bot is acting: show only the public board + narration, never the bot's private screen.
    if (pendingActorIsBot()) return renderBotActing();

    var body;
    switch (G.phase) {
      case 'movement': body = renderMovement(); break;
      case 'action_spy': body = renderSpyChoose(); break;
      case 'action_spy_view': body = renderSpyView(); break;
      case 'action_trade': body = renderTradeChoose(); break;
      case 'action_trade_select': body = renderTradeSelect(); break;
      case 'action_stash': body = renderStashTake(); break;
      case 'action_stash_return': body = renderStashReturn(); break;
      case 'action_prepare': body = renderPrepare(); break;
      case 'action_framesteal': body = renderFrameSteal(); break;
      case 'action_cops': body = renderCops(); break;
      case 'frame_select': body = renderFrameSelect(); break;
      case 'frame_resolve': body = renderFrameResolve(); break;
      case 'evidence_swap': body = renderEvidenceSwap(); break;
      default: body = '<div class="panel">Unknown phase: ' + esc(G.phase) + '</div>';
    }
    return [
      topbar((G.config.scoring && G.config.scoring.enabled ? 'Heist ' + G.seriesRound : 'Round ' + G.round),
        '<button class="iconbtn" data-action="viewLog">Log</button> <button class="iconbtn" data-action="menu">Menu</button>'),
      renderBoard(),
      body
    ].join('');
  }

  function renderBotActing() {
    var actor = pendingActorId();
    var last = G.log.length ? G.log[G.log.length - 1].text : '';
    var what = { frame_select: 'is secretly choosing a card for the frame', action_trade_select: 'is choosing a card to trade' }[G.phase] || 'is taking their turn';
    return [
      topbar((G.config.scoring && G.config.scoring.enabled ? 'Heist ' + G.seriesRound : 'Round ' + G.round),
        '<button class="iconbtn" data-action="viewLog">Log</button> <button class="iconbtn" data-action="menu">Menu</button>'),
      renderBoard(),
      '<div class="panel center"><h2>🤖 ' + esc(nameOf(actor)) + ' ' + swatch(colorOf(actor)) + '</h2>',
      '<p class="muted">' + esc(nameOf(actor)) + ' ' + esc(what) + '…</p>',
      last ? '<div class="note small">' + esc(last) + '</div>' : '',
      autoEnabled ? '' : '<button class="btn" data-action="botStep">Step bot</button>',
      '</div>'
    ].join('');
  }

  // ---- the public board (renders ONLY SG.publicState) -------------------
  function renderBoard() {
    var pub = SG.publicState(G);
    var locs = SG.LOCATIONS.map(function (loc) {
      var toks = pub.players.filter(function (p) { return p.location === loc; })
        .map(function (p) { return swatch(p.color); }).join('');
      var sub = '';
      if (loc === 'prepare') sub = pub.prepFlipped ? 'FRAME / STEAL' : ('tokens: ' + pub.prepTokensRemaining);
      var faceMini = (loc !== 'cops') ? renderCard(pub.faceup[loc], { mini: true }) : '';
      var cls = 'loc' + (loc === 'cops' ? ' cops' : '') + (loc === 'prepare' && pub.prepFlipped ? ' flipped' : '') +
        (SG.currentPlayer(G).location === loc ? ' here' : '');
      return '<div class="' + cls + '"><div class="lname">' + esc(loc === 'prepare' && pub.prepFlipped ? 'Frame' : locLabel(loc)) + '</div>' +
        '<div class="lsub">' + esc(sub) + '</div><div class="toks">' + toks + '</div>' +
        (faceMini ? '<div class="faceup-mini">' + faceMini + '</div>' : '') + '</div>';
    }).join('');

    var roster = pub.players.map(function (p) {
      var isTurn = p.id === pub.currentPlayerId;
      var score = (G.config.scoring && G.config.scoring.enabled) ? ' · ' + pub.scores[p.id] + 'pt' : '';
      return '<div class="prow' + (isTurn ? ' turn' : '') + '">' + swatch(p.color) +
        '<span class="pname">' + (p.kind === 'bot' ? '🤖 ' : '') + esc(p.name) + (isTurn ? ' <span class="chip turn">turn</span>' : '') + '</span>' +
        '<span class="pmeta">' + esc(locLabel(p.location)) + ' · ' + p.handCount + ' cards' +
        (p.prepTokens ? ' · <span class="ptok">●' + p.prepTokens + '</span>' : '') + score + '</span></div>';
    }).join('');

    return [
      '<div class="panel tight"><div class="board">' + locs + '</div></div>',
      '<div class="panel tight"><div class="roster">' + roster + '</div></div>'
    ].join('');
  }

  // ---- evidence card render ---------------------------------------------
  // `card` is a public card def {colors, hasBystander} or null (facedown -> back).
  function renderCard(card, opts) {
    opts = opts || {};
    var cls = 'ecard' + (opts.mini ? ' mini' : '') + (opts.pick ? ' pick' : '') + (opts.sel ? ' sel' : '') + (opts.dim ? ' dim' : '');
    if (!card) return '<div class="' + cls + ' back"><div class="eback">?</div></div>';
    var dots = (card.colors || []).map(function (c) { return '<span class="pdot sw-' + esc(c) + '"></span>'; }).join('');
    if (card.hasBystander) dots += '<span class="pdot sw-grey"></span>';
    if (!dots) dots = '<span class="pdot sw-grey"></span>';
    var label = '';
    if (!opts.mini) {
      var names = (card.colors || []).map(function (c) { return esc(nameForColor(c)); });
      if (card.hasBystander) names.push('bystander');
      label = '<div class="elabel">' + names.join(' · ') + '</div>';
    }
    var attrs = opts.cardId != null ? ' data-card="' + esc(opts.cardId) + '"' : '';
    var act = opts.action ? ' data-action="' + opts.action + '"' : '';
    return '<div class="' + cls + '"' + attrs + act + '><div class="portraits">' + dots + '</div>' + label + '</div>';
  }
  function nameForColor(color) {
    var p = G.players.filter(function (x) { return x.color === color; })[0];
    return p ? p.name : color;
  }

  // ---- private hand render (only behind a gate) -------------------------
  function renderHandCards(playerId, action) {
    var info = SG.revealInfo(G, playerId);
    return '<div class="cards-row">' + info.hand.map(function (c, i) {
      return renderCard(c, { pick: !!action, action: action, cardId: c.id, sel: ui.selCard === c.id });
    }).join('') + '</div>';
  }

  // ---- Reveal (private intel handoff) -----------------------------------
  function renderReveal() {
    if (ui.revealIdx == null) { ui.revealIdx = 0; ui.revealShown = false; ui.revealIntro = true; }
    if (ui.revealIntro) {
      return [
        topbar('Secret intel', ''),
        '<div class="panel center"><h2>Pass the device around</h2>',
        '<p class="muted">Each player privately sees their starting evidence and learns who <b>they</b> think the scapegoat is. Most of you are right - but the real scapegoat has been told the wrong name. Don\'t let anyone else see your screen.</p>',
        G.config.scapegoat.beginnerAssist === 'hints' ? '<div class="note small">Beginner help is ON: you\'ll see how many cards showing your own colour you can currently spot.</div>' : '',
        '</div>',
        '<button class="btn primary" data-action="revealStart">Begin</button>'
      ].join('');
    }
    if (ui.revealIdx >= G.players.length) {
      return [
        topbar('Secret intel', ''),
        '<div class="panel center"><h2>Everyone\'s briefed</h2><p class="muted">Put the device where the table can reach it. ' + esc(nameOf(G.currentPlayerId)) + ' takes the first turn.</p></div>',
        '<button class="btn primary" data-action="beginPlay">Start the heist</button>'
      ].join('');
    }
    var p = G.players[ui.revealIdx];
    if (!ui.revealShown) {
      return passScreen(p.name, 'Make sure only ' + esc(p.name) + ' can see the screen.', 'I am ' + esc(p.name) + ' - show my intel', 'revealShow');
    }
    return [
      topbar('Secret intel', ''),
      renderIntelCard(p.id),
      ui.hidden ? '<button class="btn" data-action="revealAgain">Show again</button>' : '',
      '<button class="btn primary" data-action="revealNext">Hide &amp; pass on</button>'
    ].join('');
  }

  // The intel screen - IDENTICAL shape for the scapegoat and conspirators. When the
  // auto-hide timer has elapsed, the secret is replaced by a neutral privacy cover (the
  // cover is also identical for everyone, so nothing leaks while it's hidden).
  function renderIntelCard(playerId) {
    if (ui.hidden) {
      return [
        '<div class="intelcard">',
        '<div class="muted">🔒 Hidden for privacy</div>',
        '<div class="small muted" style="margin-top:10px">Your secret auto-hid so no one else can see it. Tap “Show again” for another look.</div>',
        '</div>'
      ].join('');
    }
    var info = SG.revealInfo(G, playerId);
    var assist = (G.config.scapegoat.beginnerAssist === 'hints')
      ? '<p class="small muted">You can currently see <b>' + info.visibleOwnColor + '</b> card(s) showing your own colour (' + swatch(info.you.color) + '). If the whole table seems to be hoarding your colour, you may be the patsy - consider the cops.</p>'
      : '';
    return [
      '<div class="intelcard">',
      '<div class="muted">' + esc(info.you.name) + ' ' + swatch(info.you.color) + '</div>',
      '<div class="small muted" style="margin-top:10px">You believe the scapegoat is</div>',
      '<div class="big">' + esc(info.suspectName) + ' ' + swatch(colorOf(info.suspectId)) + '</div>',
      '</div>',
      '<p class="tiny muted center">Auto-hides in ' + (ui.countdown != null ? ui.countdown : autoHideSecs()) + 's</p>',
      '<div class="panel"><h3>Your evidence</h3>' + renderHandCards(playerId) + '</div>',
      '<p class="small muted">Collect cards showing the scapegoat\'s colour and frame them - but if the table turns on <i>your</i> colour instead, run to the cops!</p>',
      assist
    ].join('');
  }

  // ---- Movement ----------------------------------------------------------
  function renderMovement() {
    var cur = SG.currentPlayer(G);
    if (ui.peekShown) {
      return ['<div class="panel">' + renderIntelCard(cur.id) +
        (ui.hidden ? '<button class="btn" data-action="revealAgain">Show again</button>' : '') +
        '<button class="btn primary" data-action="peekHide">Hide</button></div>'].join('');
    }
    var targets = SG.eligibleMoveTargets(G);
    var btns = targets.map(function (loc) {
      var hint = { prepare: G.prepFlipped ? 'Frame or steal a token' : 'Take a prep token', spy: 'See a hand', trade: 'Swap a card', stash: 'Draw from the stash', cops: 'End the game (scapegoat wins)' }[loc];
      var cls = 'btn' + (loc === 'cops' ? ' danger' : '');
      return '<button class="' + cls + '" data-action="moveTo" data-arg="' + loc + '">' + esc(locLabel(G.prepFlipped && loc === 'prepare' ? 'Frame/Steal' : locLabel(loc))) + '<div class="small muted">' + esc(hint) + '</div></button>';
    }).join('');

    var interrupts = SG.copsInterrupters(G).filter(function (pid) { return !SG.isBot(G, pid); }).map(function (pid) {
      return '<button class="btn danger" data-action="copsInterrupt" data-arg="' + pid + '">' + esc(nameOf(pid)) + ': run to the cops now!</button>';
    }).join('');

    return [
      '<div class="panel">',
      '<h2>' + esc(cur.name) + '\'s turn ' + swatch(cur.color) + '</h2>',
      '<p class="muted">Move to a new location, then do its action. End your turn by swapping evidence.</p>',
      '<button class="btn ghost" data-action="peekShow">🔒 Check my evidence &amp; intel</button>',
      btns,
      interrupts ? '<div class="note small">Out-of-turn: a player 3 seats away may bolt to the cops.</div>' + interrupts : '',
      '</div>'
    ].join('');
  }

  // ---- Spy ---------------------------------------------------------------
  function renderSpyChoose() {
    var cur = SG.currentPlayer(G);
    var btns = G.players.filter(function (p) { return p.id !== cur.id; }).map(function (p) {
      return '<button class="btn" data-action="chooseSpy" data-arg="' + p.id + '">' + swatch(p.color) + ' ' + esc(p.name) + ' <span class="small muted">(' + p.hand.length + ' cards)</span></button>';
    }).join('');
    return '<div class="panel"><h2>Spy ' + swatch(cur.color) + '</h2><p class="muted">Whose hand do you want to secretly look at?</p>' + btns + '</div>';
  }
  function renderSpyView() {
    var t = G.spy.targetId;
    if (!ui.spyShown) {
      return passScreen(nameOf(G.spy.viewerId), 'Spying on ' + esc(nameOf(t)) + '\'s hand - others look away.', 'Show me their hand', 'spyShow');
    }
    return ['<div class="panel"><h2>' + esc(nameOf(t)) + '\'s hand</h2>' + renderHandCards(t) +
      '<p class="small muted">Remember it. You can lie about what you saw.</p>' +
      '<button class="btn primary" data-action="spyDone">Done - hide</button></div>'].join('');
  }

  // ---- Trade -------------------------------------------------------------
  function renderTradeChoose() {
    var cur = SG.currentPlayer(G);
    var btns = G.players.filter(function (p) { return p.id !== cur.id; }).map(function (p) {
      return '<button class="btn" data-action="choosePartner" data-arg="' + p.id + '">' + swatch(p.color) + ' ' + esc(p.name) + '</button>';
    }).join('');
    return '<div class="panel"><h2>Trade ' + swatch(cur.color) + '</h2><p class="muted">Pick a player to trade one card with. You each secretly choose a card, then swap.</p>' + btns + '</div>';
  }
  function renderTradeSelect() {
    var t = G.trade;
    if (ui.tradeStep === 'initiator') {
      return ['<div class="panel"><h2>You give one card</h2><p class="muted">' + esc(nameOf(t.initiatorId)) + ', tap the card you\'ll hand to ' + esc(nameOf(t.partnerId)) + '. Others look away.</p>',
        renderHandCards(t.initiatorId, 'tradeInitPick') + '</div>'].join('');
    }
    if (ui.tradeStep === 'partnerGate') {
      return passScreen(nameOf(t.partnerId), 'Your turn to choose a card to give ' + esc(nameOf(t.initiatorId)) + '.', 'I am ' + esc(nameOf(t.partnerId)), 'tradePartnerGate');
    }
    if (ui.tradeStep === 'partner') {
      return ['<div class="panel"><h2>You give one card</h2><p class="muted">' + esc(nameOf(t.partnerId)) + ', tap the card you\'ll hand over. Others look away.</p>',
        renderHandCards(t.partnerId, 'tradePartnerPick') + '</div>'].join('');
    }
    return ['<div class="panel center"><h2>Both ready</h2><p class="muted">' + esc(nameOf(t.initiatorId)) + ' and ' + esc(nameOf(t.partnerId)) + ' will swap simultaneously.</p>',
      '<button class="btn primary" data-action="tradeCommit">Complete the trade</button></div>'].join('');
  }

  // ---- Stash -------------------------------------------------------------
  function renderStashTake() {
    var cur = SG.currentPlayer(G);
    var backs = G.stash.map(function (cid, i) {
      return renderCard(null, { pick: true, action: 'stashTake', cardId: i });
    }).join('');
    return ['<div class="panel"><h2>Stash ' + swatch(cur.color) + '</h2><p class="muted">Take one facedown card into your hand (others look away).</p>',
      '<div class="cards-row">' + backs + '</div></div>'].join('');
  }
  function renderStashReturn() {
    var cur = SG.currentPlayer(G);
    return ['<div class="panel"><h2>Return one card</h2><p class="muted">You took the highlighted card. Now put one card from your hand back facedown (it may be the one you took).</p>',
      renderHandCards(cur.id, 'stashReturn') + '</div>'].join('');
  }

  // ---- Prepare -----------------------------------------------------------
  function renderPrepare() {
    var cur = SG.currentPlayer(G);
    return ['<div class="panel center"><h2>Prepare ' + swatch(cur.color) + '</h2>',
      '<p class="muted">Take a preparation token (' + G.prepTokensRemaining + ' left). When ' + G.config.flipThreshold + ' have been taken, the board flips and frames become possible.</p>',
      '<button class="btn primary" data-action="doPrepare">Take a token</button></div>'].join('');
  }

  // ---- Frame / Steal -----------------------------------------------------
  function renderFrameSteal() {
    var cur = SG.currentPlayer(G);
    if (cur.prepTokens >= 1) {
      if (G.config.frameMode === 'declared_target') {
        var btns = G.players.filter(function (p) { return p.id !== cur.id; }).map(function (p) {
          return '<button class="btn" data-action="pickFrameTarget" data-arg="' + p.color + '">Frame ' + swatch(p.color) + ' ' + esc(p.name) + '</button>';
        }).join('');
        return ['<div class="panel"><h2>Frame Attempt ' + swatch(cur.color) + '</h2>',
          '<p class="muted">You have a preparation token - declare who the gang is pinning it on. Then everyone reveals a card; the frame sticks only if every other player is holding that colour.</p>', btns, '</div>'].join('');
      }
      return ['<div class="panel center"><h2>Frame Attempt ' + swatch(cur.color) + '</h2>',
        '<p class="muted">Everyone will reveal a card at once. The frame lands on whichever single colour every other player is holding.</p>',
        '<button class="btn danger" data-action="frameInitiateAuto">Call the frame - everyone reveal</button></div>'].join('');
    }
    var victims = SG.eligibleStealTargets(G).map(function (pid) {
      return '<button class="btn" data-action="doSteal" data-arg="' + pid + '">' + swatch(colorOf(pid)) + ' ' + esc(nameOf(pid)) + '</button>';
    }).join('');
    return ['<div class="panel"><h2>Steal a token ' + swatch(cur.color) + '</h2>',
      '<p class="muted">You have no preparation token, so steal one from a player who does.</p>', victims, '</div>'].join('');
  }

  // ---- Cops --------------------------------------------------------------
  function renderCops() {
    var cur = SG.currentPlayer(G);
    return ['<div class="panel center"><h2>Go to the Cops?</h2>',
      '<p class="muted">This ends the game immediately and the <b>scapegoat wins</b> - whoever turned themselves in. Only do this if you\'re sure the gang is framing <i>you</i>.</p>',
      '<button class="btn danger" data-action="confirmCops">' + esc(cur.name) + ' runs to the cops</button>',
      '<button class="btn ghost" data-action="cancelCops">Wait - go back</button></div>'].join('');
  }

  // ---- Frame select (each player privately picks a card) ----------------
  function renderFrameSelect() {
    var ids = G.frame.participantIds;
    if (ui.frameIdx >= ids.length) {
      return ['<div class="panel center"><h2>Everyone has chosen</h2><p class="muted">On three… reveal all cards at once.</p>',
        '<button class="btn danger" data-action="frameReveal">Reveal!</button></div>'].join('');
    }
    var pid = ids[ui.frameIdx];
    if (ui.frameGate) {
      return passScreen(nameOf(pid), 'Secretly choose the card you\'ll reveal in the frame. ' + (ui.frameIdx + 1) + ' of ' + ids.length + '.', 'I am ' + esc(nameOf(pid)), 'frameGateOpen');
    }
    var declared = G.frame.declaredColor;
    var hint = declared ? 'The gang is framing ' + swatch(declared) + ' ' + esc(nameForColor(declared)) + '. Show that colour to help - or show something else to betray the plan.' : 'Pick the card you want to reveal.';
    return ['<div class="panel"><h2>' + esc(nameOf(pid)) + ', pick your card</h2><p class="muted">' + hint + '</p>',
      renderHandCards(pid, 'framePick') + '</div>'].join('');
  }
  function renderFrameResolve() {
    return [renderFrameRevealCards(),
      '<div class="panel center"><h2>Frame failed</h2><p class="muted">No single colour was on everyone else\'s card. The heist goes on - and everyone just learned a little more.</p>',
      '<button class="btn primary" data-action="frameContinue">Continue</button></div>'].join('');
  }
  function renderFrameRevealCards() {
    var lf = G.lastFrame;
    var rows = G.players.map(function (p) {
      return '<div style="text-align:center">' + renderCard(G.cards[lf.picks[p.id]], { mini: true }) + '<div class="tiny muted">' + esc(p.name) + '</div></div>';
    }).join('');
    return '<div class="panel"><h3>The reveal</h3><div class="cards-row">' + rows + '</div></div>';
  }

  // ---- Evidence swap -----------------------------------------------------
  function renderEvidenceSwap() {
    var cur = SG.currentPlayer(G);
    if (!ui.swapShown) {
      return passScreen(cur.name, 'Evidence swap - others look away.', 'Show my hand', 'swapShow');
    }
    var loc = G.movedTo;
    var faceCard = G.cards[G.faceup[loc]];
    var mustShed = SG.mustShedOwnColor(G, cur.id);
    var elig = SG.eligibleSwapOutCards(G, cur.id);
    var hand = SG.revealInfo(G, cur.id).hand.map(function (c) {
      var allowed = elig.indexOf(c.id) !== -1;
      return renderCard(c, { pick: allowed, action: allowed ? 'doSwap' : null, cardId: c.id, dim: !allowed });
    }).join('');
    return ['<div class="panel"><h2>Evidence swap at ' + esc(locLabel(loc)) + '</h2>',
      '<p class="muted">You\'ll take this face-up card:</p>',
      '<div class="cards-row">' + renderCard(faceCard, {}) + '</div>',
      mustShed ? '<div class="warn small">You\'re holding your own colour (' + swatch(cur.color) + ') - you must swap one of those out.</div>' : '',
      '<p class="muted">Tap one of your cards to put face-up here:</p>',
      '<div class="cards-row">' + hand + '</div></div>'].join('');
  }

  // ---- Round over (series) ----------------------------------------------
  function renderRoundOver() {
    return [topbar('Heist ' + G.seriesRound + ' result', ''),
      renderResultBanner(),
      renderStandings(),
      '<button class="btn primary" data-action="nextHeist">Next heist</button>',
      '<button class="btn ghost" data-action="home">Quit series</button>'].join('');
  }

  // ---- Game over ---------------------------------------------------------
  function renderGameOver() {
    var sg = SG.trueScapegoat(G);
    var series = G.config.scoring && G.config.scoring.enabled;
    return [topbar(series ? 'Series over' : 'Game over', ''),
      renderResultBanner(),
      G.lastFrame ? renderFrameRevealCards() : '',
      '<div class="panel"><h3>The truth</h3>',
      '<div class="kv"><span>The scapegoat was</span><span>' + swatch(colorOf(sg.id)) + ' <b>' + esc(sg.name) + '</b></span></div>',
      '<div class="kv"><span>They were told the scapegoat was</span><span>' + swatch(colorOf(sg.decoyId)) + ' ' + esc(sg.decoyName) + '</span></div>',
      '</div>',
      series ? renderStandings() : '',
      '<button class="btn primary" data-action="rematch">Rematch (same players)</button>',
      '<button class="btn" data-action="newgame">New game (new setup)</button>',
      '<button class="btn ghost" data-action="home">Home</button>'].join('');
  }
  function renderResultBanner() {
    var win = G.winner; // 'scapegoat' | 'conspirators'
    return '<div class="banner ' + win + '"><h1 style="color:' + (win === 'scapegoat' ? '#e0796d' : '#7db4e6') + '">' +
      (win === 'scapegoat' ? 'THE SCAPEGOAT WINS' : 'THE GANG WINS') + '</h1><p class="muted" style="margin:8px 0 0">' + esc(G.winReason) + '</p></div>';
  }
  function renderStandings() {
    var rows = SG.standings(G).map(function (s) {
      return '<div class="kv">' + swatch(s.color) + '<span class="grow">' + esc(s.name) + '</span><b>' + s.score + '</b></div>';
    }).join('');
    return '<div class="panel"><h3>Standings</h3>' + rows + '</div>';
  }

  // ---- Log ---------------------------------------------------------------
  function renderLog() {
    var items = G.log.slice().reverse().map(function (e) { return '<div class="li">R' + e.round + ' · ' + esc(e.text) + '</div>'; }).join('');
    return [topbar('Event log (public)', '<button class="iconbtn" data-action="backToGame">Back</button>'),
      '<div class="panel"><div class="log-list">' + (items || '<span class="muted">No events yet.</span>') + '</div></div>'].join('');
  }

  // ---- shared bits -------------------------------------------------------
  function topbar(title, right) { return '<div class="topbar"><span class="title">' + esc(title) + '</span><span>' + (right || '') + '</span></div>'; }
  function passScreen(name, instruction, buttonLabel, action) {
    return ['<div class="panel pass-screen"><p class="muted">Pass the device to</p><div class="who">' + esc(name) + '</div>',
      '<p class="small muted">' + esc(instruction) + '</p>',
      '<button class="btn primary" data-action="' + action + '">' + buttonLabel + '</button></div>'].join('');
  }

  // ===========================================================================
  // ACTIONS
  // ===========================================================================
  function handle(action, arg) {
    switch (action) {
      // navigation
      case 'home': view = 'home'; G = null; render(); break;
      case 'rules': view = 'rules'; render(); break;
      case 'backFromRules': view = 'home'; render(); break;
      case 'newgame': draft = null; ui = {}; view = 'setup'; render(); break;
      case 'resume': G = loadSaved(); ui = {}; view = 'game'; render(); break;
      case 'menu': if (confirm('Quit to home? Progress is saved and resumable.')) { view = 'home'; render(); } break;
      case 'viewLog': view = 'log'; render(); break;
      case 'backToGame': view = 'game'; render(); break;

      // setup
      case 'toggleAdvanced': ui.advanced = !ui.advanced; render(); break;
      case 'resetDefaults': { var pc = draft.playerCount; draft = SG.defaultConfig(pc, draft.playerNames.slice()); render(); break; }
      case 'startGame': startGame(); break;

      // reveal
      case 'revealStart': ui.revealIntro = false; ui.revealIdx = 0; ui.revealShown = false; skipBotReveals(); render(); break;
      case 'revealShow': ui.revealShown = true; startCountdown(); render(); break;
      case 'revealNext': stopCountdown(); ui.revealIdx++; ui.revealShown = false; ui.hidden = false; skipBotReveals(); render(); break;
      case 'revealAgain': startCountdown(); render(); break;
      case 'beginPlay': stopCountdown(); SG.beginPlay(G); save(); ui = {}; render(); break;

      // movement
      case 'peekShow': ui.peekShown = true; startCountdown(); render(); break;
      case 'peekHide': stopCountdown(); ui.peekShown = false; ui.hidden = false; render(); break;
      case 'moveTo': { var prevLoc = SG.currentPlayer(G).location; SG.move(G, arg); if (arg === 'cops') ui.preCopsLoc = prevLoc; save(); render(); break; }
      case 'copsInterrupt': SG.goToCopsInterrupt(G, arg); save(); render(); break;

      // spy
      case 'chooseSpy': SG.spy(G, arg); save(); render(); break;
      case 'spyShow': ui.spyShown = true; render(); break;
      case 'spyDone': SG.spyDone(G); save(); render(); break;

      // trade
      case 'choosePartner': SG.tradeBegin(G, arg); save(); render(); break;
      case 'tradeInitPick': SG.tradeSelect(G, G.trade.initiatorId, arg); ui.tradeStep = 'partnerGate'; render(); break;
      case 'tradePartnerGate': ui.tradeStep = 'partner'; render(); break;
      case 'tradePartnerPick': SG.tradeSelect(G, G.trade.partnerId, arg); ui.tradeStep = 'commit'; render(); break;
      case 'tradeCommit': SG.tradeCommit(G); save(); render(); break;

      // stash
      case 'stashTake': SG.stashTake(G, parseInt(arg, 10)); save(); render(); break;
      case 'stashReturn': SG.stashReturn(G, arg); save(); render(); break;

      // prepare
      case 'doPrepare': SG.prepare(G); save(); render(); break;

      // frame / steal
      case 'pickFrameTarget': SG.frameInitiate(G, arg); save(); render(); break;
      case 'frameInitiateAuto': SG.frameInitiate(G); save(); render(); break;
      case 'doSteal': SG.steal(G, arg); save(); render(); break;

      // frame select
      case 'frameGateOpen': ui.frameGate = false; render(); break;
      case 'framePick': SG.frameSelect(G, G.frame.participantIds[ui.frameIdx], arg); ui.frameIdx++; ui.frameGate = true; render(); break;
      case 'frameReveal': SG.frameResolve(G); if (SGBot) SGBot.afterFrameReveal(G); save(); render(); break;
      case 'frameContinue': SG.frameAcknowledge(G); save(); render(); break;

      // cops
      case 'confirmCops': SG.goToCops(G); save(); render(); break;
      case 'cancelCops': if (ui.preCopsLoc) { SG.currentPlayer(G).location = ui.preCopsLoc; ui.preCopsLoc = null; } G.phase = 'movement'; G.movedTo = null; save(); render(); break;

      // evidence swap
      case 'swapShow': ui.swapShown = true; render(); break;
      case 'doSwap': SG.evidenceSwap(G, arg); save(); render(); break;

      // end
      case 'rematch': G = SG.rematch(G, seed()); ui = {}; save(); render(); break;
      case 'nextHeist': SG.nextRound(G); ui = {}; save(); render(); break;

      // bots
      case 'botStep': if (botActOnce()) render(); break;
    }
  }

  function startGame() {
    var v = SG.validateConfig(draft);
    if (!v.ok) { render(); return; }
    G = SG.newGame(draft, seed());
    ui = {}; view = 'game'; save(); render();
  }

  // ===========================================================================
  // BOT AUTO-PLAY
  // ===========================================================================
  function allBots() { return G && G.players.every(function (p) { return p.kind === 'bot'; }); }

  // The player whose input the current phase is waiting on (or null for table screens).
  function pendingActorId() {
    if (!G) return null;
    switch (G.phase) {
      case 'reveal': case 'round_over': case 'game_over': return null;
      case 'frame_select':
        return (ui.frameIdx < G.frame.participantIds.length) ? G.frame.participantIds[ui.frameIdx] : G.frame.initiatorId;
      case 'action_trade_select':
        return (ui.tradeStep === 'partnerGate' || ui.tradeStep === 'partner') ? G.trade.partnerId : G.trade.initiatorId;
      default:
        return G.currentPlayerId;
    }
  }
  function pendingActorIsBot() { var a = pendingActorId(); return a && SG.isBot(G, a); }

  // Perform exactly ONE automatic step (a bot's action, or an auto-skip/auto-begin in an
  // all-bot game). Returns true if it acted; false when a HUMAN must act now. Bots never
  // expose their hand/intel - only public engine actions run.
  function botActOnce() {
    if (!G || view !== 'game') return false;
    var ph = G.phase;

    if (ph === 'reveal') {
      if (ui.revealIntro) { if (allBots()) { ui.revealIntro = false; return true; } return false; }
      if (ui.revealIdx == null) { ui.revealIdx = 0; ui.revealShown = false; }
      skipBotReveals();
      if (ui.revealIdx < G.players.length) return false; // a human still needs to view
      if (allBots()) { SG.beginPlay(G); ui = {}; save(); return true; }
      return false; // a human taps "Start"
    }
    if (ph === 'round_over') { if (allBots()) { SG.nextRound(G); ui = {}; save(); return true; } return false; }
    if (ph === 'game_over') return false;

    if (ph === 'frame_select') {
      var ids = G.frame.participantIds;
      if (ui.frameIdx < ids.length) {
        var pid = ids[ui.frameIdx];
        if (SG.isBot(G, pid)) { SG.frameSelect(G, pid, SGBot.botFrameCard(G, pid)); ui.frameIdx++; ui.frameGate = true; return true; }
        return false;
      }
      if (SG.isBot(G, G.frame.initiatorId) || allBots()) { SG.frameResolve(G); SGBot.afterFrameReveal(G); save(); return true; }
      return false;
    }

    if (ph === 'action_trade_select') {
      var t = G.trade;
      if (ui.tradeStep === 'initiator') { if (SG.isBot(G, t.initiatorId)) { SG.tradeSelect(G, t.initiatorId, SGBot.botTradeGiveCard(G, t.initiatorId)); ui.tradeStep = 'partnerGate'; return true; } return false; }
      if (ui.tradeStep === 'partnerGate') { if (SG.isBot(G, t.partnerId)) { ui.tradeStep = 'partner'; return true; } return false; }
      if (ui.tradeStep === 'partner') { if (SG.isBot(G, t.partnerId)) { SG.tradeSelect(G, t.partnerId, SGBot.botTradeGiveCard(G, t.partnerId)); ui.tradeStep = 'commit'; return true; } return false; }
      if (ui.tradeStep === 'commit') { if (SG.isBot(G, t.initiatorId)) { SG.tradeCommit(G); save(); return true; } return false; }
      return false;
    }

    // single-actor phases
    if (SG.currentIsBot(G)) { SGBot.takeAction(G, G.currentPlayerId); save(); return true; }
    return false;
  }

  function skipBotReveals() { // never render a bot's private intel screen
    while (ui.revealIdx < G.players.length && G.players[ui.revealIdx].kind === 'bot') { ui.revealIdx++; ui.revealShown = false; }
  }

  function clearBotTimer() { if (botTimer) { clearTimeout(botTimer); botTimer = null; } }
  function scheduleBots() {
    clearBotTimer();
    if (!autoEnabled || !G || view !== 'game') return;
    if (!pendingActorIsBot() && !(allBots() && (G.phase === 'reveal' || G.phase === 'round_over'))) return;
    botTimer = setTimeout(function () {
      botTimer = null;
      if (botActOnce()) render(); // render() re-schedules if more bot work remains
    }, BOT_DELAY);
  }

  // ===========================================================================
  // RULES
  // ===========================================================================
  function renderRules() {
    return [topbar('How to play', '<button class="iconbtn" data-action="backFromRules">Back</button>'),
      '<div class="panel"><h2>The setup</h2><p class="small">One of you is secretly the <b>scapegoat</b>. The app privately tells everyone who they <i>think</i> the scapegoat is - and quietly lies to the scapegoat, naming someone else. So the scapegoat is the one player whose belief is wrong, and they have to figure that out.</p></div>',
      '<div class="panel"><h2>Who wins</h2><p class="small">The <b>gang</b> (everyone but the scapegoat) wins by <b>framing the real scapegoat</b>. The <b>scapegoat</b> wins by <b>running to the cops</b> before that happens - or if the gang frames the wrong person.</p></div>',
      '<div class="panel"><h2>Your turn</h2><div class="steps">' +
        '<div class="step">Move your token to a new location.</div>' +
        '<div class="step">Do that location\'s action: <b>Spy</b> a hand, <b>Trade</b> a card, draw from the <b>Stash</b>, <b>Prepare</b> a token, or (once the board flips) <b>Frame/Steal</b>. Or go to the <b>Cops</b>.</div>' +
        '<div class="step">Swap one card with the face-up card there - if you hold your own colour, you must give one of those up.</div></div></div>',
      '<div class="panel"><h2>Framing</h2><p class="small">After two preparation tokens are taken the board flips. A token-holder can call a <b>Frame Attempt</b>: everyone reveals a card at once, and the frame sticks on a colour only if every other player revealed that colour. Frame the scapegoat → the gang wins. Frame anyone else → the scapegoat wins.</p></div>',
      '<div class="panel"><h2>Lying is the game</h2><p class="small">Talk, bluff, point fingers, wink. You may say anything about your cards or what you spied - true or false. Just don\'t tip off the scapegoat that the table is collecting <i>their</i> colour.</p></div>',
      '<button class="btn primary" data-action="backFromRules">Got it</button>'].join('');
  }

  // ===========================================================================
  // INPUT WIRING (delegated)
  // ===========================================================================
  app.addEventListener('click', function (e) {
    var stepBtn = e.target.closest('.stepper button');
    if (stepBtn) { onStep(stepBtn); return; }
    var toggle = e.target.closest('[data-toggle]');
    if (toggle) { onToggle(toggle.getAttribute('data-toggle')); return; }
    var kind = e.target.closest('[data-kind-idx]');
    if (kind) { var ki = parseInt(kind.getAttribute('data-kind-idx'), 10); draft.playerKinds[ki] = (draft.playerKinds[ki] === 'bot' ? 'human' : 'bot'); render(); return; }
    var act = e.target.closest('[data-action]');
    if (act) { handle(act.getAttribute('data-action'), act.getAttribute('data-arg')); return; }
  });
  app.addEventListener('input', function (e) {
    var t = e.target;
    if (t.hasAttribute && t.hasAttribute('data-name-idx')) {
      draft.playerNames[parseInt(t.getAttribute('data-name-idx'), 10)] = t.value;
    }
  });
  app.addEventListener('change', function (e) {
    var t = e.target;
    if (t.hasAttribute && t.hasAttribute('data-cfg-select')) { setPath(draft, t.getAttribute('data-cfg-select'), coerce(t.value)); render(); }
  });

  function coerce(v) { if (v === 'true') return true; if (v === 'false') return false; return v; }
  function getPath(o, p) { var k = p.split('.'); for (var i = 0; i < k.length; i++) o = o[k[i]]; return o; }
  function setPath(o, p, val) { var k = p.split('.'); for (var i = 0; i < k.length - 1; i++) o = o[k[i]]; o[k[k.length - 1]] = val; }

  function onStep(btn) {
    var wrap = btn.closest('.stepper');
    var path = wrap.getAttribute('data-stepper');
    var min = parseInt(wrap.getAttribute('data-min'), 10), max = parseInt(wrap.getAttribute('data-max'), 10);
    var delta = parseInt(btn.getAttribute('data-step'), 10);
    var next = Math.max(min, Math.min(max, getPath(draft, path) + delta));
    setPath(draft, path, next);
    if (path === 'playerCount') {
      // Re-derive count-appropriate defaults, but KEEP the entered names and bot/human choices.
      var names = draft.playerNames.slice();
      var kinds = (draft.playerKinds || []).slice();
      draft = SG.defaultConfig(next, names);
      for (var i = 0; i < next; i++) if (kinds[i]) draft.playerKinds[i] = kinds[i];
    }
    // Keep the flip threshold reachable when prep tokens drop.
    if (path === 'prepTokens' && draft.flipThreshold > draft.prepTokens) draft.flipThreshold = draft.prepTokens;
    render();
  }
  function onToggle(path) { setPath(draft, path, !getPath(draft, path)); render(); }

  // ===========================================================================
  // BOOT + test hook
  // ===========================================================================
  function boot() { render(); }
  var hook = {
    handle: handle, render: render,
    state: function () { return { view: view, G: G, draft: draft, ui: ui }; },
    setView: function (v) { view = v; },
    setDraft: function (d) { draft = d; },
    setAuto: function (on) { autoEnabled = on; clearBotTimer(); },
    botActOnce: botActOnce,
    pendingActorIsBot: pendingActorIsBot,
    lastHtml: function () { return app.innerHTML; }
  };
  try { window.__SGUI = hook; } catch (e) {}
  if (typeof module !== 'undefined' && module.exports) module.exports = hook;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
