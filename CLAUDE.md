# Workout Timer

Plain HTML/CSS/JS PWA, no build step. See README.md and docs/ (data model,
decision log, backlog).

## UI changes: check portrait AND landscape

The app is used on a phone that may be rotated mid-workout. Any UI change must
be checked at phone sizes in both orientations, e.g. 390×844 and 844×390
(plus a small phone, 375×667 / 667×375), before calling it done.

- Sizes that scale with `vw` blow up in landscape, where height is the scarce
  dimension. Size by height (`dvh`) or `min()` of both, or add a
  `@media (orientation: landscape) and (max-height: 540px)` rule — the run
  screen has one in styles.css.
- Nothing should be pushed off screen or need scrolling on the run and done
  screens; controls must stay reachable.

Quick way to look: serve with `python3 -m http.server 8737` and use device
emulation, or screenshot with headless Chrome — put the page in an
`<iframe width=W height=H>` so the viewport is exact (headless `--window-size`
can't go narrower than ~500px).
