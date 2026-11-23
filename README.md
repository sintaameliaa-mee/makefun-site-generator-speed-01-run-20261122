# site-generator-speed-01-run-20261122

[![competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/sintaameliaa-mee/makefun-site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/sintaameliaa-mee/makefun-site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0, written from scratch for the
"Build a static site faster" bounty: `solve.js` answers exactly as
makefun-site does on every case, and `main.ts` is the driver the harness
runs.

How it earns its speed:

- **Regex-free hot paths.** The Markdown block scan, the front-matter scan
  and the slug rule all run on `charCodeAt` dispatch instead of regexes.
- **Fused Markdown.** Lexing and rendering run in one pass, so no token
  objects are ever built.
- **Run-based inline rendering.** One native regex scan finds the next
  interesting character; plain runs are copied whole and only what needs
  escaping is ever escaped.
- **Memoised slugs.** Titles, tags and headings repeat across a site, so
  slug results are cached per run (never across cases).
- **Lean templates.** A small array-node interpreter with flat scope
  frames, one frame object per loop execution, and output parts joined
  once per render.

`run(input)` returns the output tree — every path the build writes and that
file's text, byte for byte — for one case's `{ site, templates, files }`
input. No dependencies, no I/O, no clock, no randomness: the output is a
function of the input alone.
