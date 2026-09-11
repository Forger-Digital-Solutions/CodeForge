# CodeForge Third-Party Software Notices & Attributions

**Status**: REVIEW DRAFT (PASS 1)
**Distribution Target**: Packaged Windows Desktop Application (`CodeForge-Setup-0.2.0.exe` / `CodeForge-Portable.exe`).

---

This document contains open-source software license notices and attributions for third-party libraries, frameworks, and binary components bundled within or redistributed by the CodeForge Desktop software.

---

## 1. Primary Runtime & Embedded Frameworks

### A. Electron Framework
- **Copyright**: Copyright (c) OpenJS Foundation and Electron Contributors
- **License**: MIT License
- **Notice**: Included in the application directory at `LICENSE.electron.txt`.

### B. Chromium & Embedded Components
- **Copyright**: Copyright (c) The Chromium Authors
- **License**: BSD-3-Clause and various permissive licenses.
- **Notice**: Full attribution notices for Chromium, Blink, V8, WebRTC, and associated multimedia libraries are bundled in the application installation root at `LICENSES.chromium.html`.

### C. React & React DOM
- **Copyright**: Copyright (c) Meta Platforms, Inc. and affiliates.
- **License**: MIT License.

### D. SQLite Engine (via better-sqlite3)
- **Status**: Public Domain / SQLite Blessing
- **Notice**: The author of SQLite disclaims copyright to this source code in the public domain. Dedicated to the public domain worldwide.

---

## 2. Packaged Node.js Modules (`app.asar`)

### A. Apache License, Version 2.0 Components
The following bundled packages are licensed under the Apache License, Version 2.0:
- **`typescript`** — Copyright (c) Microsoft Corporation.
- **`detect-libc`** — Copyright (c) Lovell Fuller.
- **`tunnel-agent`** — Copyright (c) Mikeal Rogers.

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
[Full Apache 2.0 license text incorporated by reference]
```

### B. BSD 3-Clause Components
The following package is licensed under the BSD 3-Clause License:
- **`ieee754`** — Copyright (c) Feross Aboukhadijeh.

```
Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
```

### C. ISC License Components
The following packages are licensed under the ISC License:
- **`split2`** — Copyright (c) Matteo Collina.
- **`pg-int8`** — Copyright (c) Brian M. Carlson.
- **`inherits`** — Copyright (c) Isaac Z. Schlueter.
- **`ini`** — Copyright (c) Isaac Z. Schlueter.
- **`semver`** — Copyright (c) Isaac Z. Schlueter and Contributors.
- **`once`** — Copyright (c) Isaac Z. Schlueter.
- **`chownr`** — Copyright (c) Isaac Z. Schlueter.
- **`wrappy`** — Copyright (c) Isaac Z. Schlueter.

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS.
```

### D. MIT License Components
The following packages are licensed under the MIT License:
- **`better-sqlite3`** — Copyright (c) Joshua Wise.
- **`zod`** — Copyright (c) Colin McDonnell.
- **`pg`**, **`pg-pool`**, **`pg-protocol`**, **`pg-types`**, **`pgpass`**, **`pg-connection-string`** — Copyright (c) Brian M. Carlson.
- **`postgres-array`**, **`postgres-bytea`**, **`postgres-date`**, **`postgres-interval`** — Copyright (c) Brian M. Carlson.
- **`bindings`** — Copyright (c) Nathan Rajlich.
- **`file-uri-to-path`** — Copyright (c) Nathan Rajlich.
- **`xtend`** — Copyright (c) Raynos.
- **`base64-js`**, **`bl`**, **`buffer`**, **`decompress-response`**, **`mimic-response`**, **`deep-extend`**, **`end-of-stream`**, **`fs-constants`**, **`github-from-package`**, **`minimist`**, **`mkdirp-classic`**, **`napi-build-utils`**, **`node-abi`**, **`prebuild-install`**, **`pump`**, **`strip-json-comments`**, **`readable-stream`**, **`safe-buffer`**, **`simple-concat`**, **`simple-get`**, **`string_decoder`**, **`tar-fs`**, **`tar-stream`**, **`util-deprecate`**.

```
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
