# CI and release audit

Audit date: 2026-10-11. Base commit: `4cf8631`.

## What I checked

These results are from commit `4cf8631` (Bun 1.3.6, the same version CI pins):

- **Type check and tests:** `bunx tsc --noEmit` passes. `bun test` reports 216 passed and 2 skipped; the skipped two are in `test/binary.test.ts`, which only runs when `RELAY_BACKPORT_BIN` is set.
- **Coverage:** 95.15% of lines and 92.68% of functions overall. `src/acp-server.ts` is the outlier at 52% of lines, because `test/acp-server.test.ts` drives it through `spawnAcp` in a child process, and Bun doesn't measure coverage across processes.
- **Bun's coverage threshold is checked per file, not overall.** With `coverageThreshold` set to 0.60 the run fails, and it fails silently with exit code 1. At 0.50 it passes. `coverageSkipTestFiles` doesn't exclude `test/helpers/*`.
- **actionlint:** reports nothing.
- **zizmor 1.30.1 (offline):**
  - One high finding: the `setup-bun` cache in `release.yml` could be poisoned.
  - Four medium findings: `persist-credentials` is left at its default on each checkout.
  - One informational finding: `softprops/action-gh-release` duplicates the `gh release` command already on the runner.
- **Biome 2 with recommended rules:** 215 findings. 185 are `noNonNullAssertion` (170 of them in `test/`), which is normal style given `noUncheckedIndexedAccess`, and 25 are `useTemplate`. Four look real:
  - an unused import at `src/cli.ts:19`
  - `noPrototypeBuiltins` at `test/run.test.ts:57`
  - `noImplicitAnyLet` at `test/observe.test.ts:92`
  - `noAssignInExpressions` at `test/observe.test.ts:259`
- **Biome formatter:** would rewrite 34 of 35 files, even at a 200-column line width.
- **Stricter `tsc` options:**
  - `--noUnusedLocals --noUnusedParameters` produces one error (`ShowError` is unused in `src/cli.ts`).
  - `--exactOptionalPropertyTypes` and related options produce 28 errors.
- **`bun audit`:** no vulnerabilities across the 13 locked packages.
- **hadolint:**
  - `DL3008`: the apt package isn't version-pinned.
  - `DL3066`: `USER relay` isn't numeric.
- **Repo settings:**
  - The repo is public and owned by a personal account, not an organisation.
  - Merge commits, squash and rebase are all allowed. Automatic branch deletion, auto-merge and the "update branch" button are all off.
  - There are no rulesets.
  - Recent history is squash merges (`title (#N)`). Only #4–#6 were merge commits.
- **CI duration:** about 45 seconds of wall-clock time per run, so caching isn't worth adding.
- **Release drift:** `package.json` is at 0.7.1, but the newest tag and release is `v0.5.0`. Versions 0.6.0, 0.7.0 and 0.7.1 were never tagged.

---

## 1. Missing CI checks, ranked by value versus effort

| Rank | Check | Value | Effort |
|---|---|---|---|
| 1 | Job timeouts and concurrency groups | High | Trivial |
| 2 | Release hardening: same checks as CI, tag must be on `main`, split permissions, provenance | High | Low–medium |
| 3 | Run the macOS and Windows binaries and unit tests on their own runners | High | Medium |
| 4 | Dependabot for Actions, Bun and Docker | High | Low |
| 5 | Workflow linting with actionlint and zizmor | Medium | Low |
| 6 | CodeQL default setup for JavaScript/TypeScript and Actions | Medium | Very low (settings toggle) |
| 7 | Secret scanning, push protection and a gitleaks job with a rule for `nsec` keys | Medium | Low |
| 8 | Lint with tuned Biome rules, plus `noUnusedLocals`/`noUnusedParameters` | Medium | Low |
| 9 | Docker hardening: pin the base images, hadolint, an image scan, a numeric UID | Medium | Low |
| 10 | Dependency audit with `bun audit` | Low–medium | Trivial |
| 11 | Coverage floor | Low–medium | Low |
| 12 | A formatter | Low | High churn |
| — | Caching | Not recommended | — |

### 1. Job timeouts and concurrency groups

No job sets `timeout-minutes`, so the default of 6 hours applies. The binary runs an ACP server that waits on stdin, and several tests wait on child processes and file tails, so one hung test can hold a runner for 6 hours. Pushing again to a PR also leaves the old run going.

Add this at the top level of `ci.yml`:

```yaml
concurrency:
  group: ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Then add `timeout-minutes` to each job: 10 for `test`, 15 for `compile` and `docker`, and 20 for the native-runner jobs.

In `release.yml`, use `concurrency: { group: release-${{ github.ref }}, cancel-in-progress: false }`.

### 2. Release hardening

Right now `release.yml` repeats `tsc` and the tests. It doesn't run the binary smoke test, the end-to-end test or the Docker build. Also:

- `contents: write` covers every step, including `bun install`, which runs third-party code.
- The tag can point at any commit, including one that isn't on `main`.
- `setup-bun` keeps its default cache (zizmor's high finding).

Suggested steps:

1. **Reuse CI's checks.** Add `workflow_call:` to `ci.yml`'s `on:` and call it from `release.yml` (`jobs.ci: uses: ./.github/workflows/ci.yml`). Every release then passes exactly what PRs pass, including the macOS and Windows runs from item 3.
2. **Split the work into two jobs.**
   - A `build` job with `contents: read` compiles the binaries, writes `SHA256SUMS` and uploads them as artifacts.
   - A `publish` job with `needs: [ci, build]` and `contents: write` downloads them and runs `gh release create "$GITHUB_REF_NAME" dist/* --generate-notes --verify-tag`. This also drops `softprops/action-gh-release`.
3. **Require the tag to be on `main`.** Use `fetch-depth: 0` on checkout, then:

```bash
git fetch origin main
git merge-base --is-ancestor "$GITHUB_SHA" origin/main || { echo "::error::tag is not on main"; exit 1; }
```

4. **Turn off the cache and stored credentials.** Set `no-cache: true` on `setup-bun` and `persist-credentials: false` on every `actions/checkout`, in both workflows.
5. **Add build provenance.** In `publish`, run `actions/attest-build-provenance` (pinned by SHA, like the other actions) with `subject-path: dist/relay-backport-*`, and grant `id-token: write` and `attestations: write`. Users can then check a download with `gh attestation verify <file> --repo 0xnfrith/relay-backport`.
6. **Deal with the version drift.** Either tag `v0.6.0`, `v0.7.0` and `v0.7.1`, or decide that releases are batched. Nothing currently reports that `main` is ahead of the latest release.

### 3. Run the macOS and Windows binaries on their own runners

`release` publishes `relay-backport-darwin-arm64` and `relay-backport-windows-x64.exe`, but no workflow ever runs them. Both are cross-compiled on Linux. Apple Silicon won't run a Mach-O file without a valid signature (ad-hoc is enough), so a broken signature would only show up on a Mac.

The source also has platform-specific branches that never run in CI:

- `defaultStateDir`, which reads `LOCALAPPDATA`
- the key-file mode check in `run.ts` and the `X_OK`/`F_OK` choice
- `pgrepSessionTitle`, which returns early on `win32`
- the `win32` guards in `test/sinks.test.ts` and `test/acp-server.test.ts`

Add a `native` job that tests the exact cross-compiled artifact the release ships, not a fresh native build:

```yaml
native:
  needs: compile
  timeout-minutes: 20
  strategy:
    fail-fast: false
    matrix:
      include:
        - { os: macos-latest,   bin: relay-backport-darwin-arm64 }
        - { os: windows-latest, bin: relay-backport-windows-x64.exe }
  runs-on: ${{ matrix.os }}
  steps:
    - uses: actions/checkout@<sha> # with persist-credentials: false
    - uses: oven-sh/setup-bun@<sha>
      with: { bun-version: "1.3.6" }
    - run: bun install --frozen-lockfile
    - uses: actions/download-artifact@<sha>
      with: { name: binaries, path: dist }
    - if: runner.os != 'Windows'
      run: chmod +x dist/${{ matrix.bin }}   # upload-artifact does not keep the executable bit
    - run: ./dist/${{ matrix.bin }} --version
      shell: bash
    - run: bun test
    - run: bun test test/binary.test.ts
      env: { RELAY_BACKPORT_BIN: "${{ github.workspace }}/dist/${{ matrix.bin }}" }
```

`macos-latest` is arm64 and `windows-latest` is x64, which matches the shipped targets. Standard runners are free for public repos.

Expect Windows to need some fixes the first time (signal handling, `cwd: "/"` in the ACP session tests). Keep `native` out of the required checks until it has passed on a few PRs in a row.

### 4. Dependabot for Actions, Bun and Docker

The SHA pins are good, but nothing updates them, so they'll go stale and miss security fixes.

Add `.github/dependabot.yml` with three ecosystems, each checked weekly with grouped updates:

- `github-actions` for `/`. Dependabot keeps the SHA pin and its `# v4` comment up to date.
- `bun` for `/`. Dependabot supports `bun.lock`.
- `docker` for `/deploy`.

Dependabot can't bump `bun-version: "1.3.6"` inside the workflows, and the Dockerfile uses a floating `oven/bun:1` (see item 9). Put the version in a `.bun-version` file, point `setup-bun` at it with `bun-version-file: .bun-version`, and add a CI step that fails if the Dockerfile's `oven/bun:<x>` tag doesn't match.

Renovate can update all of this in one place, but for a repo with one maintainer, Dependabot plus that check is simpler.

### 5. Workflow linting with actionlint and zizmor

Both workflows are short, and the release one runs with write access. actionlint reports nothing today. zizmor reports the six findings listed earlier, all cheap to fix.

Add a `workflow-lint` job:

- Download and run actionlint with a pinned version. ShellCheck is already installed on `ubuntu-latest`.
- Run `pipx run zizmor==<pinned> --format=github .github/workflows`.
- Don't add a `paths:` filter. A required check that gets filtered out never reports, and the PR waits on it forever. The job takes seconds anyway.

### 6. CodeQL default setup

This is static analysis for a TypeScript codebase that spawns processes from configuration (`ExecSink`), sends webhooks and handles private keys. It's free on public repos.

Turn it on under Settings → Code security → CodeQL → **Default setup**, with the `javascript-typescript` and `actions` languages. It doesn't need a workflow file. Enforce it through a ruleset rule (section 3) rather than a status-check name.

### 7. Secret scanning and push protection

The tool handles Nostr private keys (`BUZZ_PRIVATE_KEY`, `nsec1…`, plus key files and key commands), and #27 already had to remove a private URL from the README. That URL is still in git history.

GitHub's built-in scanning doesn't recognise `nsec` keys, and custom patterns aren't available to repos owned by personal accounts.

1. Turn on **secret scanning** and **push protection** in settings. Both are free for public repos.
2. Add a `secrets` job that runs gitleaks with `fetch-depth: 0` and a `.gitleaks.toml` that extends the default rules with this one:

```toml
[[rules]]
id = "nostr-nsec"
regex = '''nsec1[02-9ac-hj-np-z]{58}'''
```

Nothing in the repo matches this today. The test fixture `nsec1compiledbinaryinjectedkeymustnotleak` isn't valid bech32, so it won't trigger the rule.

### 8. Lint and stricter types

There's no lint or format config of any kind in the repo. A small rule set would catch the four real findings and stop more from appearing.

- **Lint job:** add Biome with `biome.json` set to `"formatter": { "enabled": false }`, the recommended linter rules, and `style/noNonNullAssertion` plus `style/useTemplate` switched off. Fix the four findings, then add a `lint` job running `bunx @biomejs/biome@<pinned> ci src test`.
- **Stricter `tsc`:** add `"noUnusedLocals": true` and `"noUnusedParameters": true` to `tsconfig.json`, and remove the unused `ShowError` import. Skip `exactOptionalPropertyTypes` for now; it produces 28 errors.

### 9. Docker hardening and image scanning

Several problems, all in `deploy/Dockerfile` or the `docker` job:

- **Bun version mismatch:** the build stage uses `FROM oven/bun:1`, which floats, while the tests and binaries use 1.3.6. The image can ship a Bun version that CI never tested.
- **Unpinned runtime image:** `debian:bookworm-slim` isn't pinned to a digest.
- **Non-numeric user:** `USER relay`. The Dockerfile describes deploying in a pod, and Kubernetes `runAsNonRoot: true` refuses images whose user isn't numeric.
- **No image scan:** the image is never scanned.

Changes:

- Use `FROM oven/bun:1.3.6@sha256:…` and `debian:bookworm-slim@sha256:…`, and let Dependabot's `docker` ecosystem update them.
- Create the user with a fixed UID and GID (for example `--uid 10001`), and use `USER 10001:10001`.
- Add hadolint to the `docker` job, with `DL3008` ignored in `.hadolint.yaml`. Pinning Debian package versions does more harm than good.
- Add a separate, non-required `docker-scan` job. It builds the image and runs Trivy (or Grype) with `severity: CRITICAL,HIGH` and `ignore-unfixed: true`. Upload the SARIF results to code scanning, and skip the upload on PRs from forks, whose token can't write. Keep it non-required, because new vulnerabilities in the Debian base image would otherwise block unrelated PRs.
- Optional, low priority: build an arm64 image on `ubuntu-24.04-arm`. The Dockerfile comment says arm64 is supported, but only amd64 is ever built.

### 10. Dependency audit

The dependency tree is small (13 packages, no current advisories), and `nostr-tools` pulls in cryptographic libraries, so an advisory should be noticed.

Add an `audit` job that runs `bun audit --audit-level=high` on PRs and on a weekly `schedule:`. Keep it non-required, for the same reason as the Docker scan. If GitHub's Dependency graph (under Insights) lists the `bun.lock` packages, Dependabot alerts and security updates cover most of this too.

### 11. Coverage floor

Coverage is already 95%, so a floor mainly catches large regressions. The catch is Bun's per-file threshold, which `acp-server.ts` at 52% would fail at any useful level.

This configuration passed when I tried it:

```toml
[test]
coveragePathIgnorePatterns = ["test/**", "src/acp-server.ts"]
coverageThreshold = { lines = 0.75, functions = 0.60 }
```

Put it in `bunfig.toml` and change the test step to `bun test --coverage --coverage-reporter=text --coverage-reporter=lcov`. Optionally upload `coverage/lcov.info` as an artifact.

Raise the floor as coverage improves. The better long-term fix is to test `acp-server.ts` in the same process, then remove it from the ignore list. The threshold failure prints no message, so note that in the step's `name:`.

### 12. Formatter

Not recommended for now. Biome would rewrite 34 of 35 files, because the code is written in a deliberately dense style with long lines. If you want one later, do the reformat in its own PR and list that commit in `.git-blame-ignore-revs`.

### Caching

Don't add any. `bun install` takes about 0.2 seconds for 13 packages, and the whole CI run takes about 45 seconds. Docker layer caching wouldn't change that noticeably either. The only cache in use is `setup-bun`'s, which item 2 turns off for releases.

---

## 2. Required status checks before merge

The jobs don't set `name:`, so the check names are the job IDs. Set **GitHub Actions** as the source for each one so another app can't post a passing status under the same name.

**Phase 0 (today, no workflow changes):** require these three.

- `test`
- `compile`
- `docker`

**Phase 1 (once each new job exists and has passed on a few PRs):** add these.

- `lint`
- `workflow-lint`
- `secrets`
- `native (macos-latest)`
- `native (windows-latest)`

A matrix job reports one check per entry, named by its matrix values. If you set an explicit `name:`, use those names instead.

**Never required:**

- `audit` and `docker-scan`: they can fail without any change to the code.
- Anything in `release`: it only runs on tags.

**CodeQL** should be enforced with the ruleset's "Require code scanning results" rule (tool: CodeQL; block on errors and on security alerts of high severity or above), not as a status-check name.

**Optional:** to avoid editing the ruleset every time a job is renamed, add a final `ci-ok` job. It would have `needs: [test, compile, docker, lint, workflow-lint, secrets, native]` and `if: always()`, and would fail when any result in `needs.*.result` isn't `success`. Then require only `ci-ok`.

---

## 3. Branch ruleset and merge settings for `main`

Use **rulesets** (Settings → Rules → Rulesets). They're available on public personal repos and replace the old tag protection feature.

### Ruleset `main` (target: default branch, enforcement: Active)

- **Bypass list:** empty. You're the only person with write access, so any standing bypass would make every rule optional. If something has to get through, temporarily switching the ruleset off is the way to do it, and it shows up in the audit log.
- **Restrict deletions** and **Block force pushes.**
- **Require linear history.**
- **Require a pull request before merging:**
  - Required approvals: **0** for now. GitHub won't let you approve your own PR, so requiring 1 would lock you out. Switch to 1, plus a `CODEOWNERS` file, when a second maintainer joins.
  - Dismiss stale approvals on new pushes: on.
  - Require conversation resolution: on.
  - Allowed merge methods: **squash only.**
- **Require status checks to pass:** the Phase 0 list, with **"Require branches to be up to date before merging"** on. PR volume is low and CI is fast, so the extra rebases cost little and stop a PR from merging after being tested against an older `main`.
- **Require code scanning results** (CodeQL), once item 6 is turned on.
- **Signed commits:** optional. GitHub signs squash merges made in the web UI, so requiring them is cheap if you want it.

### Repository settings (Settings → General)

- Turn off "Allow merge commits" and "Allow rebase merging", leaving squash only. History has been squash merges since #7.
- Set the squash commit message to the PR title, with the commit messages as the body. That keeps the `title (#N)` subjects and the `Co-authored-by` trailers already in the history.
- Turn on "Always suggest updating pull request branches" (currently off), "Automatically delete head branches" (currently off), and optionally "Allow auto-merge", which is handy for Dependabot PRs.
- **Merge queue: no.** It isn't offered for repos owned by personal accounts, and this repo has too little PR traffic to need one. If the repo moves to an organisation and gets busy, add `merge_group:` to `ci.yml`'s triggers before turning it on.

### Ruleset `release-tags` (target: tags, include `v*`)

- **Restrict creations, updates and deletions**, and **block force pushes.**
- **Bypass list:** Repository admin (always). Only you can create, move or delete `v*` tags.
- Turn on **immutable releases** (Settings → General → Releases) if your account has it, so published release files and their tags can't be changed.
- Together with the tag-must-be-on-`main` check from item 2 in section 1, this means a release can only come from a reviewed commit on `main`.

### Who can push, and Actions settings

- Keep write access limited to the owner. Bots and agents should work through pull requests from branches. The `main` ruleset already blocks pushing to `main` directly, and the tag ruleset blocks releases from anyone else.
- Under Settings → Actions → General:
  - Set default workflow permissions to **read**.
  - Turn off "Allow GitHub Actions to create and approve pull requests".
  - Require approval before running workflows from **all outside collaborators** on fork PRs.
  - Allow only your own actions plus the specific ones you use: `actions/*`, `oven-sh/setup-bun`, and any you add later.
  - Turn on **requiring actions to be pinned to a full-length commit SHA**. The repo already does this.
- Under Settings → Code security, turn on private vulnerability reporting, Dependabot alerts and security updates, secret scanning, push protection, and CodeQL default setup.

