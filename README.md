# VFS Actions

Three Node 24 JavaScript Actions share this package:

| Action | Use it to |
| --- | --- |
| [`cubetiqlabs/vfs-action/upload`](#upload-and-download-artifacts) | replace `actions/upload-artifact` |
| [`cubetiqlabs/vfs-action/download`](#upload-and-download-artifacts) | replace `actions/download-artifact` |
| [`cubetiqlabs/vfs-action`](#software-release-action) | publish a signed, cross-platform software release |

## Upload and download artifacts

Artifacts live in a VFS bucket instead of GitHub's artifact storage, so they are not subject to GitHub's storage quota and you choose the region, store provider and retention. The inputs follow `actions/upload-artifact@v4` and `actions/download-artifact@v4`; a typical migration is a change to the `uses:` line plus the connection settings.

```yaml
env:
  VFS_ENDPOINT: https://vfs.example.com
  VFS_BUCKET: ci
  VFS_API_KEY: ${{ secrets.VFS_API_KEY }}

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: ./scripts/build.sh # produces next-build.tgz
      - name: Upload build artifact
        if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')
        uses: cubetiqlabs/vfs-action/upload@v0.2.2
        with:
          name: nextjs-build-tar
          path: next-build.tgz
          if-no-files-found: error
          retention-days: 1

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Download build artifact
        uses: cubetiqlabs/vfs-action/download@v0.2.2
        with:
          name: nextjs-build-tar
          path: .
```

Create a bucket-scoped API key with read and write access and store it as the `VFS_API_KEY` secret. The endpoint must be an HTTPS origin. Each of `endpoint`, `api-key` and `bucket` can be given as a step input instead of the `VFS_ENDPOINT`, `VFS_API_KEY` and `VFS_BUCKET` environment variables; an input wins.

### Upload

| Input | Default | Description |
| --- | --- | --- |
| `name` | `artifact` | Artifact name, unique within the run. `" : < > \| * ? \ /` and line breaks are not allowed. |
| `path` | required | Files, directories or globs, one per line. A line starting with `!` excludes matches. |
| `if-no-files-found` | `warn` | `warn`, `error` or `ignore` when nothing matches. |
| `retention-days` | `0` | Days before the server deletes the artifact. `0` uses the bucket default (permanent unless the bucket has a lifecycle TTL). |
| `compression-level` | `6` | Gzip level 0–9. Use `0` for files that are already compressed, such as a `.tgz`. |
| `overwrite` | `false` | Replace an artifact of the same name in this run instead of failing. |
| `part-size-mb` | `16` | Archives larger than this are uploaded in parts of this size. Capped by the server's upload limit. See [Large artifacts](#large-artifacts). |
| `upload-concurrency` | `3` | Parts uploaded at the same time. |
| `include-hidden-files` | `false` | Include files and directories whose names start with a dot. |

Outputs: `artifact-id`, `artifact-url` (direct download link, empty for an artifact stored in parts) and `artifact-digest` (`sha256:<hex>` of the whole archive).

The archive is rooted at the least common ancestor of the search paths, as with `actions/upload-artifact`: `path: dist` extracts as the contents of `dist`, and `path: next-build.tgz` as `next-build.tgz`. Hidden files are judged below each search path, so naming `.build/` explicitly still uploads it.

### Large artifacts

An archive larger than `part-size-mb` (16 MiB by default) is split into parts that upload three at a time. Nothing changes in the workflow. Small parts matter for two reasons:

- A proxy such as Cloudflare gives up on a request after 100 seconds (`524: A timeout occurred`). One big request can easily exceed that, while a 16 MiB part does not.
- VFS Server refuses a request bigger than its upload limit (`UPLOAD_ALLOW_SIZE`), which is why a big archive fails with `file is N bytes, over the M byte upload limit`. Parts never exceed that limit; the Action asks the server for it.

How the upload stays reliable:

- **No blind retries.** When a request ends in a gateway timeout, the origin has often received the whole part and finishes it moments later. The Action waits for the part to appear on the server, matching its checksum, instead of sending it again and racing the first request. It waits up to two minutes for a `504`, `524` or its own timeout, ten seconds for a `502` or a dropped connection, and resends at once when the origin was down or unreachable (`521`-`523`).
- **Backs off a slow server.** After a gateway timeout the remaining parts upload one at a time.
- **Bounded requests.** Each request has a timeout sized to its length, so a stalled connection cannot hang the job.
- **Readable errors.** A proxy's HTML error page is reported as `HTTP 524 (the origin did not answer in time)`.

How integrity is kept:

- Every part is hashed before it is sent and the server confirms that checksum. A part starts with a fixed 4 KiB header naming the artifact, run, attempt and part, so identical slices stay distinct on servers that deduplicate by content hash.
- When the last part is stored, the Action reads the artifact back and checks every part's ID, size and SHA-256, and the whole archive's, before reporting success.
- An artifact is visible only when all its parts exist. If the upload fails, in-flight parts are aborted and anything stored under that attempt is deleted. Replacing an artifact removes the objects it supersedes, including leftover parts of a larger earlier upload.
- Download fetches the parts in order, checks each part and then the whole archive before extracting, and refuses parts that do not belong to the artifact.

Every part counts as a file against the bucket's file and storage quotas, and the upload stops before sending anything if the bucket cannot hold them all. `artifact-url` is empty for an artifact stored in parts. To keep a file as one object, set `part-size-mb` up to the server's limit. The VFS resumable session API is not used: it enforces the same upload limit and cannot carry an artifact name, run or retention.

### Download

| Input | Default | Description |
| --- | --- | --- |
| `name` | | One artifact to download. Its files go straight into `path`. |
| `artifact-ids` | | Comma or newline separated IDs. Takes precedence over `name` and `pattern`. |
| `pattern` | | Glob on artifact names, one per line. Every match goes to `path/<artifact name>`. |
| `merge-multiple` | `false` | Extract all matches straight into `path`. A later artifact wins a file conflict. |
| `path` | `.` | Destination, relative to the workspace. `~` is expanded. |
| `run-id` | current run | Download from another run. |
| `repository` | current repo | Repository of that run, as `owner/name`. |

With no `name`, `artifact-ids` or `pattern`, every artifact of the run is downloaded. The output `download-path` is the absolute destination. Cross-run downloads authenticate with the VFS API key, so no `github-token` is needed:

```yaml
- uses: cubetiqlabs/vfs-action/download@v0.2.2
  with:
    pattern: build-*
    merge-multiple: true
    run-id: ${{ inputs.release-run-id }}
```

### How it differs from GitHub's actions

- **tar.gz, not zip.** File permissions survive the round trip, so an executable uploaded in one job is still executable in the next. The archive also carries a small `.vfs-artifact.json` manifest, which download does not extract.
- **Verified end to end.** Download checks the size and SHA-256 against what the server recorded before it extracts, and extraction refuses paths outside the destination and skips links.
- **Re-runs just work.** A re-run attempt replaces the artifact left by an earlier attempt of the same run. Within one attempt a duplicate name fails unless `overwrite: true`, which catches matrix jobs that forgot to make names unique. The check is made before the upload, so two jobs racing on one name can still overwrite each other.
- **Artifact IDs are strings** (the VFS file ID). They work with `artifact-ids` across jobs and runs.
- **Server-side duplicates are fine.** Servers that set `UPLOAD_NODUPLICATED_ENABLED` still store one artifact per name.
- **Downloads are served by VFS Server's public `/v/{bucket}/{id}` route.** IDs are unguessable but not secret-protected, so treat `artifact-url` as a credential and keep sensitive build output out of artifacts, or in a bucket behind your own access layer.

## Software release Action

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
      - uses: cubetiqlabs/vfs-action@v0.2.0
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
