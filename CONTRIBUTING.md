# Contributing

Thanks for your interest in improving Scape Goat (pass-and-play)! This is a small,
non-commercial fan project — contributions of all sizes are welcome.

Please read the [DISCLAIMER](DISCLAIMER.md) first: this is an unofficial adaptation, and
contributions must keep it non-commercial and free of any original art or rulebook text
from the published game.

## Project layout

```
App.js              Expo shell — loads assets/app.html into a WebView
build.js            inlines styles.css + sg-*.js + ui.js -> assets/app.html
make-icon.js        renders assets/icon.png (zero-dependency PNG encoder)
assets/
  sg-deck.js        deterministic evidence-deck synthesis
  sg-engine.js      pure rules engine (no DOM, JSON-serializable, seeded PRNG)
  sg-bot.js         honest (non-cheating) computer players
  ui.js             pass-and-play DOM UI (leak-safe board + gated private screens)
  styles.css        theme
tests/              engine.test.js + ui.smoke.test.js (plain Node, no test runner)
```

`sg-deck.js`, `sg-engine.js`, `sg-bot.js` are UMD modules: `require()`-able in Node tests
and attached to `window` when inlined into `app.html`.

## Setup

```bash
git clone <your-fork>
cd scape-goat-expo
npm install          # needed only to run the Expo app (not to run tests)
```

## Run the tests (no dependencies required)

```bash
npm test             # engine.test.js + ui.smoke.test.js
```

The test suites are plain Node scripts (no Jest). They cover config validation, deck
invariants, every rule path, the hidden-information (anti-leak) contract, bot anti-cheat,
and thousands of fuzzed full playthroughs. **All tests must pass** before a change is
merged.

## Build the app bundle

```bash
npm run build:html   # regenerate assets/app.html from the source modules
npm run icon         # regenerate assets/icon.png
npm start            # build + expo start (needs `npm install`)
```

`assets/app.html` is a generated, **committed** artifact (the Expo bundler loads it). If
you change any of `styles.css`, `sg-deck.js`, `sg-engine.js`, `sg-bot.js`, or `ui.js`, run
`npm run build:html` and commit the regenerated `assets/app.html`. CI verifies it is in
sync.

## Ground rules that keep the game from breaking

When touching gameplay, preserve these invariants (they are enforced by tests — keep them
green):

1. **No hidden-info leaks.** The shared board renders only `SG.publicState()`. A player's
   hand and their intel/suspect appear only behind a "pass the device" gate, and the
   reveal screen must look identical for the scapegoat and a conspirator. Never add a
   "review all roles" screen.
2. **Bots never cheat.** `sg-bot.js` may read only the bot's own hand/intel, the public
   board, and its own observations. It must never reference `state.scapegoatId` or another
   player's hidden hand. (A test greps for `scapegoatId` and asserts decisions are
   invariant when the real scapegoat is swapped.)
3. **Closed card economy.** Every action is a conservative swap; the total card count and
   prep-token count are invariant. Every colour must appear on at least `N-1` cards.
4. **Config safety.** `validateConfig` must block truly broken configs (errors) and only
   warn for off-spec-but-playable ones. Add a test for any new option.
5. **Determinism.** All randomness goes through the seeded PRNG on `state.rngState`, so a
   game replays from `(config, seed)`.

## Style

Match the surrounding code: ES5-flavored, `var`, no build step for the inlined modules,
no external runtime dependencies in `assets/`. Keep functions small and commented where
the rules are subtle.

## Submitting

1. Branch from `main`.
2. Make your change; run `npm test` and `npm run build:html`.
3. Open a pull request describing the change and how you tested it.
