# Runtime Dependency Selection

- **Status:** User-approved exact selection; lock/install closure verified; implementation-owned fixture, cleanup and compliance gates remain
- **Date:** 2026-10-23
- **Scope:** `ANDROID-STANDALONE-01` Runtime, standalone Viewer build, scrcpy artifact verification and tests
- **Authorization:** `$spec-driven docs/superpowers/specs/2026-10-23-android-streaming-viewer-design.md`
- **User approval:** User selected “批准 Node 精确依赖集” after the exact versions, purposes, omitted optionals and LGPL boundary were presented.

## Selected runtime and package policy

- Node.js `24.22.1` LTS on macOS arm64 is an external runtime prerequisite.
- Use the npm `11.19.1` bundled by official Node.js `24.22.1`.
- Generate and track `package-lock.json` with `lockfileVersion: 3`; use `npm ci`. Commit only with explicit user authorization.
- All direct dependencies use exact versions without ranges.
- First feature does not provide `.app`, `.pkg`, single-executable packaging, codesign or notarization.
- An actual clean macOS arm64 install must verify the lock closure, integrity, licenses and selected platform packages before implementation Ready. Any unexpected package returns to this selection gate.

Official sources:

- [Node.js release policy and LTS table](https://nodejs.org/en/about/previous-releases)
- [Node.js 24.22.1 bundled npm manifest](https://raw.githubusercontent.com/nodejs/node/v24.22.1/deps/npm/package.json)
- [npm lockfile v3 semantics](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json)

## Production direct dependencies

### `ws@8.22.0`

- **Purpose:** Runtime-internal RFC 6455 server framing only.
- **License:** MIT.
- **Engine:** Node >=10; project runtime remains Node 24.22.1.
- **Configuration:** `perMessageDeflate=false`.
- **Not installed:** optional peer addons `bufferutil`, `utf-8-validate`.
- **Interface boundary:** `ws` objects, types and errors never cross Contracts, Capture or Runtime public seams. Application credit, GAP, queue limits, pending-send accounting, Origin/auth and terminal ordering remain FSQ behavior.
- **Source:** [published package metadata](https://unpkg.com/ws@8.22.0/package.json), [upstream repository](https://github.com/websockets/ws).

### `openpgp@6.3.2`

- **Purpose:** setup/acquisition-only detached signature verification of scrcpy `SHA256SUMS.txt.asc` over exact `SHA256SUMS.txt` bytes.
- **License:** LGPL-3.0+.
- **Engine:** package metadata says Node >=18; upstream default Node bundle documents Node 22+; selected runtime is Node 24.22.1.
- **Not installed:** optional peer `@openpgp/web-stream-tools`; verification uses bounded in-memory `Uint8Array` inputs.
- **Interface boundary:** isolated `ArtifactVerifier` returns only a verified artifact identity or typed failure. OpenPGP keys/messages/signatures do not cross the seam or enter media/Viewer paths.
- **Compliance gate:** keep the module independently replaceable and ship applicable license/source/notice material. Final legal obligations require legal review; this record is not legal advice.
- **Source:** [published package metadata](https://unpkg.com/openpgp@6.3.2/package.json), [upstream repository](https://github.com/openpgpjs/openpgpjs).

Production dependencies are expected to have no mandatory transitive package dependencies according to their published manifests. This remains a claim to verify against the actual lock; it is not asserted as an installed-tree fact yet.

## Development dependencies

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| `typescript` | `7.0.2` | Apache-2.0 | Strict ESM compile/typecheck; no unstable exports |
| `@typescript/typescript-darwin-arm64` | `7.0.2` | Apache-2.0 | Actual TypeScript compiler platform package on target build host |
| `esbuild` | `0.28.2` | MIT | Build framework-free Viewer/Worker assets only |
| `@esbuild/darwin-arm64` | `0.28.2` | MIT | Target esbuild binary; published binary SHA-256 `10b6243df618d374bb2d5c9cfbe7052e1405f6aa4e53a6164f11a91b9f2e1384` |
| `@types/node` | `24.12.4` | MIT | Node 24 development declarations |
| `undici-types` | `7.16.0` | MIT | Exact required declaration dependency of `@types/node` |

Sources:

- [TypeScript metadata](https://unpkg.com/typescript@7.0.2/package.json)
- [TypeScript macOS arm64 package](https://unpkg.com/@typescript/typescript-darwin-arm64@7.0.2/package.json)
- [esbuild metadata](https://unpkg.com/esbuild@0.28.2/package.json)
- [esbuild macOS arm64 package](https://unpkg.com/@esbuild/darwin-arm64@0.28.2/package.json)
- [Node types metadata](https://unpkg.com/@types/node@24.12.4/package.json)
- [undici-types metadata](https://unpkg.com/undici-types@7.16.0/package.json)

## Built-in tooling

- `node:test` is the only test runner.
- `node:assert` is the assertion library.
- Tests are compiled by TypeScript or written as executable JavaScript.
- No `tsx`, `ts-node`, custom loader or third-party test framework.

## scrcpy release signature chain

Pinned release material:

- server asset: `scrcpy-server-v5.0.1`
- server URL: `https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1`
- server SHA-256: `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`
- checksum: `SHA256SUMS.txt`
- signature: `SHA256SUMS.txt.asc`
- public key: `https://blog.rom1v.com/keys/rom1v.asc`
- primary fingerprint: `456958E85A185DD5C2D1E4E80C822B298461FA03`
- signing subkey fingerprint: `E39E2DE6A55F5AA6D8EFB79ACA01F46F18683B3D`
- signing subkey expiry: `2030-05-14`

License and distribution boundary:

- `scrcpy-server v5.0.1` is Apache-2.0, copyright Genymobile and Romain Vimont; source identity is commit `a60891aea193d92e7e5c3942700eca63f9d19a5f`.
- The server binary is downloaded by setup into a private verified cache and is not committed to this repository or bundled in the ordinary FSQ_scrcpy package.
- Product third-party notices and the cache metadata must retain the Apache-2.0 license, applicable copyright/attribution, upstream source/version, asset URL, signature fingerprints and verified SHA. Any modified server would require prominent modification notices and a new selection/SPEC gate; current scope makes no server modification.
- npm lock/license audit does not cover this separately downloaded artifact. Its license/attribution/verification materials are a distinct implementation Ready gate.

Verification order:

1. enforce hard byte limits for key/checksum/signature inputs;
2. parse the pinned key and compare complete primary and accepted signing-subkey fingerprints;
3. verify the detached signature over the exact checksum bytes and require the actual successful signer fingerprint to equal the pinned signing subkey;
4. strictly parse the checksum text, requiring the target asset name exactly once and rejecting path/name variants or ambiguous lines;
5. require its digest to equal the pinned design digest;
6. stream-hash downloaded/offline server bytes and compare the same digest;
7. only then atomically admit the private content-addressed cache;
8. rehash before every device push.

Source: [scrcpy release verification instructions](https://raw.githubusercontent.com/Genymobile/scrcpy/a60891aea193d92e7e5c3942700eca63f9d19a5f/doc/verify-release.md).

After dependency installation is authorized, tests must cover valid release material plus wrong key/fingerprint, bad signature, changed checksum bytes/newlines, missing/duplicate/path-variant asset line, wrong digest, malformed/oversized OpenPGP packets, timeout and cache tamper.

## Alternatives not selected

- **Python 3.14 + websockets 17.3:** mature and BSD-3-Clause, but still requires a separate TypeScript Viewer toolchain and additional HTTP/packaging decisions. Shared language with the sibling repository adds no leverage across the process seam.
- **Rust 1.99.1 or Go 1.27.3:** stronger single-binary direction, but exact async/WebSocket/OpenPGP dependency evidence is incomplete and first-feature implementation weight is higher. Reopen if single-binary packaging becomes a hard requirement.
- **external gpgv/GnuPG:** not available by default on macOS and adds another user-installed executable/version/keyring/error surface. It is not a hidden fallback.
- **MCP Apps SDK, Viewer framework, FFmpeg, MSE muxer, WebTransport server:** outside `ANDROID-STANDALONE-01`.

## Completed selection and lock checks

1. The user approved dependency writes and the confirmed SPEC gate permits them.
2. macOS arm64 Homebrew `node@24` supplied exact Node.js `24.22.1`; its bundled npm reported `11.19.1` under the fixed PATH. A fresh-cache lock generation reproduced the same lock hash.
3. Per the user's company-network instruction, npm inherits `https://packagefeedproxy.microsoft.io/npm/` from the machine user config; the lock resolves to its `ms-feed-25.pkgs.visualstudio.com/1es-public` backing feed. The project does not override the company mirror or require the public registry.
4. `package-lock.json` is lockfile v3 with 53 entries: the root, eight approved non-optional packages and 44 non-target platform optionals. Every package entry has `resolved` and `integrity`; a clean `npm ci --ignore-scripts` installed exactly the eight approved packages.
5. The mirror emits SHA-1 lock SRI for 50 entries and SHA-512 for `ws`/`openpgp`. For all eight packages actually installed on macOS arm64, `npm pack` returned SHA-512 integrity and a separately fixed SHA-256 tarball digest. The raw evidence maps coordinate, filename, bytes, mirror integrity, mirror shasum and SHA-256. The selected esbuild binary independently matches `10b6243df618d374bb2d5c9cfbe7052e1405f6aa4e53a6164f11a91b9f2e1384`.
6. Installed licenses match the selection. `bufferutil`, `utf-8-validate` and `@openpgp/web-stream-tools` are absent. A clean `npm ci --omit=dev --ignore-scripts` installed only `ws` and `openpgp`.
7. The configured company-mirror `npm audit --omit=dev --json` exited 0 with zero vulnerabilities. The public-registry override remained unreachable (`ENOTCONN`) and is not required by the user decision. OSV `querybatch` independently returned HTTP 200 with no vulnerability record for each exact selected package/version on 2026-10-23.

The fixed raw command, environment, install-tree, license, checksum, npm-audit and OSV request/response evidence is identified by the feature task-package review manifest; summaries do not replace that evidence.

## Remaining implementation and compliance gates

1. Run OpenPGP positive/negative fixtures and scrcpy artifact-cache tamper tests.
2. Verify cached-server metadata and product third-party materials contain the required Apache-2.0 license, applicable attribution, upstream source/version, asset URL, signer fingerprints and SHA evidence.
3. Validate child-process cancellation/process-group cleanup and WebSocket pending-send bounds.
4. Preserve separate OpenPGP LGPL compliance review and H.264 commercial legal review.
