# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nimbus Backup — a Windows backup client for Proxmox Backup Server (PBS), GPLv3, forked from
`tizbac/proxmoxbackupclient_go`. It speaks the PBS backup protocol natively in Go; it does **not**
shell out to `proxmox-backup-client`. Ships as a Wails GUI, a Windows service, and standalone CLI
tools.

## Repository layout (multi-module Go workspace)

`go.work` composes seven modules; two more (`pkg/retry`, `pkg/security`) are pulled in only via
`replace` directives in `gui/go.mod`.

| Module | Role |
|---|---|
| `pbscommon/` | PBS protocol: HTTP/2 session, chunk upload, fixed/dynamic indexes, PXAR writer/reader, catalog, BuzHash chunker |
| `gui/` | The `main` package that builds **both** the GUI and the Windows service (build tags), plus the backup/restore/scheduler engine |
| `gui/api/` | Local HTTP API + client + execution-mode detection shared by GUI and service |
| `directorybackup/` | CLI: back up folders → PBS |
| `machinebackup/` | CLI: back up raw disks (`\\.\PhysicalDrive*`) |
| `nbd/` | CLI: expose a PBS fixed index as an NBD device — **Linux only** |
| `snapshot/` | VSS (Volume Shadow Copy) wrapper, Windows-only impl + no-op stub |
| `clientcommon/` | Cross-process locking, SMTP notifications, tray icon data |
| `pkg/retry`, `pkg/security` | Exponential backoff; input validation & credential sanitization |

## Build, test, lint

Commands below mirror `.github/workflows/build-and-release.yml`, the authoritative pipeline
(`.gitlab-ci.yml` is legacy and references files that no longer exist). Go may be installed but
**not on PATH** — it lives at `C:\Program Files\Go\bin`.

### The two rules that break builds if ignored

1. **Set `GOWORK=off` and run `go mod tidy` first.** Every CI job does this. `gui/go.sum` is *not*
   committed, and `gui/go.mod` is missing two packages that only a tidy resolves —
   `github.com/kardianos/service` (needed by the `service` build tag) and
   `github.com/getlantern/systray`. Workspace mode has no committed `go.work.sum` either.
2. **Build and test per-module, never from the repo root.** `go test ./...` at the root fails
   outright with `directory prefix . does not contain modules listed in go.work`, because no module
   lives at the root. This is also why `make test` does not work.

```powershell
$env:PATH = "C:\Program Files\Go\bin;" + $env:PATH
$env:GOWORK = "off"

# Non-GUI modules (CI matrix: ubuntu + windows) — all pass on Windows
cd pbscommon; go mod tidy; go test ./...      # same for pkg\retry, pkg\security
cd snapshot;  go mod tidy; go test ./...      # Windows only (VSS)

# gui module — see the two caveats below before running this on Windows
cd gui; go mod tidy; go test ./...

# A single test
cd gui; go test -run TestReconcileProvisionedJobs ./...

# Lint (config at gui/.golangci.yml, golangci-lint v2 schema; CI pins v2.12.2)
cd gui; golangci-lint run --timeout=5m

# Security scan
cd gui; gosec -severity high -confidence high ./...
```

### Two caveats when testing `gui/` on Windows

- **`-race` needs a C toolchain.** CI uses `go test -race` on ubuntu-latest with gcc installed. On a
  Windows box without gcc it aborts with `-race requires cgo; enable cgo by setting CGO_ENABLED=1`.
  Drop `-race` locally.
- **Two tests fail on Windows, and one writes to your real config.** `TestConfigSaveLoad` and
  `TestGetConfigPath` (`gui/config_test.go`) set `$HOME` and expect the Unix branch of
  `getConfigDir()`, but on Windows `%ProgramData%` is always set and always wins — so they fail, and
  `TestConfigSaveLoad` calls `config.Save()`, which writes a dummy `pbs.example.com` config straight
  into the live `C:\ProgramData\NimbusBackup\config.json` (package init also creates the log files
  there). CI never catches this because the `gui` test job runs on ubuntu-latest only. Back that file
  up before running the gui suite on a machine with a real Nimbus install.

### Building the three binaries

```powershell
# GUI — NimbusBackup.exe. CLI is pinned on purpose: @latest is non-deterministic, and the
# v2.8.0 tag matching gui/go.mod's library does not build under Go 1.25.
go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0
cd gui/frontend; npm install
cd gui; $env:GOWORK="off"; wails build -clean -platform windows/amd64 -ldflags "-X main.appVersion=$VERSION"

# Windows service — NimbusBackupSVC.exe (same package, `service` build tag)
cd gui; $env:GOWORK="off"
go build -tags service -trimpath -buildmode=pie -ldflags "-s -w -X main.appVersion=$VERSION" -o build/bin/NimbusBackupSVC.exe

# CLI tools
make cli          # -> dist/proxmoxbackup-directory, dist/proxmoxbackup-machine (+ -nbd on Linux)

# MSI (needs WiX 3.14 + both .exe in gui/build/bin/)
cd installer/wix
candle.exe "-dProductVersion=$VERSION_MSI" Product.wxs -ext WixUIExtension -ext WixUtilExtension
light.exe Product.wixobj -ext WixUIExtension -ext WixUtilExtension -out NimbusBackup.msi
```

The Makefile is convenient for `make cli` / `make gui`, but treat CI as authoritative: **`make service`
is broken** (it builds from `cmd/service/`, which does not exist — use the `-tags service` command
above), and `make test` runs `go test ./...` from the root in workspace mode, which is not the
per-module `GOWORK=off` path CI verifies.

Version source of truth is `gui/wails.json` → `info.productVersion`, injected at link time as
`main.appVersion` (`gui/version.go`). Tag builds override it with the git tag; the MSI needs a strict
`x.y.z` so branch builds strip the `-dev-<sha>` suffix for WiX only.

## Architecture

### One package, three execution surfaces

`gui/` is a single `package main` that compiles into two different programs via build tags:

- `!service` → `main.go` (Wails app), `logging_gui.go`
- `service` → `service_main.go` (kardianos/service entrypoint), `logging_service.go`, `app_service_stubs.go`
- untagged → `App` and everything real: `backup_inline.go`, `restore_inline.go`, `scheduler.go`,
  `config.go`, `backup_analysis.go`, `restore_search.go`

**Consequence:** adding a method the frontend calls usually means adding a matching stub in
`app_service_stubs.go`, or the `service` build stops compiling. Windows-specific code follows the
same discipline — `*_windows.go` / `*_stub.go` / `*_nonwindows.go` pairs for tray, VSS, admin
detection, single-instance, and NTFS metadata.

### Mode detection: GUI ↔ service

At startup the GUI probes `http://127.0.0.1:18765/status` (`gui/api/mode.go`):

- **ModeService** — the service is up. The GUI becomes a thin client: backups and job CRUD go over
  HTTP (`gui/api/client.go`), and the privileged service does the VSS work.
- **ModeStandalone** — no service. The GUI runs the backup in-process and needs admin rights for VSS
  (`ShouldWarnVSS` decides whether to warn).

The service itself is constructed via `NewAppForService`, which pins `ModeStandalone` and sets
`isServiceProcess` so it never re-detects and never calls itself.

Local API auth (`gui/api/auth.go`): a random 32-byte token in `%ProgramData%\NimbusBackup\api-token`,
sent as `X-Nimbus-Token` and compared in constant time; **any request carrying an `Origin` header is
rejected 403** (a browser cannot omit it cross-origin, so this closes CSRF); bodies capped at 1 MiB;
listener bound to `127.0.0.1` only.

### Backup path

`RunBackupInline` (`gui/backup_inline.go`) → optional VSS snapshot (`snapshot/`) → `PXARArchive`
walk (`pbscommon/pxar.go`) → BuzHash content-defined chunking → dedup against the previous
snapshot's known digests → chunk upload over one HTTP/2 session (`pbscommon/pbsapi.go`) → dynamic
index close → manifest.

Notable invariants:
- A per-destination mutex keyed on `BaseURL + Datastore` (`getBackupLock`) serializes concurrent runs.
- `pbscommon.CloseAllActive()` is wired to SIGINT/SIGTERM and Wails shutdown. Skipping it leaves the
  PBS-side snapshot lock held until TCP keepalive reaps it (~16 min), blocking the next verify.
- `isFatalSessionError` distinguishes errors that require a fresh `Connect()` with a new backup-time.
- Exclusions live in `pbscommon/pxar.go` (`isExcluded`, `shouldSkipSystemFolder/File`) — glob via
  `path.Match`, basename match when the pattern has no separator. System exclusions
  (`System Volume Information`, `pagefile.sys`, …) are what keep a 1 TB-reported drive from
  ballooning past its real ~141 GB.
- Windows ACL/attribute capture goes through the `pbscommon.MetaCollector` interface, implemented in
  `gui/backup_meta_windows.go`, serialized as a gzipped-JSON **virtual file** inside the archive root.
- Per-run outcome is `BackupStatus` (`gui/backup_status.go`) — engine return value, `OnResult`
  payload, and a `.blob` sidecar listed in the manifest, all one struct on purpose.

### Restore path

`pbscommon/didx_reader.go` exposes a snapshot's dynamic index as an `io.ReaderAt` with a chunk cache,
so `pxar_reader.go` can walk and extract without downloading everything;
`didx_assembler.go` is the full-download variant. `catalog_reader.go` parses the PBS catalog for fast
browsing; `gui/restore_cache.go` persists listings (schema-versioned — bump `cachedTreeSchema` when
`SnapshotEntry` changes). Extraction guards against path traversal (`isUnsafeArchivePath`) and
supports Original / Alternate-Abs / Alternate-Relative destinations.

### Scheduler and unattended provisioning

`gui/scheduler.go` owns `scheduled_jobs.json` + job history. The 0.3.0 headline feature is
`ReconcileProvisionedJobs`: `config.json` may carry a `scheduled_jobs` array, reconciled at startup
**by `id`** — upsert, never duplicate; a still-valid `nextRun` is preserved so re-pushing an unchanged
config doesn't re-fire; GUI-created jobs whose ids aren't listed are untouched; a missing `id` is
derived deterministically from the name. This is what makes a single Ansible-pushed file sufficient.
See `examples/automation/` and `gui/scheduler_provision_test.go`.

### Multi-PBS config

`Config` (`gui/config.go`) holds `PBSServers map[string]*PBSServer` plus `DefaultPBSID`. Legacy
top-level fields (`baseurl`, `authid`, …) still exist and auto-migrate into `PBSServers["default"]`
on load. `EffectivePBS()` is the bridge for code that still reads the flat fields — prefer it over
touching the legacy fields directly. `sanitized()` strips every secret and **must** be used on any
path handing config to the frontend.

TLS: when `certfingerprint` is set, CA validation is skipped but the leaf cert's SHA-256 is pinned
(`buildTLSConfig`); otherwise normal CA validation applies. `FetchServerFingerprint` implements
trust-on-first-use for self-signed servers.

### Frontend

`gui/frontend/` — Vite + React 18, effectively one file (`src/App.jsx`, ~2700 lines) plus
`src/i18n/translations.js` (FR/EN). There are **no generated `wailsjs` imports**: Go methods are
captured from `window.go.main.App.*` at module load behind an `if (window.go)` guard. Exposing a new
Go method therefore takes three edits — the method on `App`, a `service`-tag stub, and the capture
block at the top of `App.jsx`. `frontend/dist` is embedded via `//go:embed all:frontend/dist`, so a
Go-only build without `npm run build` embeds a stale bundle.

### CLI tools

`directorybackup` takes `--config file.json` with every field overridable by a flag (flags win). Exit
codes are contractual — `0` success, `1` fatal, `2` another backup holds the process lock, `3`
completed partially (unreadable files; snapshot committed but incomplete). Orchestrators depend on
these; don't change them casually.

### Runtime state (Windows)

Everything lives flat in `%ProgramData%\NimbusBackup\` so the GUI (user) and service (LocalSystem)
share it: `config.json` (0600, written atomically via temp-file + fsync + rename),
`scheduled_jobs.json`, `api-token`, and the rotating logs — no `logs\` subdirectory. Log filenames
are what distinguish the two surfaces: `backup-gui.log`/`service-gui.log` vs
`backup-service.log`/`service-service.log` (on Linux, `/var/log/nimbusbackup`). Note that atomic
writes protect against a torn file but **not** against GUI/service lost updates; there is no
cross-process config lock yet.

## Conventions

- **Comments explain *why*, not *what*, and frequently cite security-audit IDs** (`H-01`, `M-03`,
  `Q-9`, `v2-H-06`) that trace back to specific findings. Preserve those references when editing
  nearby code, and match the density — this codebase is unusually comment-heavy by design.
- Code comments are English. Some user-facing Go error strings are French (legacy); new UI text
  belongs in `translations.js`, not in Go.
- Project docs are mixed: `TODO.md`, `MULTI_PBS_GUIDE.md`, `installer/*.md` are French;
  `README.md` (+ `README.fr.md`) and `CHANGELOG.md` are English.
- `CHANGELOG.md` follows Keep a Changelog and is genuinely maintained — add user-visible changes there.
- `TODO.md` is the live roadmap and records *who asked for what* (named customers/prospects); it's the
  best source for current priorities.

## Files that will mislead you

- `FEATURES_STATUS.md` — frozen at v0.1.93 and says restore was removed. Restore is implemented
  (`gui/restore_inline.go`, `gui/restore_search.go`, `pbscommon/pxar_reader.go`).
- `docs/RESTORE_GUIDE.md` — marked "À IMPLÉMENTER"; also outdated for the same reason.
- `build.sh`, `build_gui.sh`, `build.bat`, `build_gui.bat`, `build_gui_windows_docker.sh`,
  `Dockerfile.gui` — all pre-Wails, they install and build against **Fyne**. Dead.
- `.gitlab-ci.yml` — legacy; copies `GUI_README.md` / `CONFIG_FORMAT_SPEC.md`, neither of which exists.
- `gui/api/INTEGRATION.md` — a design doc for work already shipped; the code has moved past it.
- `gui/machine_backup_*.go.disabled` — GUI-side machine backup is disabled (Windows Defender
  false positives on unsigned binaries); the `machinebackup` CLI still works.
- `.github/workflows/release.yml` — trigger commented out; `build-and-release.yml` is the live one.
