# Releasing Fonds

The maintainer's playbook for publishing a version. The
[Release workflow](.github/workflows/release.yml) does the work; this page is
the human side of it. Only the maintainer tags and approves releases.

## Versions

Versions are `X.Y.Z`, or `X.Y.Z-rc.N` for a release candidate; nothing else
publishes. While Fonds is `0.x`, the minor version marks features and breaking
changes and the patch version compatible fixes. The root `package.json` holds the
version; `node scripts/release-version.mjs X.Y.Z` sets it in every manifest,
lockfile and `FONDS_VERSION`, and the workflow refuses a tag that differs.

Each release publishes:

| Where                  | Release `vX.Y.Z`                                    | Candidate `vX.Y.Z-rc.N`          |
| ---------------------- | --------------------------------------------------- | -------------------------------- |
| npm `fonds-finance`    | `X.Y.Z` on `latest`                                 | `X.Y.Z-rc.N` on `next`           |
| `ghcr.io/sagiba/fonds` | `X.Y.Z`, then `X.Y` and `latest` if not backwards   | `X.Y.Z-rc.N` only                |
| GitHub Release         | Notes, tarball, `compose.yaml`, manifest, checksums | The same, marked as a prerelease |

A candidate runs the entire path. Use one whenever the release path itself
changed: a failure then costs an `rc` number, not a version.

## Cutting a release

1. Open a pull request that runs `node scripts/release-version.mjs X.Y.Z` and
   nothing else, and merge it once its checks pass.
2. On an up-to-date `main`, tag the merged commit with an annotated tag. Its
   message becomes the human summary at the top of the GitHub Release, above
   the generated pull-request notes; lead with what users will notice.

   ```sh
   git tag -a vX.Y.Z -F summary.md
   git push origin vX.Y.Z
   ```

3. The workflow checks that the tag names the manifests' version and a commit on
   `main`, reruns every check on that commit, packs and tests the npm tarball
   once, and builds the image from it on amd64 and arm64 runners, smoke-testing
   each pushed digest.
4. **Approve the `release` environment.** The workflow tags the image with the
   exact version, creates a draft GitHub Release and stages the npm version.
5. **Approve the staged version** on npmjs.com (the package's staged versions)
   with your npm second factor. This makes it public.
6. Within 30 minutes the workflow sees the version, checks that the registry
   serves the tarball's exact bytes, moves the rolling image tags and publishes
   the release. Confirm `docker pull ghcr.io/sagiba/fonds:X.Y.Z` works signed
   out.

## Resuming and recovering

- **Approval came after the wait.** Approve the staged version, then run the
  Release workflow manually with the tag and the original run's ID. It verifies
  the retained artifacts against the draft and the registry and finishes; it
  never rebuilds, repacks or restages.
- **A job failed before publication.** Re-run the failed jobs. Existing exact
  image tags and npm versions must match the run's own digests and tarball, or
  the run stops.
- **Anything already public is never replaced.** A rejected stage, or a defect
  found after npm accepted a version, means a new version (or `rc` number). Tags
  are not moved or reused.
- Releases run one at a time; a queued run waits for the current one,
  approvals included.

## One-time setup

- **npm trusted publisher** on `fonds-finance`: repository `sagiba/fonds`,
  workflow `release.yml`, environment `release`, with "Allow npm publish" and
  "Allow npm dist-tag" both off, so CI can only stage. A new configuration
  expires unless a publish completes within two days, so create it just before
  the first candidate. After the first release, require two-factor
  authentication and disallow tokens.
- **GitHub environment `release`**: deployments only from tags matching `v*`,
  with the maintainer as required reviewer and self-review prevention off.
- **Tag ruleset** restricting creation, update and deletion of `v*` tags.
- **GHCR**: after the first push, make the `fonds` package public and link it to
  the repository.

## Dependency updates and license texts

The npm package bundles its dependencies, so it carries their license texts.
When a dependency update changes a package whose npm archive omits its license,
or the libraries another package compiles in, packing fails and names the text
to review. Add the reviewed upstream text to `deploy/npm/licenses/` and its
source to `scripts/npm-package.mjs`, then rerun the checks.
