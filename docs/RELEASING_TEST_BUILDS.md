# Releasing test builds (unsigned) to testers

How to hand a downloadable Orbit build to a small group of testers without code
signing, notarization, or exposing the source.

This is separate from the signed production release path (see
`BUILD_AND_RELEASE.md` and the `release` job in `.github/workflows/build.yml`).

## The setup (already done)

These were one-time actions taken to make test releases possible:

1. **Public releases-only repo created:** `gvensan/orbit-releases`. It holds
   nothing but the installer binaries and a README. The application source
   stays in the private `gvensan/orbit-graph` repo. Testers download from this
   public repo, so no GitHub account or login is required.

2. **Manual build workflow added:** `.github/workflows/release-unsigned.yml` in
   this (private) repo. It is triggered by a button (`workflow_dispatch`), not
   by pushes or tags. When run it:
   - builds unsigned installers for all six OS/architecture pairs (macOS
     arm64/x64, Windows x64/arm64, Linux x64/arm64),
   - smoke-tests each packaged app on a native runner,
   - publishes them together as a single **pre-release** to `orbit-releases`.

## One-time setup still required (do this once)

The private repo cannot write to the public repo with its built-in token, so it
needs a token you create.

1. GitHub -> **Settings -> Developer settings -> Fine-grained tokens ->
   Generate new token**.
2. **Resource owner:** `gvensan`.
3. **Repository access:** Only select repositories -> `orbit-releases`.
4. **Permissions:** Repository permissions -> **Contents: Read and write**.
5. Generate and copy the token.
6. Store it as a secret on the **private** repo:

   ```
   gh secret set RELEASES_REPO_TOKEN --repo gvensan/orbit-graph
   ```

   Paste the token when prompted. The secret lives in `orbit-graph` (where the
   workflow runs); it grants write access to `orbit-releases` (where binaries
   land).

You also need the workflow to exist on GitHub before the button appears:

```
git push origin main
```

`workflow_dispatch` workflows only show up in the Actions tab once they are on
the remote default branch.

## Releasing a test binary: step by step

1. **Make sure your changes are pushed** to `main` (the build uses the latest
   commit on the branch you run it from):

   ```
   git push origin main
   ```

2. Open the repo on GitHub -> **Actions** tab.
3. Select the **"release-unsigned"** workflow in the left sidebar.
4. Click **Run workflow** (top right).
5. (Optional) Type a **label** such as `alpha` or `demo`. Leave blank for a
   plain test build.
6. Click the green **Run workflow** button and wait for all jobs to finish
   (roughly 10-20 minutes; six platforms build in parallel, then one publish
   job runs).
7. When it is green, the release appears at:

   ```
   https://github.com/gvensan/orbit-releases/releases
   ```

   Tagged `v<version>-<label>.<run-number>`, e.g. `v0.1.0-test.3`. Each run
   produces a new pre-release, so previous ones stay available.

8. Share the link. Anyone can download directly, no login needed.

## What testers should expect (unsigned builds)

Because these builds are not code-signed, the OS warns on first launch. This is
normal and only happens once. The releases repo README says the same thing:

- **macOS:** right-click Orbit and choose **Open**, then confirm. Or run
  `xattr -dr com.apple.quarantine /Applications/Orbit.app`.
- **Windows:** on the SmartScreen prompt, choose **More info -> Run anyway**.
- **Linux:** `.AppImage` needs the executable bit
  (`chmod +x Orbit-*.AppImage`); `.deb` / `.rpm` install normally.

## The three build paths (don't confuse them)

| You do | What runs | Where binaries land | Signed? |
| --- | --- | --- | --- |
| Push to `main` | `build.yml`: test + package | Workflow artifacts (Actions tab, private, 14-day) | No |
| Click **release-unsigned** | `release-unsigned.yml` | Public pre-release in `orbit-releases` | No |
| Push a `v0.1.0` tag | `build.yml`: test + release | Public release in `orbit-graph` | Yes (needs signing secrets) |

Only the middle row publishes to the public `orbit-releases` repo, and only when
you press the button. Nothing there happens automatically.

## Notes

- **Version:** the tag uses the `version` from `package.json` (currently
  `0.1.0`). Bump it there when you want a new version number in the release tag.
- **Cleanup:** delete old test pre-releases from the `orbit-releases` Releases
  page whenever you like; it does not affect builds.
- **Signed production releases** are a different, later step and require Apple
  and Windows signing certificates. See `BUILD_AND_RELEASE.md`.
