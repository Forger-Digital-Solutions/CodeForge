# CodeForge Desktop Software License & Distribution Analysis

**Status**: REVIEW DRAFT (PASS 1)
**Notice**: This document provides strategic legal analysis of desktop binary licensing options and a reviewable draft End User License Agreement (EULA) for the packaged Windows installer (`CodeForge-Setup-0.2.0.exe`). Project leadership must formally approve the licensing strategy before commercial distribution.

---

## 1. Strategic Licensing Analysis for Desktop Binaries

In modern software distribution, a distinct legal boundary often separates the **underlying source code monorepo** from the **compiled, packaged binary installer**:

```
┌──────────────────────────────────────────────┐
│  Source Code Monorepo (G:\CodeForge)         │
│  • Represented as MIT in package.json/README │
│  • Permissive open-source developer access   │
└──────────────────────┬───────────────────────┘
                       │ Build Pipeline (electron-builder)
                       ▼
┌──────────────────────────────────────────────┐
│  Packaged Desktop Binary (CodeForge.exe)     │
│  • Includes Electron 33.4.11 runtime         │
│  • Embedded Chromium, Node.js, native addons │
│  • Proprietary branding, mascot art, icons   │
│  • Packaged EULA / Terms of Distribution     │
└──────────────────────────────────────────────┘
```

### Strategic Options for Project Leadership:
- **Model 1: Pure Open Source (Pure MIT)**: The packaged binary is licensed under the same MIT License as the source code. Users may freely redistribute, fork, or resell the packaged binary, subject only to MIT attribution notices.
- **Model 2: Dual Licensing / Commercial Freeware (Recommended)**: The source code in `packages/*` remains MIT-licensed open source; however, the compiled binary installer, corporate trademarks ("CodeForge", "ForgeZero"), and mascot art (`8-Bit`) are distributed under a proprietary Desktop End User License Agreement (EULA) that permits free personal and commercial use but prohibits unauthorized binary repackaging, trademark misuse, or circumventing commercial cloud billing gates.

---

## 2. Draft Desktop End User License Agreement (EULA)

[BUSINESS DECISION REQUIRED: Model 1 (MIT) vs. Model 2 (Desktop EULA) Selection]

### CODEFORGE DESKTOP END USER LICENSE AGREEMENT

**Last Updated**: [BUSINESS DECISION REQUIRED: Effective Date]

IMPORTANT — READ CAREFULLY: This Desktop End User License Agreement ("EULA") is a legal agreement between you ("User" or "you") and [BUSINESS DECISION REQUIRED: Forger Digital Solutions Operating Entity Name] ("CodeForge," "we," "us," or "our") for the CodeForge desktop software application, executable files, installers, and accompanying digital documentation (the "Software").

### 1. Grant of License
Subject to your strict compliance with this EULA, CodeForge grants you a personal, non-exclusive, non-transferable, revocable license to download, install, and execute the compiled binary Software on computers running supported Windows operating systems for your personal or internal business software development purposes.

### 2. Relationship to Open-Source Core
The underlying source code of certain components of the Software is made available under the MIT License at `https://github.com/Forger-Digital-Solutions/CodeForge`. Nothing in this EULA limits, restricts, or supersedes your rights under the MIT License with respect to the unmodified source code obtained directly from the official repository. However, this EULA governs your use of the compiled binary distribution and proprietary brand assets.

### 3. Restrictions on Use
You agree that you will NOT:
1. Modify, obscure, or remove any copyright notices, trademarks, or proprietary markings embedded in the Software;
2. Redistribute, sell, lease, or commercially bundle the compiled binary installer under the "CodeForge" name without prior written consent from CodeForge;
3. Reverse engineer, decompile, or tamper with the Software to circumvent ForgeZero security controls, API allowances, or cloud subscription verifications;
4. Use the Software in violation of applicable export control laws or sanctions.

### 4. Third-Party Software & Open-Source Attributions
The Software bundles third-party software components, including Electron, Chromium, and npm dependencies. These components are licensed under their respective open-source licenses as set forth in the [Third-Party Notices](./third-party-notices.md) document bundled with the Software and available in the installation directory (`LICENSES.chromium.html` and `LICENSE.electron.txt`).

### 5. Disclaimer of Warranties & Limitation of Liability
THE SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. IN NO EVENT SHALL CODEFORGE OR FORGER DIGITAL SOLUTIONS BE LIABLE FOR ANY CONSEQUENTIAL, INDIRECT, SPECIAL, OR INCIDENTAL DAMAGES ARISING OUT OF THE USE OR INABILITY TO USE THE SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
