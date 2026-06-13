<!-- Thanks for contributing! Keep this project non-commercial (see DISCLAIMER.md). -->

## What does this PR do?



## How was it tested?

- [ ] `npm test` passes
- [ ] `npm run build:html` run and the regenerated `assets/app.html` is committed (if any
      `assets/*.js` or `styles.css` changed)

## Gameplay safety checklist (if you touched gameplay)

- [ ] No hidden information leaks on shared screens (`publicState()` only; gated private
      screens; identical reveal for scapegoat vs conspirator)
- [ ] Bots read only legitimate info (no `state.scapegoatId`, no other players' hands)
- [ ] Card / prep-token conservation preserved; every colour still has `>= N-1` cards
- [ ] New config options are validated (errors block, warnings allow) and covered by a test
