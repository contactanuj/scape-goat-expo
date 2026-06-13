# Scape Goat — pass-and-play (Expo)

A digital, pass-and-play adaptation of **Scape Goat** (Lone Oak Games, 2020): a hidden-role social-deduction
heist game for **3–8 players** (officially 4–6). One device is passed around the table; the app privately deals
everyone their evidence and their belief about who the scapegoat is, runs the board, resolves frames, and
declares the winner. You bring the table talk, bluffs and winks.

This is the fourth game in the suite (alongside Wink Killer, Secret Hitler, The Chameleon) and follows the same
pattern: an Expo/React-Native shell wraps a single inlined `app.html`, backed by a pure, deterministic,
heavily‑unit‑tested rules engine.

## The game in one paragraph

One player is secretly the **scapegoat**. The app tells every player who *they* think the scapegoat is — and
quietly lies to the scapegoat, naming a decoy. So the scapegoat is the one player whose belief is wrong, and they
have to *deduce that* from the way the table behaves. The **gang** (everyone else) wins by **framing the real
scapegoat** — in a Frame Attempt everyone reveals a card at once and the frame sticks on a colour only if every
*other* player revealed that colour. The **scapegoat** wins by **running to the cops** before that happens (or if
the gang frames the wrong person). The tell: the gang is quietly collecting *your* colour.

## Architecture

```text
App.js              Expo shell — loads assets/app.html into a WebView
build.js            inlines styles.css + sg-deck.js + sg-engine.js + sg-bot.js + ui.js -> assets/app.html
make-icon.js        renders assets/icon.png (gold goat emblem) with zero deps (pure-Node PNG encoder)
assets/
  sg-deck.js        deterministic evidence-deck synthesis (closed economy; N-1 frame-feasibility floor)
  sg-engine.js      pure rules engine — no DOM, no network, JSON-serializable state, seeded PRNG
  sg-bot.js         honest (non-cheating) computer players
  ui.js             pass-and-play DOM UI (leak-safe board + gated private screens + bot auto-play)
  styles.css        heist/noir theme
tests/
  engine.test.js    config validation, deck invariants, targeted rules, anti-leak, bot anti-cheat, fuzz
  ui.smoke.test.js  headless DOM drives full human / mixed / all-bot games through the UI; anti-leak scans
```

The engine, deck and bot modules are UMD: `require()`-able in Node tests and attached to `window` when inlined.

## Run / build / test

```bash
npm install
npm test            # engine + UI smoke suites (the bug-free gate)
npm run build:html  # regenerate assets/app.html
npm run icon        # regenerate assets/icon.png
npm start           # build + expo start
npm run android     # build + expo run:android
npm run build:android  # build + eas build (apk)
```

## Configuration (Setup → Advanced)

Everything is configurable with **live validation**: combinations that would break the game are blocked
(errors); off‑spec‑but‑playable ones are allowed with a warning. Highlights:

- **Players** 3–8 (4–6 official). Per‑seat **Human / 🤖 Bot** toggle.
- **Deck** preset `scarce | balanced | rich | chaos`, hand size, stash size.
- **Framing** `declared_target` (the framer names who — clean, default) or `auto_detect` (read from the cards;
  an ambiguous multi‑colour reveal fails the frame rather than guessing).
- **House rules** must‑move‑each‑turn, must‑shed‑own‑colour on a swap, preparation‑token count + flip threshold,
  the 6‑player out‑of‑turn "run to the cops" rule, scapegoat decoy mode, beginner hints.
- **Series scoring** (off by default = a single heist): first‑to‑N points across re‑dealt heists.

The deck is a **closed economy** — `deckSize = N·handSize + 4 face‑up + stash` — and every colour is guaranteed
to appear on at least `N‑1` cards, so every player is always frameable (otherwise the gang could be unable to
win). `validateConfig` re‑checks this for custom decks.

## Hidden‑information (anti‑leak) design

The one bug class this genre must never have is leaking the hidden role on a screen everyone can see. The design
enforces it structurally:

- The shared **board** renders only `SG.publicState()` — token positions, face‑up cards, hand *counts*, prep
  tokens. Player colours are public identities, never a role tell. Nothing on it distinguishes the scapegoat.
- A player's **hand** and **intel/suspect** appear only behind a "pass the device to X" gate, and the intel
  screen is **byte‑for‑byte the same shape** for the scapegoat and a conspirator (both just see "you believe the
  scapegoat is …"). There is deliberately **no "review everyone's roles" screen**.
- Tests assert `revealInfo` key‑parity, that no player object ever carries a role flag, that `publicState`
  exposes no `scapegoatId`/intel/hands, and that the rendered board never contains the intel phrase.

## Bots

Bots fill seats so you can play with fewer humans. They are **honest** — a bot reads only what a human in its
seat could: its own hand, its own intel, the public board, and what it has legitimately seen by spying. It never
reads `state.scapegoatId` or other players' hidden cards (a test greps the module for `scapegoatId` and asserts
bot decisions are invariant when the real scapegoat is swapped). A bot "realises" it's the patsy the same way a
human does: it watches its **own** colour pile up across other hands and runs to the cops. Bots auto‑play with a
short delay; their hands and intel are never shown — only public narration.

## Rules interpretations (ambiguous in the rulebook; chosen defaults)

- A face‑up evidence card sits beside every location except Go‑to‑Cops (including the Prepare card, whose flip
  side is Frame/Steal), so a **steal and a failed frame end with a normal evidence swap**; only a successful
  frame or going to the cops end the game (no swap).
- Frame reveals are **non‑destructive** (cards return to hands on a failed frame).
- A preparation token is **not consumed** by a frame attempt.
- The dice + player‑mat lookup of the physical game is replaced by the app privately telling each player their
  belief — same information, no fiddly table lookups.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout, how to run the tests (no dependencies needed),
and the gameplay invariants to preserve. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License & disclaimer

The original **source code** in this repository is licensed under the [MIT License](LICENSE).

This is an **unofficial, non‑commercial fan adaptation**. Scape Goat — its name, rules, and design — is
© 2020 Lone Oak Games (designer Jon Perry); this project is not affiliated with or endorsed by them and ships
no original art or rulebook text from the game. **Do not use it commercially.** See [DISCLAIMER.md](DISCLAIMER.md).

## Credits

Scape Goat is © 2020 Lone Oak Games (designer Jon Perry). This is a non‑commercial fan adaptation that handles
the bookkeeping; it ships no original art or text from the game.
