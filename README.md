# VFS software release Action

This Node 24 JavaScript Action publishes a signed, cross-platform VFS release from build artifacts. Create the application in the VFS Console first. Save its one-time Ed25519 seed as `VFS_SIGNING_KEY`, and a bucket-scoped write API key as `VFS_API_KEY` in GitHub Actions secrets. The server stores public keys only.

Create `.vfs/assets.yaml` in your repository:

```yaml
assets:
  - path: dist/my-app-windows-x64.exe
    os: windows
    arch: x64
    kind: installer
  - path: dist/my-app-darwin-arm64.dmg
    os: darwin
    arch: arm64
    kind: installer
  - path: dist/my-app-linux-x64.tar.gz
    os: linux
    arch: x64
    kind: archive
```

Paths are relative to the checkout and must resolve to regular files inside it. Each OS/architecture/kind combination appears once. OS and architecture identifiers use lowercase letters, digits, hyphens and underscores; kinds and app/channel slugs use letters, digits and hyphens. Asset filenames can be overridden with `filename`.

```yaml
name: Release application
on:
  push:
    tags: ['v*']
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
      - run: ./scripts/build-artifacts.sh
      - uses: cubetiqlabs/vfs-action@v0.1.0
        id: vfs
        with:
          endpoint: https://vfs.example.com
          bucket: desktop
          app: my-app
          channel: stable
          assets-file: .vfs/assets.yaml
          api-key: ${{ secrets.VFS_API_KEY }}
          signing-key: ${{ secrets.VFS_SIGNING_KEY }}
      - run: echo "${{ steps.vfs.outputs.manifest-url }}"
```

`version` defaults to the tag name with a leading `v` removed. You can set it explicitly. The Action returns `manifest-url` and `version`. A retry with the same version and bytes is safe: uploads can deduplicate, release publication is idempotent, and channel conflicts are retried after fetching the latest head. A changed payload for an existing version fails. Use a new SemVer version for changed artifacts.

Use repository or environment secret controls to limit access to the API key and signing seed. Keep the VFS endpoint on HTTPS. The Action masks both secrets in GitHub logs and never uploads the seed. Review the release manifest with the [updater guide](https://docs.vfs.cubis.tech/docs/software-releases).
