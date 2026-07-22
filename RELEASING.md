# Releasing yamlet

A release is **one click**. From the repo's **Actions** tab, run the **Release**
workflow and enter a version (e.g. `0.1.0`, no leading `v`). That single action:

1. cross-compiles the four target binaries (macOS + Linux, Intel + arm64),
2. packages each as `yamlet-<version>-<target>.tar.gz` with a `SHA256SUMS` file,
3. creates the `v<version>` tag and publishes a GitHub Release with those assets,
4. renders `Formula/yamlet.rb` from [`tooling/packaging/yamlet.rb.tmpl`](tooling/packaging/yamlet.rb.tmpl)
   and pushes it to the [`homebrew-yamlet`](https://github.com/RicardoMonteiroSimoes/homebrew-yamlet)
   tap.

Users then get it with `brew tap RicardoMonteiroSimoes/yamlet && brew install yamlet`
(and `brew upgrade yamlet` after each release). Pushing a `v*` tag by hand runs
the same pipeline.

The pipeline is defined in [`.github/workflows/release.yml`](.github/workflows/release.yml)
and driven by two checked-in scripts you can also run locally:

- [`tooling/scripts/build-release.sh <version>`](tooling/scripts/build-release.sh) —
  builds and packages all four targets into `tooling/dist/`. Safe to run locally;
  it stamps the version into `src/version.ts` only for the build and restores it
  afterwards, so your tree stays clean.
- [`tooling/scripts/update-tap.sh <version>`](tooling/scripts/update-tap.sh) —
  renders the formula from the checksums and pushes it to the tap (needs
  `TAP_TOKEN`).

## One-time setup

Two things must exist before the first release. Do them once:

### 1. The tap repository

Create a public repo named **`homebrew-yamlet`** under the `RicardoMonteiroSimoes`
account. The `homebrew-` prefix is required — Homebrew derives the tap from it, so
`brew tap RicardoMonteiroSimoes/yamlet` resolves to `homebrew-yamlet`. It can start
empty; the first release commits `Formula/yamlet.rb` into it. A one-line README
pointing back here is a nice touch but optional.

### 2. The `HOMEBREW_TAP_TOKEN` secret

The workflow's default `GITHUB_TOKEN` can only write to this repo, so pushing the
formula to the *other* repo needs its own token.

1. GitHub → **Settings → Developer settings → Fine-grained personal access tokens
   → Generate new token**.
2. Scope it to **only** the `homebrew-yamlet` repository.
3. Grant **Repository permissions → Contents: Read and write** (nothing else).
4. Give it a short expiry you're comfortable rotating (e.g. 90 days) and copy the
   token.
5. In the **Yamlet** repo → **Settings → Secrets and variables → Actions → New
   repository secret**, name it `HOMEBREW_TAP_TOKEN`, and paste the token.

When the token expires, regenerate it and update the secret — nothing else changes.

## Versioning

`src/version.ts` stays at the `0.0.0-dev` placeholder in the source tree; the build
stamps the real version in, so a released binary reports it via `yamlet --version`
while a from-source dev build reports `0.0.0-dev`. The Git tag is the source of
truth for the version — there is no separate file to bump.
