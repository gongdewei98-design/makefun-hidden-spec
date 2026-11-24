# makefun-hidden-spec

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gongdewei98-design/makefun-hidden-spec/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gongdewei98-design/makefun-hidden-spec/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. It applies the edits AI models write — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — to a tree of text files, finding the lines an edit names even when the model drifted their whitespace or indentation, and changing every file or none. See SPEC.md for the full contract.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file, or `-`/absent to read it from standard input. `--format` picks one of `auto` (the default, which detects the format), `unified`, `search-replace`, `v4a` or `json`. `--check` reports what would change without writing anything. `--strict` matches lines exactly. Node 22 and its standard library only; no dependencies, no network, no randomness.

---

<sub>Entered on [make.fun](https://make.fun/?ref=5t4wfmsa&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
