# CodeForge Open Source Software (OSS) License Audit

**Audit Date**: September 10, 2026
**Auditor**: Primary Audit Agent (Pass 1)
**Standard**: SPDX License Identifiers, Open Source Initiative (OSI) Compliance, Packaging & Distribution Analysis.

---

## 1. Executive Summary & Verification Findings

This audit evaluates the open-source licensing posture of CodeForge across two distinct scopes:
1. **The Development Monorepo (`package-lock.json`)**: Contains 686 total packages spanning build tooling, test harnesses (Vitest), type definitions, and dev scripts.
2. **The Certified Packaged Release Binary (`app.asar` / `win-unpacked`)**: The actual executable artifacts distributed to end users (`CodeForge-Setup-0.2.0.exe` and `CodeForge-Portable.exe`).

### Material Audit Conclusions:
- **Zero Shipping Copyleft Dependencies**: **VERIFIED**. Across all 47 external npm packages bundled inside the production `app.asar` archive, 100% are permissively licensed (MIT, ISC, Apache-2.0, BSD-3-Clause). Exactly zero GPL, AGPL, LGPL, MPL, or SSPL copyleft packages ship in the desktop binary.
- **Root `LICENSE` File Absence**: **CONFIRMED DEFECT**. Root `package.json` and `README.md` represent CodeForge as an MIT-licensed open-source project; however, the physical root `LICENSE` file is missing from the repository.
- **Internal Package License Metadata Omission**: **CONFIRMED DEFECT**. All 20 `@codeforge/*` workspace packages bundled in `app.asar` omit the `"license"` field in their individual `package.json` files, causing compliance scanners to flag them as `UNKNOWN`.

---

## 2. Packaged Shipping Dependency Graph Audit (`app.asar`)

An empirical inspection of `apps/desktop/release/win-unpacked/resources/app.asar` was conducted by programmatically reading every `package.json` entry in the archive.

### Distribution by License Type:
- **MIT License**: 33 packages (including `codeforge-desktop` and dependencies like `better-sqlite3`, `zod`, `pg`).
- **ISC License**: 8 packages (`split2`, `pg-int8`, `inherits`, `ini`, `semver`, `once`, `chownr`, `wrappy`).
- **Apache-2.0**: 3 packages (`typescript`, `detect-libc`, `tunnel-agent`).
- **BSD-3-Clause**: 1 package (`ieee754`).
- **Dual/Permissive Multi-License**: 2 packages (`expand-template`: MIT OR WTFPL; `rc`: BSD-2-Clause OR MIT OR Apache-2.0).
- **Copyleft (GPL, LGPL, AGPL, MPL, SSPL)**: **0 packages (0%)**.

### Complete Packaged Dependency Inventory:

| Package Name | Bundled Version | SPDX License | Redistribution & Notice Requirements |
|---|---|---|---|
| `better-sqlite3` | ^12.11.1 | **MIT** | Retain copyright notice and permission notice. Incorporates SQLite source code in the Public Domain / SQLite Blessing. |
| `bindings` | ^1.5.0 | **MIT** | Retain copyright notice. |
| `file-uri-to-path` | ^1.0.0 | **MIT** | Retain copyright notice. |
| `pg` | ^8.13.1 | **MIT** | Retain copyright notice. |
| `pg-connection-string` | ^2.7.0 | **MIT** | Retain copyright notice. |
| `pg-pool` | ^3.7.0 | **MIT** | Retain copyright notice. |
| `pg-protocol` | ^1.7.0 | **MIT** | Retain copyright notice. |
| `pg-types` | ^2.2.0 | **MIT** | Retain copyright notice. |
| `pgpass` | ^1.0.5 | **MIT** | Retain copyright notice. |
| `pg-int8` | ^1.0.1 | **ISC** | Retain ISC copyright and permission notice. |
| `postgres-array` | ^2.0.0 | **MIT** | Retain copyright notice. |
| `postgres-bytea` | ^1.0.0 | **MIT** | Retain copyright notice. |
| `postgres-date` | ^1.0.7 | **MIT** | Retain copyright notice. |
| `postgres-interval` | ^1.2.0 | **MIT** | Retain copyright notice. |
| `split2` | ^4.2.0 | **ISC** | Retain ISC copyright notice. |
| `xtend` | ^4.0.2 | **MIT** | Retain copyright notice. |
| `typescript` | ^5.9.3 | **Apache-2.0** | Must include Apache 2.0 license text, state changes, and preserve NOTICE file. |
| `zod` | ^3.23.8 | **MIT** | Retain copyright notice. |
| `detect-libc` | ^2.0.3 | **Apache-2.0** | Retain Apache 2.0 license text. |
| `tunnel-agent` | ^0.6.0 | **Apache-2.0** | Retain Apache 2.0 license text. |
| `ieee754` | ^1.2.1 | **BSD-3-Clause** | Retain 3-clause BSD copyright, conditions, and disclaimer. |
| `expand-template` | ^2.0.3 | **(MIT OR WTFPL)** | Permissive; retain MIT notice. |
| `rc` | ^1.2.8 | **(BSD-2-Clause OR MIT OR Apache-2.0)** | Permissive; retain BSD/MIT notice. |
| *Transitive build helpers* (`base64-js`, `bl`, `buffer`, `decompress-response`, `mimic-response`, `deep-extend`, `end-of-stream`, `fs-constants`, `github-from-package`, `inherits`, `ini`, `minimist`, `mkdirp-classic`, `napi-build-utils`, `node-abi`, `semver`, `once`, `prebuild-install`, `pump`, `strip-json-comments`, `readable-stream`, `safe-buffer`, `simple-concat`, `simple-get`, `string_decoder`, `tar-fs`, `chownr`, `tar-stream`, `util-deprecate`, `wrappy`)* | Transitive | **MIT / ISC** | All permissive; retain standard short notices. |

---

## 3. Electron & Chromium Embedded Runtime Components

In addition to JavaScript modules bundled in `app.asar`, the packaged desktop distribution distributes the binary Electron runtime:
- **Location**: `apps/desktop/release/win-unpacked/`
- **Electron Version**: 33.4.11 (based on Chromium and Node.js v20/v22).
- **Provided License Files**:
  - `LICENSE.electron.txt` (MIT License covering Electron wrapper code).
  - `LICENSES.chromium.html` (9.17 MB detailed HTML notice document containing all third-party notices for Chromium, Blink, V8, WebRTC, FFmpeg, and codecs).
- **Compliance Status**: Fully compliant. Electron's automated build tooling correctly packages and redistributes Chromium's required attribution file.

---

## 4. Root License & Internal Metadata Defect Analysis

### A. Factual Findings:
1. **Repository Root `package.json`**: Line 18 declares `"license": "MIT"`.
2. **`README.md`**: Declares *"CodeForge is free open-source software under the MIT License."*
3. **Physical File Check**: Executing `open g:/CodeForge/LICENSE` returns `The system cannot find the file specified`. No root `LICENSE` file exists in `G:\CodeForge`.
4. **Internal Package Manifests**: All 20 internal packages in `packages/*` lack a `"license"` field in their `package.json`.

### B. Legal Analysis & Severity:
- **Do NOT conclude that a missing root LICENSE makes all CodeForge usage unlawful**: The presence of an explicit MIT declaration in `README.md` and root `package.json` establishes clear public licensing intent under contract law.
- **However, this is a Launch-Readiness Blocker for an official open-source release**: Standard open-source distribution conventions and corporate procurement policies require the canonical `LICENSE` text to be present in the repository root. Without it, automated enterprise license scanners (e.g., FOSSA, Snyk, Black Duck) classify the repository as "No License / Proprietary", blocking enterprise adoption.
- **Remediation Action Required**:
  1. Project leadership must formally authorize placing the standard MIT License text in `G:\CodeForge\LICENSE` (naming `Copyright (c) 2026 Forger Digital Solutions`).
  2. Add `"license": "MIT"` to each package manifest in `packages/*/package.json`.
