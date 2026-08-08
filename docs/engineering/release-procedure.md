# AuthorAgent release procedure

**Owner:** Alpha Technology CTO
**Effective:** 2026-08-07
**Applies to:** every production release from `main`

A release is complete only after the change is merged, tagged, deployed to the
AuthorAgent NAS service, and verified. A passing pull-request check alone is not
a release.

## Required release artifacts

The release pull request must contain all of the following:

1. A SemVer version change in both `package.json` and `package-lock.json`.
2. A dated Markdown release note at `docs/releases/YYYY-MM-DD-vX.Y.Z.md` that
   identifies the pull request and issue, describes user-visible behavior,
   calls out compatibility/data risks, and lists verification and rollback.
3. Inspectable clean-checkout evidence for `npm ci` and `npm run check` on
   Node 22, captured against the final pull-request head SHA. GitHub Actions is
   structurally unavailable for repositories under the `dabeezor` account and
   is not a release gate; an Actions failure caused solely by the account lock
   does not invalidate otherwise passing local evidence.
4. QA approval of that exact head SHA. Any commit after approval invalidates
   the approval and requires the check and QA review again.

Do not waive a missing gate implicitly. Only the CTO may record a gate-specific
waiver, and the waiver must identify the omitted gate, evidence reviewed, risk,
scope, expiry, and compensating control. A CI infrastructure failure is not a
passing check.

## Version selection

Use [Semantic Versioning 2.0.0](https://semver.org/):

- **MAJOR** for an incompatible API, stored-data, configuration, or operator
  contract change.
- **MINOR** for backward-compatible functionality, including a new API route.
- **PATCH** for a backward-compatible correction with no new public behavior.

Use one version per deployed commit. Never move or reuse a published tag. The
release date is the UTC date on which deployment completes; if deployment slips
to another date, rename and update the release note before tagging.

## Release sequence

1. **Prepare.** Rebase or merge current `main`; choose the version; update both
   manifests and the dated release note. Record the candidate head SHA.
2. **Validate.** Run `npm ci` and `npm run check` from a clean checkout on Node
   22. Capture the command output, tool versions, candidate SHA, UTC timestamp,
   and exit status in an issue attachment or other board-inspectable artifact.
   QA reviews the diff and that evidence for the same SHA.
3. **Merge.** Merge only the QA-approved candidate with passing clean-checkout
   evidence into `main`. Any commit after validation or approval invalidates
   both and requires validation and QA review again.
4. **Tag.** From the resulting `main` commit, create annotated tag `vX.Y.Z` and
   push it. Confirm `git rev-parse vX.Y.Z^{commit}` equals the intended `main`
   release commit.
5. **Deploy.** From a clean checkout of that commit run
   `./scripts/deploy-nas.sh --version X.Y.Z`. The script ships committed HEAD,
   builds and pushes the versioned NAS image, recreates the compose project,
   and verifies health, authentication, and the LAN/tailnet paths. Do not use
   `--allow-unpushed-head` for a release.
6. **Record.** Add the merge commit, tag URL, clean-checkout evidence link,
   deploy timestamp,
   deployed image tag, and deploy verification result to the release note (or
   to a linked GitHub Release if the branch is already immutable). QA verifies
   those links before closing the release issue.

## Rollback

Identify the previous known-good tag before deploying. If deployment or smoke
verification fails, check out that tag and run
`./scripts/deploy-nas.sh --version <previous-version>`. Do not rewrite the failed
tag. Preserve the failed deployment evidence and open a corrective issue.

For changes that mutate stored workspace data, the release note must add a
version-specific backup/restore procedure. If no migration occurs, say so
explicitly.

## Evidence checklist

- [ ] Version and UTC-dated release note committed on candidate SHA
- [ ] Local clean-checkout `npm ci` and `npm run check` pass
- [ ] Board-inspectable clean-checkout evidence passes on the same SHA
- [ ] QA approval references the same SHA
- [ ] Merge commit is on `origin/main`
- [ ] Annotated immutable tag resolves to the merge commit
- [ ] NAS deploy command succeeds for the versioned image
- [ ] Post-deploy health, authentication, LAN, and tailnet checks pass
- [ ] Release record contains clickable source, validation, tag, and deployment evidence
