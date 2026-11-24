[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/FiluFafayo/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/FiluFafayo/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

`mend` is one patch tool for every AI edit format. AI models write edits in
four different shapes — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — and `mend` applies any of them to a tree of text files. Every file is
changed or nothing is: edits apply in order, a failed edit is reported and
changes nothing, and when any edit fails no file is written at all.

Matching is forgiving where models are sloppy and strict where it matters.
Old lines are found at the first of three tiers at which they occur — exact,
trailing-whitespace-insensitive, then leading-and-trailing-whitespace
insensitive with re-indentation — and a unified hunk takes the occurrence
nearest its (possibly wrong) line number. A SEARCH/REPLACE block must match
exactly once. V4A chunks follow a cursor with anchors and end-of-file chunks.
JSON edits are exact. CRLF files keep CRLF, files without a final line break
keep that, and `--check` previews the result without writing anything.

## Run it

```sh
node main.ts [PATCH]
```

`PATCH` is the path of the patch file, relative to the working directory,
which is the root of the tree. When `PATCH` is absent or `-`, the patch is
read from standard input. The format is detected automatically; pass
`--format=unified`, `--format=search-replace`, `--format=v4a`, or
`--format=json` to force one. `--check` does everything but write, and
`--strict` matches lines exactly (tier 0 only).

On success `mend` lists what changed — `A` for added, `D` for deleted, `M`
for modified, `R old -> new` for moved files — and prints `ok: <n> files`.
On failure it prints one `error: <code> <path>` line per failed edit and a
`failed: <k> of <n> edits` summary, and writes nothing.

Node 22 or later, standard library only, no dependencies.

---

Built for the make.fun bounty: https://make.fun/bounty/hidden-spec-cli-01-run-20261122
