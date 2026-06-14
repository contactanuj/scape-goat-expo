/*
 * sg-deck.js - deterministic evidence-deck synthesis for Scape Goat.
 *
 * Scape Goat has a CLOSED card economy: every card is dealt at setup (no draw
 * pile), and every action is a 1-for-1 swap, so the total never changes:
 *
 *     deckSize = N*handSize + 4 faceup (one per evidence location) + stashSize
 *
 * Each EVIDENCE CARD shows zero or more player COLORS (portraits) and may show a
 * grey "innocent bystander" (no player's colour). To FRAME a target, every one of
 * the N-1 other players must simultaneously hold a card bearing the target's
 * colour - so the deck MUST contain at least N-1 cards of every colour, otherwise
 * that player can never be framed (and if they are the scapegoat, the conspirators
 * literally cannot win). This module guarantees that floor BY CONSTRUCTION.
 *
 * The physical game ships 30 hand-curated cards filtered by player count; the exact
 * list isn't published, so we SYNTHESIZE a balanced, count-appropriate deck instead
 * (and scale to off-spec counts). Deterministic given (config, seed): composition is
 * pure; only the deal order is shuffled with the game's seeded PRNG.
 *
 * Pattern mirrors chameleon-expo/assets/ch-content.js: a self-contained UMD data
 * module with no DOM and no image assets (colours are string ids; an illustrated
 * set can be dropped in later purely at the render layer).
 */
(function (root, factory) {
  var SGDeck = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = SGDeck;
  if (root) root.SGDeck = SGDeck;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // Same mulberry32 PRNG the engine uses, operating on the shared state.rngState,
  // so deck shuffles interleave deterministically with the rest of the game.
  function nextRand(state) {
    var t = (state.rngState = (state.rngState + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function shuffleInPlace(state, arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(nextRand(state) * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  // The four evidence locations that each hold one face-up card (Go-to-Cops has none).
  var FACEUP_LOCATIONS = ['prepare', 'spy', 'trade', 'stash'];

  var DECK_PRESETS = ['scarce', 'balanced', 'rich', 'chaos', 'custom'];

  // Preset -> deck-shape knobs. `custom` reads the explicit fields off config.deck.
  function presetKnobs(config) {
    var d = config.deck || {};
    switch (d.preset) {
      case 'scarce':   return { spare: 0, greyFraction: 0.12, maxColors: 2 };
      case 'rich':     return { spare: 2, greyFraction: 0.20, maxColors: 2 };
      case 'chaos':    return { spare: 2, greyFraction: 0.20, maxColors: 3 };
      case 'custom':   return {
        spare: clampInt(d.spare, 0, 6, 1),
        greyFraction: clampNum(d.greyFraction, 0, 0.5, 0.16),
        maxColors: clampInt(d.maxColorsPerCard, 1, 3, 2)
      };
      case 'balanced':
      default:         return { spare: 1, greyFraction: 0.16, maxColors: 2 };
    }
  }

  function clampInt(v, lo, hi, dflt) {
    v = (v == null || isNaN(v)) ? dflt : Math.round(v);
    return Math.max(lo, Math.min(hi, v));
  }
  function clampNum(v, lo, hi, dflt) {
    v = (v == null || isNaN(v)) ? dflt : v;
    return Math.max(lo, Math.min(hi, v));
  }

  function deckSizeFor(config) {
    var N = config.playerCount;
    var H = config.handSize;
    var stash = config.stashSize;
    return N * H + FACEUP_LOCATIONS.length + stash;
  }

  // Effective per-card colour cap: never enough colours to implicate >= N-1 players
  // on a single card (that would auto-frame someone every reveal). Three-colour cards
  // are allowed by the "chaos" preset, or by a custom deck with allowThreeColor on.
  function effectiveMaxColors(config, knobs) {
    var N = config.playerCount;
    var d = config.deck || {};
    var allowThree = (d.preset === 'chaos') || (d.preset === 'custom' && d.allowThreeColor);
    var cap = knobs.maxColors;
    if (!allowThree) cap = Math.min(cap, 2);
    return Math.max(1, Math.min(cap, N - 1));
  }

  // ---------------------------------------------------------------------------
  // composeDeck(config) -> { cards:[{id,colors:[],hasBystander}], stats }
  //
  // Pure & deterministic (no PRNG). `cards` is the UNSHUFFLED multiset. stats lets
  // validateConfig reason about feasibility without re-deriving the math.
  // ---------------------------------------------------------------------------
  function composeDeck(config) {
    var N = config.playerCount;
    var colors = config.playerColors.slice(0, N);
    var knobs = presetKnobs(config);
    var maxColors = effectiveMaxColors(config, knobs);

    var deckSize = deckSizeFor(config);
    var floorIncidence = N * (N - 1);            // hard minimum total colour incidence
    var maxIncidence = deckSize * maxColors;     // most colour we can pack in

    var feasible = floorIncidence <= maxIncidence;

    // Desired total incidence (sweet spot), never below the floor, never above capacity.
    var targetPerColor = (N - 1) + knobs.spare;
    var goalIncidence = Math.min(Math.max(N * targetPerColor, floorIncidence), maxIncidence);

    if (!feasible) {
      // Caller (validateConfig) turns this into a blocking error. Return a best-effort
      // all-colour deck so nothing downstream throws on a bad config preview.
      goalIncidence = maxIncidence;
    }

    // Decide grey-only card count g0 within the range that keeps the rest legal:
    //   every coloured card needs >=1 colour  => g0 >= deckSize - goalIncidence
    //   coloured cards can hold <= maxColors   => g0 <= deckSize - ceil(goal/maxColors)
    var lo = Math.max(0, deckSize - goalIncidence);
    var hi = deckSize - Math.ceil(goalIncidence / maxColors);
    if (hi < lo) hi = lo;
    var desiredGrey = Math.round(deckSize * knobs.greyFraction);
    var g0 = Math.max(lo, Math.min(hi, Math.round(desiredGrey * 0.5)));

    var R = deckSize - g0;                       // coloured cards (>=1 colour each)
    // Distribute "bumps" (extra colours beyond the first) across the R coloured cards.
    var extra = goalIncidence - R;               // total extra colours to place
    if (extra < 0) extra = 0;
    var perCardCap = maxColors - 1;              // max bumps a single card can take

    var colorCount = [];                         // colours on each coloured card (1..maxColors)
    var i;
    for (i = 0; i < R; i++) colorCount.push(1);
    // Greedily fill each card up to its cap before moving on. Total incidence is unchanged
    // (so the per-colour floor is preserved - colours are assigned by demand below), but
    // when 3-colour is allowed this actually yields 3-colour cards instead of only pairs.
    var idx = 0, guard = 0;
    while (extra > 0 && idx < R && guard++ < R * maxColors + 5) {
      while (extra > 0 && colorCount[idx] - 1 < perCardCap) { colorCount[idx]++; extra--; }
      idx++;
    }

    // Even per-colour demand whose sum == actual incidence (>= floor for every colour).
    var actualIncidence = 0;
    for (i = 0; i < R; i++) actualIncidence += colorCount[i];
    var demand = [];
    var base = Math.floor(actualIncidence / N);
    var rem = actualIncidence - base * N;
    for (i = 0; i < N; i++) demand.push(base + (i < rem ? 1 : 0));

    // Assign concrete colours: cards needing the most colours pick first, each taking
    // the highest-remaining-demand DISTINCT colours. Keeps every colour near its demand.
    var order = [];
    for (i = 0; i < R; i++) order.push(i);
    order.sort(function (a, b) { return colorCount[b] - colorCount[a]; });

    var cards = [];
    var nextId = 0;
    function mkId() { return 'sg-card-' + (nextId++); }

    for (var oi = 0; oi < order.length; oi++) {
      var need = colorCount[order[oi]];
      var chosen = pickTopDistinct(demand, need);
      var cc = [];
      for (var k = 0; k < chosen.length; k++) { cc.push(colors[chosen[k]]); demand[chosen[k]]--; }
      cards.push({ id: mkId(), colors: cc, hasBystander: false });
    }

    // Grey-mixed flavour: tag some single-colour cards with a bystander, then add the
    // grey-only cards. Total grey ~= greyFraction of the deck (room permitting).
    var greyMixBudget = Math.max(0, desiredGrey - g0);
    var mixed = 0;
    for (i = 0; i < cards.length && mixed < greyMixBudget; i++) {
      if (cards[i].colors.length === 1) { cards[i].hasBystander = true; mixed++; }
    }
    for (i = 0; i < g0; i++) cards.push({ id: mkId(), colors: [], hasBystander: true });

    // Safety net: if integer rounding starved a colour below the N-1 floor, repair by
    // grafting it onto a card that can take another colour (prefer grey-only -> single).
    repairFloor(cards, colors, N, maxColors);

    return { cards: cards, stats: deckStats(cards, colors, N, deckSize, feasible) };
  }

  // Pick `k` distinct colour indices with the highest remaining demand (ties by index).
  function pickTopDistinct(demand, k) {
    var idxs = [];
    for (var i = 0; i < demand.length; i++) idxs.push(i);
    idxs.sort(function (a, b) { return demand[b] - demand[a] || a - b; });
    return idxs.slice(0, k);
  }

  function repairFloor(cards, colors, N, maxColors) {
    var guard = 0;
    while (guard++ < N * 4) {
      var inc = colorIncidence(cards);
      var starved = null;
      for (var c = 0; c < colors.length; c++) {
        if ((inc[colors[c]] || 0) < N - 1) { starved = colors[c]; break; }
      }
      if (!starved) return;
      // Prefer turning a grey-only card into a single of the starved colour.
      var done = false;
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].colors.length === 0) { cards[i].colors.push(starved); done = true; break; }
      }
      if (done) continue;
      // Otherwise add it to any card with spare colour capacity not already showing it.
      for (var j = 0; j < cards.length; j++) {
        if (cards[j].colors.length < maxColors && cards[j].colors.indexOf(starved) === -1) {
          cards[j].colors.push(starved); done = true; break;
        }
      }
      if (!done) return; // genuinely infeasible (validateConfig will have errored already)
    }
  }

  function cardHasColor(card, color) { return card.colors.indexOf(color) !== -1; }

  function colorIncidence(cards) {
    var out = {};
    for (var i = 0; i < cards.length; i++) {
      for (var k = 0; k < cards[i].colors.length; k++) {
        var c = cards[i].colors[k];
        out[c] = (out[c] || 0) + 1;
      }
    }
    return out;
  }

  function deckStats(cards, colors, N, deckSize, feasible) {
    var inc = colorIncidence(cards);
    var minInc = Infinity, maxInc = 0, grey = 0, singles = 0, pairs = 0, triples = 0;
    for (var c = 0; c < colors.length; c++) {
      var v = inc[colors[c]] || 0;
      if (v < minInc) minInc = v;
      if (v > maxInc) maxInc = v;
    }
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].hasBystander && cards[i].colors.length === 0) grey++;
      var len = cards[i].colors.length;
      if (len === 1) singles++; else if (len === 2) pairs++; else if (len >= 3) triples++;
    }
    return {
      deckSize: deckSize,
      feasible: feasible,
      incidence: inc,
      minIncidence: (minInc === Infinity ? 0 : minInc),
      maxIncidence: maxInc,
      floor: N - 1,
      greyCards: grey,
      singles: singles,
      pairs: pairs,
      triples: triples
    };
  }

  // synthesizeDeck(config, state) -> shuffled array of card objects.
  // Uses the game's seeded PRNG (state.rngState) so the deal order replays.
  function synthesizeDeck(config, state) {
    var composed = composeDeck(config);
    var cards = composed.cards.map(function (c) {
      return { id: c.id, colors: c.colors.slice(), hasBystander: c.hasBystander };
    });
    return shuffleInPlace(state, cards);
  }

  function frameFeasible(stats, N) { return stats.minIncidence >= (N - 1); }

  return {
    FACEUP_LOCATIONS: FACEUP_LOCATIONS,
    DECK_PRESETS: DECK_PRESETS,
    presetKnobs: presetKnobs,
    effectiveMaxColors: effectiveMaxColors,
    deckSizeFor: deckSizeFor,
    composeDeck: composeDeck,
    synthesizeDeck: synthesizeDeck,
    colorIncidence: colorIncidence,
    cardHasColor: cardHasColor,
    frameFeasible: frameFeasible
  };
});
