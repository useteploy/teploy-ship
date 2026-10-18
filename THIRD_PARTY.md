# Third-party notices

Ship is FSL-1.1-MIT (see `LICENSE`). This file records code ported from
other projects, as required by their licenses and as credit to the work that
taught us the shape.

## T3 Code

Portions of this repository are derived from
[T3 Code](https://github.com/t3-oss/t3-code), Copyright (c) 2026 T3 Tools
Inc., licensed under the MIT license below, at tag
`v0.1.1-nightly.20261016.3218`:

- `images/acp-driver/ship-acp.mjs` — the workspace-containment walk and
  fail-closed permission logic derive from
  `packages/provider-acp/src/server/clientPolicy.ts`; the session setup
  order, auth-required handling and cancel semantics derive from
  `packages/provider-acp/src/server/AcpSessionRuntime.ts`; the permission
  option selection (minus its allow-always arm, deliberately removed) derives
  from `packages/provider-acp/src/server/adapter.ts`.
- `src/fixtures/acp-mock-peer.mjs` — modelled on
  `packages/effect-acp/test/fixtures/acp-mock-peer.ts`.

No Effect runtime or generated schema code from T3 Code is included; the
ported logic is plain TypeScript/JavaScript.

```
MIT License

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
