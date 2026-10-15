# ADR 0016: AVD-Deploy becomes its own repository

Status: Accepted. Date: 2026-10-15. Supersedes the location part of [ADR 0008](0008-isolate-v2.md).

## Context

V2 was built under `v2/` in the AzureVirtualDesktop repository so it couldn't affect the V1 scripts and templates (ADR 0008). It now has its own CLI, contract, Bicep, web wizard, tests and release-pinned host prep script, and it has been deployed end to end in a sandbox. Keeping it inside the V1 repository mixes two products' issues, history and releases. It also makes `v2\` prefixes part of every command and path. The [project brief](../../PROJECT-BRIEF.md) planned to extract an independent repository before separate production releases.

## Decision

V2's contents move to the root of a new repository, **AVD-Deploy** (local folder `C:\GitHub\AVD-Deploy`). Commands become `.\avd.ps1 …`.

The isolation rule from ADR 0008 still applies in spirit: V2 never modifies or depends on V1 files.

Internal names stay unchanged: `$v2Root`/`$script:V2Root`, the `avdv2-*` deployment names and the `avdv2-kerberos-restart` VM tag. Existing estates already carry the tag, and renaming it would make Deploy treat restarted hosts as unrestarted.

The session host prep script is still pinned to the last release published from AzureVirtualDesktop (`v2/scripts/session-host-prep.ps1` at commit `bf238b6`). After the first push of this repository, publish the script from here and repin `contracts/artifacts.json` (see [how-it-works](../how-it-works.md#releasing-the-session-host-prep-script)).

## Consequences

- One product per repository; Copilot and contributors get repo-wide instructions in `.github/copilot-instructions.md`.
- The `v2/` folder in AzureVirtualDesktop is now historical. New work happens here only, so don't keep both in sync.
- Pinned artifact URIs in configurations made before the move keep working, because the old commit URLs are immutable.
