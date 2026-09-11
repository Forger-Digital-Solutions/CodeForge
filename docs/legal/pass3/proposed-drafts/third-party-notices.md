# CodeForge Third-Party Open Source Notices

<!-- DRAFT — NOT YET EFFECTIVE — PENDING BUSINESS AND LEGAL REVIEW -->

**Notice**: This document provides attribution and licensing information for third-party open-source software libraries bundled into the CodeForge Desktop distribution.

---

## 1. Overview
The CodeForge Desktop Application bundles third-party software components licensed under permissive open-source licenses. An automated audit of the release artifacts confirmed that **zero copyleft (GPL, AGPL, LGPL) dependencies are bundled into the proprietary CodeForge runtime bundle**.

---

## 2. Chromium, V8, and Web Technologies
CodeForge is built on the Electron application framework and bundles Google Chromium and the V8 JavaScript engine.
- **Full Chromium Notices**: Complete copyright notices, source attributions, and licenses for the hundreds of open-source libraries included within Chromium (including ANGLE, SwiftShader, WebRTC, and libjpeg) are provided in the companion file:
  `LICENSES.chromium.html` (located in the application installation directory).

---

## 3. Electron Framework
- **Project**: Electron (`https://github.com/electron/electron`)
- **License**: MIT License

```text
Copyright (c) OpenJS Foundation and Electron contributors
Copyright (c) GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 4. Native Modules: better-sqlite3
- **Project**: `better-sqlite3` (`https://github.com/WiseLibs/better-sqlite3`)
- **License**: MIT License
- **Bundled Code**: Incorporates public-domain SQLite C source code (`sqlite3.c`).

```text
Copyright (c) 2017 Joshua Wise

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 5. Shipped Node.js Runtime Dependencies
All 47 external runtime npm packages packaged in `resources/app.asar` are licensed under permissive open-source terms (MIT, Apache 2.0, or BSD):
- `zod` — MIT License
- `ws` — MIT License
- `electron-updater` — MIT License
- `semver` — ISC License
- `node-fetch` / `undici` — MIT / Apache 2.0
