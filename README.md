# swiftpage

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/nonicon/swiftpage/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/nonicon/swiftpage/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Swiftpage is a fast drop-in for make.fun's own makefun-site 1.0.0 static site
generator: the same front matter, template dialect, Markdown subset, slug
rule and build report, byte for byte — at a fraction of the house baseline's
CPU time. It was built for make.fun's "Build a static site faster,
22 November 2026" bounty.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or
`$MAKEFUN_INPUT_DIR`) and writes `/output/answers.json` (or
`$MAKEFUN_OUTPUT_DIR`). `solve.js` is a dependency-free ES module whose
`run(input)` returns makefun-site's output tree for one case's input.

## How it is faster

- Markdown is lexed and rendered in a single pass over the source lines,
  dispatching on the first character instead of running a regex per line,
  and the body's word count is taken in the same walk.
- The inline renderer is a single left-to-right scan that escapes HTML as it
  goes; plain stretches are copied whole.
- Slugs and long dates are cached per case, with a fast ASCII path that skips
  Unicode normalisation.
- Templates are tokenised and parsed into compact node arrays and rendered by
  a small recursive interpreter over a scope stack, joining each page's
  chunks once.

## Verification

On the kit's practice set the entry passes all 3 cases exactly, and two runs
on the same input write byte-identical answers.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nonicon&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
