# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The project's own agent guide is imported below and is the reference for layout, build, test and
platform notes. This file only adds what is specific to this fork and to the local Windows machine.

@AGENTS.md

## What this fork is

A private fork of **Salvanza for Proxmox Backup Server** (`Salvanza/salvanza_client`, GPLv3,
formerly `tizbac/proxmoxbackupclient_go`), based on the tag `v2.0.0` (`b0bbc0fb`, 2026-11-08).

| Remote | Repository | Role |
|---|---|---|
| `origin` | `MaxtheIV/NimbusBackupClient` | this fork |
| `salvanza` | `Salvanza/salvanza_client` | upstream; sync from here |
| `upstream` | `rdemsystems/NimbusBackupClient` | the Nimbus Backup 0.4.x line; RDEM moved development to Salvanza, so this only gets critical fixes now. Reference only |

- **Build the unbranded Salvanza edition.** The brand comes from the program's file name
  (`gui/brand.go`), so keep the outputs named `salvanza-gui.exe` / `salvanza-svc.exe`; do not rename
  them to `nimbusbackup-*`. The colour-theme choice (Preferences > Theme) exists only in the unbranded
  app.
- **The fork's history before the switch** (a Nimbus Backup 0.3.0 fork with an Activity tab, a theme
  toggle, a German locale and a UI refresh) is kept on the branch `fork-0.3-activity`. Salvanza 2.0
  covers most of it (progress card for parallel runs, View Full Logs, per-user theme, 18 languages);
  do not port it back without a request.
- **The earlier Nimbus install's settings are taken over.** That 0.3 fork kept its data in
  `C:\ProgramData\NimbusBackup`. On Windows the service (and the app run as administrator before
  Run as Service) adopts an earlier install's folder once, when `C:\ProgramData\Salvanza` has no
  `config.json` yet: `C:\ProgramData\ProxmoxBackupClient` or another brand's folder, `NimbusBackup`
  included (`adoptWindowsState` in `gui/config.go`; `otherBrandFolders` and `adoptFolder` in
  `gui/identity.go`). The folder is moved, not copied (copied only when it cannot be renamed), and a
  copy of its settings files stays in `C:\ProgramData\Salvanza\pre-salvanza-<date>`. Without the
  service the app uses `~/.salvanza` and adopts only `~/.nimbusbackup`, `~/.etitechbackup` or
  `~/.proxmox-backup-guardian`. Old snapshots on PBS are not needed.

## Fork-only changes

Keep this list current. Each entry is a candidate pull request to Salvanza.

- `1b53eb88` pbscommon: share one zstd decoder instead of building one per chunk
  (`zstdDecodeAll` / `sharedZstdDecoder` in `pbscommon/crypt.go`).

When preparing a pull request to Salvanza, branch from `salvanza/master` and cherry-pick the change;
leave this `CLAUDE.md` out, it exists only in the fork.

## Syncing with Salvanza

```sh
git fetch salvanza --tags
git merge salvanza/master        # or a release tag
```

Read `CHANGELOG.md` of the new version first. Salvanza moves fast and renames freely (2.0 renamed the
programs, folders, API header and installer), so check this file and the list above after each sync.

## Local Windows environment

- Go is installed in `C:\Program Files\Go\bin` but is **not on PATH**. In Git Bash:
  `export PATH="/c/Program Files/Go/bin:$PATH"`; in PowerShell:
  `$env:PATH = "C:\Program Files\Go\bin;" + $env:PATH`.
- MinGW-w64 gcc (needed for the GUI, which uses cgo) is at `C:\Users\Max\Tools\mingw64\bin` and is
  on PATH.
- The installed Wails CLI (`%USERPROFILE%\go\bin\wails.exe`) is **v2.12.0**; this code base pins
  **v2.13.0**. Install it with `go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0` before a
  GUI build, never `@latest` (see AGENTS.md).
- Test a module from its own folder, with `GOWORK=off` for the standalone modules (`directorybackup`,
  `pkg/retry`, `pkg/security`) and for `cli`. CI runs `go mod tidy` before testing; on this machine a
  tidy can rewrite `go.mod` with only line-ending changes. Do not commit that drift.

```sh
cd pbscommon && GOWORK=off go test ./...
cd pbscommon && GOWORK=off go test -run TestZstd -v ./...
```

## Conventions

- Commit subjects follow upstream's style: `<area>: <what changed>`, lower case, e.g.
  `pbscommon: ...`, `gui: ...`, `docs: ...`, `ci: ...`. The body explains why.
- `CHANGELOG.md` is maintained (Keep a Changelog, user-facing wording); fork changes go under
  `## [Unreleased]` at the top.
- Code comments explain *why* and are dense by design; keep existing ones when editing nearby code.
