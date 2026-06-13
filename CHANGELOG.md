# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-14

Initial release — a complete, configurable, pass-and-play adaptation.

### Added
- Pure, deterministic rules engine (`sg-engine.js`): movement → action → evidence-swap
  turn loop, Spy / Trade / Stash / Prepare / Frame-or-Steal / Go-to-the-Cops, frame
  resolution, the Prepare→Frame/Steal flip, and win conditions. Seeded PRNG so a game
  replays from `(config, seed)`.
- Deterministic evidence-deck synthesis (`sg-deck.js`): a closed card economy
  (`N·hand + 4 + stash`) with a guaranteed `N-1` frame-feasibility floor for every colour.
- Pass-and-play UI (`ui.js`): a leak-safe shared board (renders only `publicState()`),
  pass-the-device gated private screens, an event log, single-heist and series flows, and
  a How-to-play / first-game guide.
- **Bots** (`sg-bot.js`): per-seat Human/Bot toggle and honest, non-cheating computer
  players that auto-play with their secrets hidden.
- Configuration with live validation: player count 3–8 (4–6 official), deck presets
  (scarce/balanced/rich/chaos), declared-target vs auto-detect framing, must-move,
  must-shed-own-colour, prep-token count + flip threshold, the 6-player cops interrupt,
  decoy mode, beginner hints, and optional first-to-N series scoring.
- Safe-area handling so the status bar / notch never overlaps content.
- Generated gold goat-head app icon (`make-icon.js`, zero-dependency PNG encoder).
- Test suites (`tests/engine.test.js`, `tests/ui.smoke.test.js`): config validation, deck
  invariants, every rule path, the hidden-information (anti-leak) contract, bot anti-cheat
  (decisions invariant to the real scapegoat), and thousands of fuzzed full playthroughs.

[1.0.0]: https://keepachangelog.com/
