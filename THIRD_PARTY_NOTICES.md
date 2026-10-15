# Third-Party Notices

This file attributes third-party software integrated into AREA as dependencies. AREA's own
code is original; the projects below are used as published npm packages under their own
licenses. Where a project's license requires the inclusion of its notice text, it is
reproduced below.

No third-party source code has been copied into this repository. AGPL/GPL-licensed projects
(firecrawl, semgrep) are **not** incorporated in any form; AGPL-protected hosted services may
be consumed at the user's option through the connector system with the user's own API key.

---

## cheerio

- Project: https://github.com/cheeriojs/cheerio
- npm: `cheerio` (used by the AREA Explorer crawler for HTML/DOM extraction)
- License: MIT
- Changes: none (used as published)

```
MIT License

Copyright (c) 2012 Matt Mueller

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

## web-tree-sitter

- Project: https://github.com/tree-sitter/tree-sitter (official WASM binding)
- npm: `web-tree-sitter` (used by the AREA Reverse Engineer parser for multi-language ASTs)
- License: MIT
- Changes: none (used as published)

```
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

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

## tree-sitter-wasms

- Project: https://github.com/Gregoor/tree-sitter-wasms
- npm: `tree-sitter-wasms` (prebuilt tree-sitter grammar WASM binaries)
- License: The Unlicense (public domain dedication)
- Changes: none (used as published)
- Note: individual grammar WASMs bundled by that package retain their own permissive
  licenses (MIT/Apache-2.0), which this notice covers by reference to each grammar's
  upstream repository.

## diff

- Project: https://github.com/kpdecker/jsdiff
- npm: `diff` (used by the AREA Verifier for reference-vs-reconstruction comparison)
- License: BSD-3-Clause
- Changes: none (used as published)

```
Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

 * Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
 * Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
 * Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## playwright-core (optional runtime)

- Project: https://github.com/microsoft/playwright
- npm: `playwright-core` (browser automation when a Chromium binary is installed;
  AREA never downloads browsers implicitly)
- License: Apache-2.0
- Changes: none (used as published)
- Apache-2.0 notice is available at
  https://www.apache.org/licenses/LICENSE-2.0.txt and applies to this dependency.

## @modelcontextprotocol/sdk

- Project: https://github.com/modelcontextprotocol/typescript-sdk
- npm: `@modelcontextprotocol/sdk` (MCP client transport for external connectors)
- License: MIT
- Changes: none (used as published)

```
MIT License

Copyright (c) 2024 Anthropic, PBC

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

## rea-agents (existing dependency, reaffirmed)

- Project: https://github.com/morluto/rea
- npm: `rea-agents` (the AREA analysis engine — 170-tool MCP server)
- License: MIT
- Changes: none (used as published via its MCP stdio interface)

---

## Ecosystem projects consulted but NOT incorporated (license-driven)

| Project | License | Reason for non-incorporation |
|---|---|---|
| firecrawl/firecrawl | AGPL-3.0 | Copyleft incompatible with source integration; hosted API available as an optional connector |
| semgrep/semgrep | LGPL-2.1 | OCaml/Python runtime not embeddable in AREA's Node runtime |
| OpenHands (All-Hands-AI) | MIT | Python runtime; architecture reference only |
| browser-use | MIT | Python runtime; AREA's agent loop covers the need |
| getzep/graphiti | Apache-2.0 | Python + external graph DB; AREA implements equivalent on SQLite |
| langchain-ai/langgraph, langchain | MIT | Python; concept reference for AREA's orchestration DAG |
| apify/crawlee | Apache-2.0 | Excellent but heavy; lean crawler sufficient (P2 revisit) |

These projects inspired AREA's implementations where noted in `docs/ecosystem-audit.md`;
nothing in AREA misrepresents their work as its own.
