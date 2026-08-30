goal: build the better-sidebar bb plugin - a date-grouped sidebar thread list with second metadata row, provider logos, five-state glyphs and a hover dossier - inside a new personal bb plugin marketplace repo, to a green PR
ticket: none
route: deep
mode: autonomous
branch: main @ /Users/mokson/Projects/Personal/bb-plugins
repo: ship path pr; tracker none; deployment publish (git tag better-sidebar/vX.Y.Z); conventions git-conventions skill, conventional commits
budget: - | tokens_total: -
done-when:
- [ ] c1 implementation matches PRODUCT.md and TECH.md
- [ ] c2 every PRODUCT.md behavior invariant B1-B50 is implemented and verified, or descoped with recorded approval
- [ ] c3 npx tsc --noEmit and npx vitest run pass in plugins/better-sidebar
- [ ] c4 QA evidence exists for the rendered sidebar, and QA blockers are fixed or accepted by the user
- [ ] c5 every oracle-bound test required by craft-build.md passes
- [ ] c6 the PR exists with CI green, or each non-green check is recorded as an external blocker
- [ ] c7 surviving deferred items are offered for filing or restated in the final report
- [ ] c8 N/A tracker binding is none per tracker.md rung 4; local docs play the tracker role
- [ ] c9 the ledger completion check passes
- [ ] c10 every durable artifact is findable from docs/specs/001_better-sidebar/
- [ ] c11 the independent review pass ran as delegated fresh-context reviewers on a different model family than the implementer
- [ ] c12 the run's worktree state is resolved or its retention offered in the final report
- [ ] c13 every product-code commit maps to a dispatched seat packet or an explicit inline-deviation line
- [ ] c14 the runlog is complete and numeric
- [ ] c15 every runlog row carries a seat and an explicitly passed model
- [x] c16 the preflight recorded whether deliver-* agent definitions were mounted - see d3
- [ ] c17 every operational artifact matches its artifacts.md contract
- [ ] c18 CONTEXT-DIGEST.md exists and every fixer packet cites it
- [ ] c19 tool-use checkpoints held as hard stops
- [ ] c20 user-visible change: screenshots of the rendered sidebar landed under docs/specs/001_better-sidebar/evidence/
- [ ] c21 UI-reshaping run: the QA packet named the frontend-design Review branch and the QA report shows it ran
- [x] c22 the workspace baseline proof ran before the first implementation packet and its result is a ledger line - see e2-e6
- [ ] c23 spec-driven change: the cross-vendor spec review ran after specs settled and before the first implementation packet
- [ ] c24 deep: the staged-slice plan is current and every slice is integrated with its review applied
- [ ] c25 N/A data-risk overlay - no migrations, permissions, payments, shared state, production data or rollback-sensitive behavior
- [ ] c26 N/A release - release was not requested
- [ ] c27 marketplace.json validates against the published getbb.app schema and the repo is registrable via bb marketplace add

## decisions
- d1 | seat mechanism is bb child threads via bb thread spawn --parent-self, not Claude-side deliver-* subagents | BB_THREAD_ID is set so the delegate skill's bb rule binds, and this environment prohibits AgentTool without a user request
- d2 | route deep | greenfield, frontend plus backend, independently parallelizable slices
- d3 | deliver-* agent definitions ARE mounted at ~/.agents/agents/ but are unreachable from bb child threads | recorded degraded mode: seat packets carry the standing rules inline per handoffs.md
- d4 | PRODUCT.md authored inline by the orchestrator rather than a deliver-product-spec seat | its content is the settled output of this session's grilling; a seat packet would have carried the spec verbatim to produce it
- d5 | product decisions B1-B50 settled across 8 grilling rounds with the user | recorded in PRODUCT.md, not re-litigated
- d6 | no per-thread cost figure | bb exposes cost only at provider-account window scope; token data is 98 percent cache reads with no write/read split
- d7 | tracker binding none | no ticket id, fresh repo, user never named a tracker; tracker.md rung 4
- d8 | target SDK 0.4.21, not npm-latest 0.4.28 | bb 0.40.0 embeds 0.4.21; a 0.4.28 floor installs as incompatible and never loads
- d9 | scope change: repo is a bb plugin MARKETPLACE hosting plugins, not a single plugin | user instruction mid-run, so the repo can be registered with bb marketplace add
- d10 | repo renamed bb-plugin-better-sidebar to bb-plugins | matches the ecosystem convention used by grrowl, smsunarto, patleeman and MateoCerquetella; user choice
- d11 | root marketplace.json hand-maintained as one file with a plugins array | the bb-community entries/ split exists to avoid multi-contributor PR conflicts, which a single-author repo does not have; user choice
- d12 | restructure to plugins/better-sidebar plus root marketplace.json done inline by the orchestrator | ~10 file moves and 2 small files; a packet would have cost more than the work, and it blocked every downstream packet's paths
- d13 | model and reasoning effort ARE retrievable, correcting the scaffold seat's Q3 answer | bb.sdk.threads.defaultExecutionOptions returns model and reasoningLevel; the seat checked only threads.get - bb-plugin-sdk.d.ts:3098-3126, :15436
- d14 | parked: adopt cron-parser devDependency and approve better-sqlite3 install scripts [accept, vendor differently, drop SDK testing harness] | default: accept - both are undeclared peers of @get-bb/plugin-sdk/testing, not discretionary additions

## assumptions
- a1 | bb serves its web UI at http://127.0.0.1:38886 for the run's duration | validated
- a2 | agent-browser can drive that UI and persist screenshots to disk | open
- a3 | experimental_useProviders exists in the running SDK with logoUrl and strings.iconTint | validated - bb-plugin-sdk-app.d.ts:227-265, :998-1001, :2266; logoUrl is nullable and strings.iconTint optional, so B24's fallback is load-bearing
- a4 | a plugin backend can read per-thread tokenUsage | validated with correction - not via threads.get; only via thread/tokenUsage/updated and thread/contextWindowUsage/updated events, bb-plugin-sdk.d.ts:2147-2176
- a5 | experimental_useSidebarThreadPullRequest exists in 0.4.21 | validated - bb-plugin-sdk-app.d.ts:2172, :2264
- a6 | a git-range marketplace entry needs a better-sidebar/vX.Y.Z tag before it is installable | open - the repo is listable but not installable until the ship step tags it

## specs
- docs/specs/001_better-sidebar/PRODUCT.md

## evidence
- e1 | git init and initial commit | git rev-parse --short HEAD = 1ec0331 | pass | static | -
- e2 | npm install --include=dev | 193 packages | pass | unit | c22
- e3 | npx tsc --noEmit | clean, no output | pass | static | c22
- e4 | npx vitest run | 1 passed (1) | pass | unit | c22
- e5 | bb plugin build . | emitted dist server and app bundles, no SDK mismatch warning | pass | unit | c22
- e6 | bb plugin install and list after marketplace restructure | better-sidebar@0.1.0 running from path plugins/better-sidebar | pass | live | c22
- e7 | marketplace restructure commit | git log 8a438f7 | pass | static | c27

## risks
- r1 | user chose everything-in-one-pass over layered v1/v2/v3; large first diff, long stretch before it is viewable | accepted
- r2 | precedence moves a pinned thread out of PINNED when it needs input | accepted
- r3 | oversized change likely past the ~500 line gate | open
- r4 | marketplace entry is not installable until a better-sidebar/vX.Y.Z tag is pushed | open
- r5 | SDK 0.4.21 floor means the plugin will not load on bb older than 0.40.0 | accepted

## gates
- g1 | public GitHub repo creation and first push | pre-approved by the user's Q23 answer, also public repo
- g2 | new devDependency cron-parser and npm install-scripts approve better-sqlite3 | parked per d14, default applied, surfaced in the final report

## nudges
- n1 | packet-fact-defect | orchestrator asserted SDK 0.4.28 from npm view instead of the running host's embedded 0.4.21, costing the scaffold seat one stop-and-ask round | -
- n2 | tooling-gap | bb parsed the handoffs.md packet's leading /goal line as its built-in goal command and killed the first spawn with a 4000-character limit error | -
- n3 | false-claim-in-return | scaffold seat's Q3 concluded model and reasoning effort are unretrievable, having checked only threads.get and not threads.defaultExecutionOptions | -
- n4 | environment-gap | npm cache write and git clone both blocked by the Bash sandbox, needing dangerouslyDisableSandbox retries | -

## slices

## runlog
- start | repo profile, preflight, PRODUCT.md, ledger | orchestrator | n/a | claude-opus-5[1m] | session | - | ~95k | n/a | 18 | n/a | - | accepted
- scaffold | scaffold repo + verify SDK surface (killed on /goal parse) | bb-thread | thr_2dztxpixj9 | claude-sonnet-5 | low | - | 0 | n/a | 0 | 30 | 0m | killed; bb parsed /goal as a slash command
- scaffold | scaffold repo + verify SDK surface | bb-thread | thr_t47q5xrcej | claude-sonnet-5 | low | - | n/a (bb) | n/a | n/a | 30 | ~14m | accepted; stopped once on the SDK version contradiction, steered, completed
- restructure | marketplace layout + manifest + README | orchestrator | n/a | claude-opus-5[1m] | session | - | ~25k | n/a | 12 | n/a | - | accepted; inline deviation per d12

## release
