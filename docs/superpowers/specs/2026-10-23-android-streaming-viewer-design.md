# Android Streaming Viewer Design

- **Status:** Implementation, real-device/browser validation and cumulative audit complete — `ANDROID-STANDALONE-01` Done; no glass-to-glass latency or support claim
- **Date:** 2026-10-23
- **Authorized workflow:** `$requirements-to-design`
- **First platform combination:** macOS local host + USB Android + single device/single stream
- **Implementation authorization:** `$spec-driven docs/superpowers/specs/2026-10-23-android-streaming-viewer-design.md`

## 1. Background

FSQ_scrcpy provides real-time device video while a test or Coding Agent operates the device. It cooperates with `Appium_connect_agent`, but the projects retain separate ownership:

- FSQ_scrcpy owns video capture, stream lifecycle, local distribution and the read-only Viewer.
- Appium_connect_agent owns Appium Session, device actions, semantic observation and Coding Agent adapters.
- The two projects communicate only through a versioned public seam. Neither project may depend on the other's internal files, processes or third-party objects.

The long-term product direction includes Android, iOS and macOS capture. This design covers only the first Android batch.

## 2. Confirmed requirements

### 2.1 Goals

- Capture one USB Android device from a local macOS host.
- Define Android support by capabilities rather than an exact model allowlist. A first-batch acceptance device must be a physical Android handheld with exactly one built-in, non-foldable primary display; USB debugging enabled; a hardware H.264 encoder available; enough native pixels for the confirmed quality target; and no manufacturer-published security-support EOL reached on the validation date (record the official support/EOL source and query date). Emulators and Android TV, Auto, XR, foldable or multi-display devices are outside the first support claim. Record the exact model, OS build, security patch level and encoder in evidence for reproducibility, but do not make them public-contract allowlist entries.
- Use a version-pinned, metadata-preserving scrcpy-server host adapter for Android Capture. The approved exception self-development is limited to the version-specific ADB/socket/wire adapter hidden behind the Capture seam; `raw_stream`, full-client embedding and forking remain outside the first route. Obtain the exact server by verified official download/cache with an explicit offline file override; exact remaining dependencies still require their own selection gates.
- Use a user-installed ADB without an exact-version allowlist. FSQ_scrcpy does not download or redistribute Android Platform-Tools. Runtime records `adb version` and admits it only after bounded required-capability checks; an untested version may run only if those checks pass and its exact version is preserved in validation evidence.
- Present one read-only live stream in a standalone Web Viewer.
- Use standalone Chrome on macOS as the first real Viewer acceptance anchor. The public Viewer contract remains capability-based (WebCodecs H.264 Annex B, Web Worker, WebSocket and Canvas); record the exact Chrome/macOS versions in evidence rather than creating a version allowlist. MCP App host selection and embedded acceptance are deferred to `ANDROID-MCP-VIEWER-04`.
- Use H.264 Annex B as the first codec, a versioned binary WebSocket envelope as the loopback media/control transport, and Chrome WebCodecs in a Web Worker plus Canvas as the first decode/render path. FSQ_scrcpy does not implement or distribute an H.264 codec; commercial/legal use remains subject to separate legal review.
- Allow exactly one active Viewer for `ANDROID-STANDALONE-01`, `ANDROID-LIFECYCLE-02` and `ANDROID-ADAPTER-03`. A second Viewer request is rejected without a lease or queue. Reconsider standalone + MCP dual viewing only inside `ANDROID-MCP-VIEWER-04`; it is not pre-approved.
- Reuse that same Viewer/media pipeline inside hosts supporting MCP Apps.
- Return a Viewer URL when a host cannot safely embed the MCP App.
- Keep video frames out of model text and out of MCP tool-result frame transport.
- Start capture lazily when an authenticated visible Viewer creates demand.
- After Viewer authorization succeeds and the page begins an authenticated connection, paint the first fresh device frame and enter `Live` within 5 seconds on a representative acceptance device; user time spent approving the pairing code is not part of this startup interval.
- Require pairing and short-lived per-stream capability authentication even on loopback. The standalone URL is non-secret and cannot access frames until local owner-channel approval; reusable secrets never enter model-visible output, query strings or logs.
- Count only an authenticated Viewer reporting `document.visibilityState === "visible"` as active demand. Hidden/minimized/pagehide or connection loss stops renewal; preserve the current stream for a 5-second server-authoritative grace, then stop capture and release resources if no visible Viewer returns.
- While visible authenticated demand remains, automatically attempt one new CaptureSession for a recoverable video interruption and restore config/key/fresh-frame synchronization within 5 seconds; on expiry or repeated failure, enter a terminal state requiring explicit user retry. Proven device removal is terminal immediately.
- Allow the local Runtime to start independently or be launched/attached by an external adapter.
- Require at least 720 active decoded pixels on the short edge and target 30 displayed source frames per second under the confirmed bounded-jitter rule.
- The current feature makes no glass-to-glass latency bound or support claim; synchronized external measurement is later non-blocking performance research.

### 2.2 Non-goals

- Audio.
- Recording, frame archives, uploads, telemetry or persistent video files.
- Remote access, cloud relay, public network exposure or NAT traversal.
- Multiple devices or multiple simultaneous captured streams.
- iOS or macOS Capture implementation in the first batch.
- Device control from the Viewer.
- Appium Session, device action or semantic observation implementation.
- Sending frames through MCP or into model context.

## 3. Evidence baseline

### 3.1 scrcpy

The upstream baseline candidate is official Genymobile/scrcpy v5.0.1, released 2026-10-08:

- Tag commit: `a60891aea193d92e7e5c3942700eca63f9d19a5f`.
- Published `scrcpy-server-v5.0.1` size: 733,930 bytes.
- Published server SHA-256: `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`.
- License: Apache-2.0.
- The client/server protocol is explicitly internal and has no backward or forward compatibility guarantee.

Source evidence:

- [v5.0.1 release](https://api.github.com/repos/Genymobile/scrcpy/releases/tags/v5.0.1)
- [v5.0.1 developer/protocol document](https://raw.githubusercontent.com/Genymobile/scrcpy/a60891aea193d92e7e5c3942700eca63f9d19a5f/doc/develop.md)
- [v5.0.1 server options](https://raw.githubusercontent.com/Genymobile/scrcpy/a60891aea193d92e7e5c3942700eca63f9d19a5f/server/src/main/java/com/genymobile/scrcpy/Options.java)
- [v5.0.1 Streamer wire format](https://raw.githubusercontent.com/Genymobile/scrcpy/a60891aea193d92e7e5c3942700eca63f9d19a5f/server/src/main/java/com/genymobile/scrcpy/device/Streamer.java)
- [v5.0.1 host demuxer](https://raw.githubusercontent.com/Genymobile/scrcpy/a60891aea193d92e7e5c3942700eca63f9d19a5f/app/src/demuxer.c)
- [v5.0.1 SurfaceEncoder](https://raw.githubusercontent.com/Genymobile/scrcpy/a60891aea193d92e7e5c3942700eca63f9d19a5f/server/src/main/java/com/genymobile/scrcpy/video/SurfaceEncoder.java)
- [v5.0.1 Apache-2.0 license](https://raw.githubusercontent.com/Genymobile/scrcpy/a60891aea193d92e7e5c3942700eca63f9d19a5f/LICENSE)

### 3.2 Browser and MCP standards

- WebCodecs exposes low-level `EncodedVideoChunk → VideoFrame` decoding but no transport or demuxer. `VideoDecoder` is available only in secure contexts. H.264 support remains implementation-dependent.
- The WebCodecs AVC registration accepts Annex B access units when `VideoDecoderConfig.description` is absent; a key chunk must contain the IDR picture and required parameter sets.
- Classic browser WebSocket has no receive-side backpressure API. The application must bound queues and explicitly resynchronize.
- MSE consumes media segments, not the scrcpy elementary packet stream, so it needs a fragmented-container muxer.
- WebTransport requires HTTP/3 and TLS and adds a local certificate/server deployment problem.
- MCP Apps execute in a sandboxed iframe. Network use, including localhost WebSocket, must be declared in `connectDomains` and may require CORS/stable-origin handling.

Sources queried 2026-10-23:

- [WebCodecs WD 2026-10-19](https://www.w3.org/TR/2026/WD-webcodecs-20261019/)
- [AVC WebCodecs registration 2026-06-08](https://w3c.github.io/webcodecs/avc_codec_registration.html)
- [MDN VideoDecoder](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder)
- [Media Source Extensions WD 2026-08-07](https://www.w3.org/TR/2026/WD-media-source-2-20260807/)
- [MDN WebSocket backpressure warning](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [MDN WebTransport](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport)
- [MCP Apps CSP/CORS patterns](https://apps.extensions.modelcontextprotocol.io/api/documents/Patterns.html#configuring-csp-and-cors)

## 4. Capture alternatives

| Alternative | Decision | Benefits | Costs and risks |
| --- | --- | --- | --- |
| Pinned `scrcpy-server v5.0.1` plus metadata-preserving host adapter | **Confirmed first-batch Capture route** | Retains codec, dimensions, session epochs, PTS, config packets and keyframe flags; avoids SDL and the full FFmpeg client; creates a deep Capture seam | The protocol is internal and version-bound; the approved exception self-development is limited to `ScrcpyV501CaptureAdapter`; every upgrade needs a new adapter identity, source diff, fixtures and real-device validation |
| `raw_stream=true` | Reject as first-batch seam | Minimal framing | Removes codec, size, epoch, PTS, packet boundaries and key/config flags; pushes complexity into fragile NAL inference and fabricated timing |
| Full scrcpy CLI/client | Keep only as native comparison tool | Upstream owns ADB, protocol, native decoding, retry and cleanup | No supported encoded-frame output interface for a Web Viewer; native SDL window is not the product; embedding internal C has no ABI contract and brings SDL/FFmpeg packaging |
| Fork/embed server or host client | Reject unless the recommended route is proven infeasible | Maximum control | Highest maintenance burden across hidden Android APIs, vendor encoders, upstream workarounds, native dependencies and a permanently forked two-sided protocol |

The recommended adapter identity is atomic:

```text
scrcpy server semantic version
+ official server artifact digest
+ FSQ Capture adapter protocol version
```

Changing any member requires a new adapter compatibility gate. Unknown combinations fail closed.

The server asset acquisition policy is confirmed:

1. Fetch only the pinned `scrcpy-server-v5.0.1` asset and its official signed checksum material from the Genymobile/scrcpy v5.0.1 GitHub Release; never resolve `latest`, a package-manager server path or another installed scrcpy version.
2. Verify the upstream signature chain according to the official release-verification procedure, then require the pinned SHA-256 `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536` and expected asset identity before cache admission.
3. Download to a private temporary file, verify before use, then atomically rename into a private content-addressed local cache keyed by version + SHA. A cached file is rehashed before every device push; mismatch deletes/quarantines it and fails closed.
4. An explicit offline file path is allowed, but it must match the same version and SHA before use. It is copied into the verified cache; arbitrary local scrcpy installations are not trusted as fallback.
5. Network, signature-tooling or checksum failure returns a clear setup/dependency error and never pushes or executes the asset. Runtime viewing does not silently download on every start.
6. Keep the upstream Apache-2.0 license, attribution and verification evidence with the cached component and in product third-party notices. The binary is not committed to this repository or bundled in the ordinary package under this policy.

## 5. Recommended module architecture

```text
Appium_connect_agent Adapter
        │ versioned control seam; no media bytes
        ▼
Contracts ◄──── Runtime lifecycle authority ────► Viewer
                  │                                  │
                  │ bounded Capture events           ├─ standalone page
                  ▼                                  └─ MCP App presentation
               Capture
                  │ version-specific internal adapter
                  ▼
        pinned scrcpy-server v5.0.1
                  │ USB / ADB
                  ▼
               Android
```

### 5.1 Module depth and ownership

- **Contracts** owns stable identities, state/error semantics and serialized public descriptions. It performs no discovery, capture, network or rendering.
- **Capture** hides ADB, scrcpy artifact identity, device locator, sockets, internal packet headers, MediaCodec epochs and device-side cleanup behind one event-oriented interface.
- **Runtime** is the lifecycle authority. It owns single-stream admission, launch/attach handshake, authenticated Viewer demand, leases, fan-out, bounded queues, state revision and public control operations.
- **Viewer** owns one browser implementation shared by standalone and MCP App surfaces. It owns capability detection, decode/render, visibility/credit reporting and user-visible state. It never controls the device.

Runtime decides when capture is needed. A `CaptureSession` owns the concrete resources it created and releases them idempotently when Runtime stops it.

## 6. Confirmed logical interfaces

The following logical identities, operations, event ordering, lifecycle and error semantics are confirmed as design input to the later SPEC gate. Exact JSON field spelling, binary byte layout, bounded pairing/grant TTL numbers and language types remain to be frozen in the SPEC delta; they may not change these semantics without returning to design confirmation.

### 6.1 Contracts

```text
DeviceRef {
  contractVersion
  platform = ANDROID
  namespace
  opaqueId
}

StreamId { opaqueValue }

StreamSnapshot {
  streamId
  deviceRef
  revision
  phase
  reason?
  epoch?
  codedSize?
  displaySize?
  activeViewerCount
  updatedAt
}

ViewerDescriptor {
  contractVersion
  streamId
  standaloneUri
  embedResource?
  presentationModes
  expiresAt
}

ViewerAccess {
  descriptor
  secret ViewerGrant
}

StreamError {
  code
  scope
  disposition = RECOVERABLE | TERMINAL | STATE_UNKNOWN
  safeMessage
  retryAfter?
}
```

Invariants:

- `DeviceRef.opaqueId` is not an ADB serial, port, PID, path or third-party object. The first batch may resolve a configured alias to an internal Android locator.
- `StreamId` identifies one logical lifecycle. Rotation and bounded recovery keep the ID; a terminal stream never reuses it.
- State `revision` strictly increases for one StreamId. Old state cannot overwrite new state.
- `ViewerDescriptor` is safe to log. `ViewerGrant` is separate secret material and must not enter model text, regular tool output, logs or telemetry.
- Only a Viewer that has painted a fresh frame may display `Live`.

### 6.2 Capture seam

```text
CaptureSource.open(OpenCapture { deviceRef, videoConstraints }, cancellation)
  -> CaptureSession

CaptureSession.events()
  -> bounded async pull stream<CaptureEvent>

CaptureSession.stop(reason)
  -> idempotent completion

CaptureSession.closed()
  -> exactly one terminal result

EncodedVideoPacket =
  CodecConfig { epoch, bytes }
| Frame       { epoch, sequence, ptsUs, key, bytes }

CaptureEvent =
  SessionStarted { epoch, codec, codedSize, displaySize, timebase = 1_000_000 }
| EncodedVideoPacket
| SessionEnded  { epoch, cause }
| CaptureEnded  { cause }
| CaptureFailed { StreamError }
```

Invariants:

- A session starts before its frames. Codec config precedes any dependent frame.
- Rotation/reset ends the old epoch and starts a new monotonically increasing epoch; it is not a whole-stream EOF.
- Frame PTS is nondecreasing only within one epoch. Config has no media PTS.
- Zero length, partial header/payload, unsupported codec, illegal order and configured size limit violations are protocol errors, not normal EOF.
- Exactly one whole-stream terminal event is produced.
- Cancellation interrupts socket reads and child waits. `stop()` is safe to call repeatedly or concurrently.

### 6.3 Runtime public control seam

```text
handshake(ClientProtocolRange) -> ServiceDescriptor
ensureViewer(DeviceRef, PresentationCapabilities, IdempotencyKey)
  -> ViewerAccess + StreamSnapshot
inspect(StreamId, afterRevision?)
  -> StreamSnapshot | ordered state changes
stop(StreamId, ExpectedRevision?, reason)
  -> terminal StreamSnapshot
```

- `handshake` rejects incompatible major versions.
- `ensureViewer` is idempotent and never creates a second active capture for the same allowed device lifecycle.
- Creating a descriptor does not start capture. Authenticated active Viewer demand starts capture.
- Through `ANDROID-ADAPTER-03`, Runtime admits at most one active Viewer per StreamId. A second request returns `VIEWER_LIMIT_REACHED` before allocating a grant, lease, queue or decoder. The per-Viewer credit design remains the isolation seam required if `ANDROID-MCP-VIEWER-04` later approves two viewers.
- Launch and attach use the same handshake. An external adapter receives a supported rendezvous descriptor and never hardcodes port, PID or file layout.
- Public operations contain no media payloads and no scrcpy/ADB implementation types.

### 6.4 Viewer/media seam

The browser uses a small versioned control channel and a binary media channel over the same authenticated connection:

```text
HELLO
LEASE_RENEW { visible, creditFrames, creditBytes }
ACK { sequence }
LEAVE
```

Binary message kinds:

- `SESSION`: decoder epoch, codec, coded/display dimensions and timebase.
- `CONFIG`: codec initialization bytes, without PTS.
- `FRAME`: one complete encoded access unit with epoch, sequence, PTS and key flag.
- `GAP`: decode continuity was lost; reset and wait for config + keyframe.
- `END`: ordered stream termination; detailed reason remains on the control state seam.

The exact byte layout is deferred to the SPEC gate. It must have a wire magic/version, network byte order, bounded payload length, monotonically increasing connection sequence, epoch and signed microsecond PTS. Runtime translates scrcpy headers once; Viewer never sees them.

## 7. Browser pipeline recommendation

### 7.1 Confirmed first media path

```text
scrcpy H.264 config/key/access units
  → FSQ binary envelope
  → authenticated loopback WebSocket
  → Web Worker
  → WebCodecs VideoDecoder
  → at most one pending VideoFrame
  → Canvas
```

The confirmed first route uses Annex B H.264 with no `VideoDecoderConfig.description`. Runtime retains the latest `CONFIG` for each epoch. `CONFIG` remains a separate FSQ envelope for state transfer, but it is **not** submitted to WebCodecs as an independent `EncodedVideoChunk`.

For initial decode, rotation recovery or GAP recovery, Viewer must:

1. receive `SESSION(epoch)` and exactly one current same-epoch `CONFIG`;
2. parse the SPS NAL to derive the exact RFC 6381 codec string (`avc1.PPCCLL`) and call `VideoDecoder.isConfigSupported()`;
3. reject a frame before config, config from another epoch, malformed SPS/PPS or replacement config without a new epoch;
4. wait for a same-epoch key access unit;
5. concatenate the retained Annex B config bytes and key access-unit bytes into **one** `EncodedVideoChunk(type="key")`, so the chunk contains SPS/PPS plus the IDR picture as required by the AVC WebCodecs registration;
6. account the combined bytes against packet, queue and credit limits;
7. submit later complete access units as `key` or `delta` chunks using the original microsecond PTS.

On every new epoch, Viewer leaves `Live`, closes queued/displayed `VideoFrame` objects, resets the decoder, discards the old config and waits for the new config + key combination. Startup, rotation and GAP fixtures must prove the actual target encoder emits usable Annex B config and that the derived codec string is accepted. A future `VideoDecoderConfig.description`/AVC path is a separate candidate, not an implicit fallback.

### 7.2 Alternatives

- **MSE + fragmented MP4:** only if WebCodecs fails the confirmed browser matrix or HTMLVideoElement behavior becomes a requirement. It needs an approved muxer and must prove rotation, buffer eviction and a separately confirmed latency target.
- **WebTransport:** postpone. HTTP/3/TLS, local certificates, server selection, UDP restrictions and MCP host compatibility are unjustified for a single local Viewer.
- **FFmpeg:** do not select for the first WebCodecs route. Reconsider only for approved native remux/software-decode needs, with actual LGPL/GPL build configuration and source-distribution obligations.

## 8. Bounded backpressure

Classic WebSocket does not provide receive backpressure. Capture→Runtime and Runtime→Viewer therefore have distinct bounded policies.

Initial engineering values, pending real fixtures and user approval:

- Maximum captured packet: 8 MiB; reject before allocation when a declared length exceeds it.
- Capture→Runtime media queue: 16 packets or 16 MiB, whichever fills first.
- Runtime→Viewer outstanding media: 4 frames or 8 MiB.
- Viewer decoder queue: at most 4 decode requests.
- Viewer rendering: at most one pending `VideoFrame`; replaced/terminal frames close immediately.
- State/control lane: 64 messages or 256 KiB.

#### Capture→Runtime overflow

- Session, config, state and terminal events use a separate ordered control lane and are never dropped as media.
- Runtime retains one bounded latest `SESSION + CONFIG` snapshot for the current epoch.
- When the shared media queue overflows, Runtime atomically marks **all** current consumers discontinuous, releases every queued media reference and discards incoming delta frames until the next same-epoch keyframe.
- Runtime then emits `GAP`, replays the retained `SESSION + CONFIG`, and admits that keyframe. If the epoch changes first, the new epoch replaces the retained snapshot and recovery waits for its config + key.
- If the control lane itself overflows, no keyframe arrives before the confirmed resync deadline, or retained config is absent, the stream fails as `RUNTIME_OVERLOAD/BACKPRESSURE_TIMEOUT`; it must not remain falsely Live.

#### Runtime→Viewer overflow

- Each Viewer has independent frame/byte credit. Exhausting one Viewer does not block Capture or another Viewer.
- The affected Viewer releases its queued media, receives `GAP`, resets its decoder and resumes only from the current retained `SESSION + CONFIG + next keyframe` sequence.
- Failure to resynchronize before the confirmed deadline closes that Viewer as `SLOW_CONSUMER`; its lease then follows normal grace/expiry behavior.

Byte accounting includes Capture payload memory once in the shared queue, every per-Viewer queued reference, bytes accepted by the WebSocket implementation but not yet flushed, and config+key concatenation buffers. Reference sharing must not hide transport or concatenation memory. Terminal events cannot be coalesced or dropped; ordinary snapshots may coalesce by revision.

## 9. Lifecycle and visible states

### 9.1 Capture

```text
IDLE → STARTING → AWAIT_SESSION → STREAMING
                     ↑               │
                     └ RECONFIGURING ┘
nonterminal → STOPPING → ENDED
nonterminal → FAILING → FAILED
```

### 9.2 Runtime stream

```text
READY_IDLE
  → DEMAND_PENDING
  → STARTING_CAPTURE
  → SYNCING
  → STREAMING

STREAMING → SYNCING                  (new epoch)
STREAMING/SYNCING → INTERRUPTED      (recoverable media/encoder/socket interruption while device absence is unproven)
INTERRUPTED → STARTING_CAPTURE       (one new CaptureSession attempt, same StreamId, active visible demand, within 5s)
STARTING_CAPTURE → SYNCING → STREAMING (new epoch/config/key and fresh painted frame)
INTERRUPTED/STARTING_CAPTURE --5s expiry or repeated failure--> FAILED
STREAMING/SYNCING → GRACE            (last visible lease stops renewing)
GRACE → SYNCING                      (visible authenticated Viewer returns within 5s; STREAMING only after a fresh frame is painted)
GRACE --5s expiry--> STOPPING → STOPPED
active → DEVICE_DISCONNECTED         (device absence proven; no recovery window)
active → FAILED                      (other terminal failure)
```

### 9.3 Viewer

```text
BOOTSTRAP → CONNECTING → SYNCING → LIVE
LIVE → PAUSED/SYNCING
nonterminal → INTERRUPTED → CONNECTING   (only inside an approved recovery window)
nonterminal → DISCONNECTED | STOPPED | UNSUPPORTED | ERROR
```

A cached final frame may remain visible only under an explicit non-Live overlay. It is never evidence of current device state.

## 10. Security and privacy

- Bind explicitly to loopback; never wildcard-bind. Validate `Host` and browser `Origin` to resist DNS rebinding.
- Use independent capabilities for owner control, one-time Viewer bootstrap and short-lived media/lease access. Generate at least 128 bits of entropy, bind capabilities to instance/stream/audience/expiry, store only comparison material and revoke on stop or Runtime exit.
- Tokens never appear in query strings, regular tool/model output, logs, process arguments, error messages, telemetry or persisted history.

This loopback policy is confirmed: unauthenticated Viewer access and bearer URLs are not allowed. Exact bounded TTL values remain part of the versioned public interface/SPEC delta, but pairing codes are single-use and every capability is revoked on stream stop or Runtime exit.

### 10.1 Standalone fallback bootstrap

`ViewerDescriptor.standaloneUri` is a safe, non-secret URL for a pairing page and may be logged. Opening it does not grant video access.

1. The same-origin page creates an ephemeral browser session and displays a short human pairing code plus expiry.
2. The user approves that code through the local owner channel (`fsq-scrcpy viewer approve <code>`), or a trusted local Adapter calls the equivalent owner-only operation after explicit user intent. The code identifies a pending session but is not a reusable bearer.
3. The approved page redeems exactly once and receives a short-lived, HttpOnly, SameSite=Strict connection cookie from Runtime; the pending code is invalidated.
4. The WebSocket authenticates from that same origin. Failed, expired or replayed pairing allocates no CaptureSession or large queue.
5. Runtime stop or stream expiry revokes the cookie/session. A new logical stream requires new pairing.

A trusted host may instead use a protected open-link/metadata channel guaranteed not to enter model-visible text. If it lacks such a channel, it shows the non-secret pairing URL and requires local approval; it never prints a bearer URL. This is the concrete URL fallback, not an unauthenticated stream.

### 10.2 MCP App bootstrap

- The MCP Adapter obtains `ViewerGrant` over its owner seam and passes it only through host-protected app metadata (`_meta` or an equivalent channel proven not model-visible). The App immediately exchanges it for a short-lived media capability; it is never returned in ordinary tool content.
- The MCP resource declares the exact Runtime loopback origin in `connectDomains`; Runtime CORS/Origin policy allowlists the exact approved host origin. Host support must be verified with the named version.
- If protected metadata, exact local-connect CSP or a stable allowed origin is unavailable, embedded presentation becomes `EMBED_UNSUPPORTED` and transitions to the standalone pairing flow.

Standalone responses set `frame-ancestors 'none'`. MCP resources render only in exact approved host origins under the host sandbox and must not broaden framing policy. Baseline CSP denies everything, then permits self-hosted script/style/image/worker assets and the exact local connection origin; no wildcard, CDN, inline eval or broad scheme. Frames remain memory-only and never enter telemetry.

## 11. Failure and cleanup contract

| Trigger | Public state/error | Recovery | Required cleanup |
| --- | --- | --- | --- |
| `adb` missing, version output unparseable, or required push/shell/tunnel capability check fails | `DEPENDENCY_UNAVAILABLE` or `ADB_INCOMPATIBLE` | user installs/updates an official or trusted package and retries | no CaptureSession/server push beyond the bounded probe; remove any probe tunnel/temp path; never kill or replace the user's adb server globally |
| zero Android devices | `DEVICE_NOT_FOUND` | explicit retry | revoke request grant |
| multiple devices | `DEVICE_AMBIGUOUS` | user/adapter supplies confirmed alias | no server launch |
| unauthorized/offline USB device | `DEVICE_UNAVAILABLE` | user fixes device authorization, then new stream | stop adb process/tunnel and clear queues |
| official server download/network unavailable and no verified cache/offline override | `ARTIFACT_UNAVAILABLE` | explicit setup retry or approved offline path | remove partial temp file; do not push/execute or fall back to system scrcpy |
| signed checksum verification, pinned SHA/version check, or cached rehash fails | `ARTIFACT_MISMATCH` | fail closed; reacquire only from approved source | quarantine/delete invalid cache/temp; do not push/execute |
| server/adapter version mismatch after verified acquisition | `VERSION_MISMATCH` | atomic approved upgrade | close socket/tunnel/process; retain only independently verified cache entry |
| port conflict | `RUNTIME_BIND_FAILED` or retry an OS-assigned loopback port | attach existing compatible instance or explicit retry | release failed listener/rendezvous |
| push/tunnel/spawn/connect timeout | `CAPTURE_START_FAILED` | explicit retry in F1 | cancel/reap child, remove tunnel/artifact |
| codec id disabled/config/unknown | `CODEC_DISABLED`, `CODEC_CONFIG_ERROR`, `UNSUPPORTED_CODEC` | terminal for stream | unified stop path |
| malformed/partial/oversized packet | `MALFORMED_MEDIA` | no same-session retry | close process/socket/tunnel and free buffers |
| no first session/config/key/frame by deadline | `START_TIMEOUT` | policy-confirmed retry only | stop CaptureSession and Viewer queues |
| encoder failure after upstream retry exhaustion, device absence unproven | `STREAM_INTERRUPTED` | with active visible demand, create one new CaptureSession and reach fresh `Live` within 5 seconds | stop failed session and clear old decoder/config/frame state before restart |
| automatic downsize below confirmed target | `QUALITY_TARGET_UNMET` | change device/config; never upscale to claim pass | normal stream cleanup |
| rotation/new session | `SYNCING` | automatic epoch reset | discard old config/frames/decoder queue |
| rotation cannot resynchronize, device absence unproven | `STREAM_INTERRUPTED` | one new CaptureSession attempt within the same 5-second recovery window | reset decoder and stop failed session before restart |
| socket EOF, device state unknown | `STREAM_INTERRUPTED`/state unknown | one device-presence classification plus one new CaptureSession attempt within 5 seconds | clear old media/socket/session; do not claim disconnected until proven |
| proven USB removal | `DEVICE_DISCONNECTED`, terminal immediately | user action then a new StreamId | process/tunnel/socket/queues/grants/leases |
| Capture→Runtime media queue full | `BACKPRESSURE_GAP` for every affected Viewer, or `RUNTIME_OVERLOAD` | shared GAP→retained session/config→next key; timeout is terminal | atomically release shared queued payloads; preserve bounded current epoch snapshot |
| slow Viewer/decode queue full | `SLOW_CONSUMER`/`PAUSED` | GAP→keyframe within bound | clear that Viewer only |
| WebCodecs/H.264 unsupported | `VIEWER_UNSUPPORTED` | approved alternative or URL to a supported browser | never acquire/retain capture lease |
| WebSocket close | Viewer non-Live; Runtime enters `GRACE` when it was the last visible lease | reconnect within confirmed 5-second grace | clear Viewer queue/credit immediately; server lease deadline remains authoritative |
| invalid/expired/replayed grant | `UNAUTHORIZED` | obtain new one-time grant | allocate no capture/large queue |
| second Viewer request before MCP concurrency is approved | `VIEWER_LIMIT_REACHED` | user keeps the existing Viewer or closes it before retry | allocate no grant, lease, media queue or decoder; existing Viewer and Capture remain unchanged |
| CSP/Origin blocked | `PRESENTATION_BLOCKED` | safe standalone URL fallback | create no embed lease |
| hidden/minimized/pagehide Viewer | Viewer `PAUSED`; last visible lease moves Runtime to `GRACE` | visible authenticated renewal within 5 seconds reuses the current StreamId | stop renewal immediately; clear Viewer decode/render queue; retain Capture only through grace |
| final visible lease grace expires | `STOPPING → STOPPED` | later demand creates a new StreamId | admission→fan-out→Capture→grants/leases |
| duplicate launch/ensure race | reuse one stream or `INSTANCE_CONFLICT` | idempotency/instance lock | failed instance exits completely |
| explicit stop/SIGTERM | `STOPPING → STOPPED` | no automatic resurrection | close admission, serialize one terminal cause, quiesce producers, enqueue final END, stop Capture and revoke grants |
| SIGKILL/host crash | next attach reports unavailable | startup scavenger with instance/scid evidence | real-device verification required |
| measured FPS below target | `ACCEPTANCE_FAILED` | change candidate/config and revalidate | no support claim |

Unified terminalization is one serialized path guarded by an atomic terminal-cause winner and the same ordered send queue used for media:

1. atomically choose exactly one terminal cause; explicit stop, Capture EOF and Capture failure race through this gate, and later causes become diagnostics only;
2. stop admission and lease renewal, publish `STOPPING`, fence/cancel every media producer and wait for the media pump/send path to quiesce;
3. release queued fan-out references and prevent any new `SESSION`, `CONFIG`, `FRAME` or `GAP` enqueue;
4. enqueue exactly one `END` as the final item on that ordered connection queue, flush it best-effort, then close Viewer transports;
5. call idempotent `CaptureSession.stop()` and reconcile its exactly-one terminal event/`closed()` result with the already selected Runtime cause;
6. shutdown the capture socket, give the owned server a bounded exit window, terminate if still owned, remove the owned tunnel and reap the child;
7. revoke grants and leases, then publish exactly one matching terminal `StreamSnapshot`.

No media or second END may follow END. If transport failure prevents END delivery, the final snapshot/cause remains authoritative on the control seam. Cleanup continues after individual cleanup failures and records them without leaking secrets.

## 12. Performance acceptance proposal

### 12.1 Confirmed resolution definition

“720p” means at least 720 active decoded pixels on the short edge:

- Portrait active decoded image: at least 720×1280.
- Landscape active decoded image: at least 1280×720.
- Preserve aspect ratio; no crop, stretch or Viewer upscaling may satisfy the requirement.
- Capture constraints target a minimum 720-pixel short edge rather than blindly fixing `max_size=1280`; the adapter derives the upstream size from actual aspect ratio and reports the actual session size.
- A 20:9 portrait display may therefore require approximately 720×1600. A `max_size=1280` result near 576×1280 is below the confirmed target and must be reported as `QUALITY_TARGET_UNMET`, not accepted as 720p.

This definition is confirmed for the first standalone Chrome feature. Any later degraded mode must be explicitly non-passing and cannot enter the support matrix as 720p.

### 12.2 Confirmed frame-rate definition

- Use an authorized device workload that visibly changes at a stable 30 FPS.
- Measure Viewer-presented new source frames, not browser paint callbacks, repeated frames or interpolation.
- Measure 60 seconds as six non-overlapping 10-second windows.
- Across the full 60 seconds, present at least 1,740 new source frames (overall average ≥29 FPS).
- Every individual 10-second window must present at least 270 new source frames (window average ≥27 FPS).
- The 95th percentile interval between consecutive presented new source frames must be ≤67 ms.
- Hidden, paused, rotation-resync and explicitly non-Live intervals are excluded from the steady-state sample and must never remain labeled `Live`; the test must restart after a fresh stable Live interval rather than deleting slow samples.

This confirmed rule keeps 30 FPS as the target, detects sustained stutter and permits small scheduling jitter or isolated frame loss.

### 12.3 Deferred glass-to-glass research

- Glass-to-glass measurement is not an `ANDROID-STANDALONE-01` acceptance or release gate, and the current feature makes no end-to-end latency bound or support claim.
- Later research may define `t0` as a distinct visual change first visible on the physical Android screen and `t1` as the same change first visible on the real Viewer surface. Appium command-to-device response latency is outside that measurement.
- Any such research should use one synchronized high-speed recording showing device and Viewer at no less than 120 FPS, preserve every valid sample and clearly state the workload, orientation and measurement method.
- Research samples remain non-blocking and cannot create a product commitment. Adopting a numerical threshold or support claim requires a new SPEC delta and real evidence.
- Software timestamps may diagnose internal stages but do not constitute glass-to-glass evidence.

### 12.4 Confirmed startup, Viewer lease and interruption timing

Viewer-open-to-first-Live is confirmed at **5 seconds maximum** on a representative acceptance device meeting the capability class. Measurement starts when Viewer authorization/grant redemption has succeeded and the page begins the authenticated Runtime connection; it ends when the first fresh device frame is painted and the UI enters `Live`. Human pairing approval time is excluded. Missing the deadline produces `START_TIMEOUT`, leaves no stale `Live`, and runs unified cleanup.

Only an authenticated connection with `document.visibilityState === "visible"` renews active demand. Hidden/minimized/pagehide or connection loss immediately becomes non-Live and stops renewal. Runtime starts a **5-second visibility grace** from the last valid visible renewal. A visible Viewer returning before expiry reuses the same StreamId/CaptureSession and enters `Syncing` until a fresh frame is painted. Grace expiry stops the stream; later demand creates a new StreamId. Browser close events are advisory and the server lease deadline is authoritative.

For a recoverable video socket, encoder or reconfiguration interruption while device absence is unproven and visible demand remains, Runtime keeps the same StreamId, enters `Interrupted`, stops the failed CaptureSession and makes **one** new CaptureSession attempt. It must receive a new epoch/config/key and paint a fresh frame within **5 seconds from interruption classification**. Success returns through `Syncing`; expiry or repeated failure is terminal and requires explicit user retry/new StreamId. A proven device removal becomes `DEVICE_DISCONNECTED` immediately. Visibility grace and transport recovery are separate timers and never extend each other.

## 13. Reuse and dependency selection record

No candidate is approved by approving this design. Exact Runtime/build stack selection remains evidence-blocked.

| Candidate | Version/evidence | Purpose | Current disposition | Approval gap |
| --- | --- | --- | --- | --- |
| `scrcpy-server` | v5.0.1, commit `a60891a…`, SHA `764e…536`, Apache-2.0 | Android capture source | Metadata route, Adapter exception, and official signed-download/private verified-cache policy confirmed; implementation tooling not yet selected | Implement and independently verify signature chain, atomic private cache, per-push rehash, offline override and third-party notice; real packet/rotation/cleanup fixtures |
| User-installed Android Platform-Tools / `adb` | Official release notes queried 2026-10-23 list 37.0.1 and state recent Platform-Tools are intended to be backward compatible; use is subject to the Android SDK License | USB discovery, push, shell and tunnel | Confirmed capability-based policy with no exact allowlist; FSQ_scrcpy does not download/bundle/redistribute it | Resolve explicit configured path before PATH; parse/record version; bounded checks for server availability, exactly one authorized device, device state, shell, push and owned reverse/forward create/remove; exact version and results enter evidence |
| H.264 Annex B | scrcpy default; WebCodecs AVC registration 2026-06-08 | First encoded video format | Confirmed technical route; FSQ_scrcpy does not implement/distribute codec | Real CSD/NAL/profile/level/key interval; Chrome `isConfigSupported`; device/browser matrix; separate H.264 legal/product review before commercial release |
| WebCodecs + Web Worker + Canvas | W3C WD 2026-10-19; Chrome is the confirmed first Viewer anchor | Decode/render pipeline | Confirmed first Viewer route | Exact Chrome/macOS evidence, secure context, Annex B startup/rotation/GAP, frame release, memory/performance |
| Binary WebSocket envelope | RFC 6455/WHATWG browser API | Loopback media/control transport | Confirmed transport standard; server implementation still unselected | Select/version server library; auth/Origin/CSP, credit, send-buffer and slow-consumer tests |
| MSE + fMP4 muxer | MSE WD 2026-08-07; muxer unselected | WebCodecs fallback | Do not select initially | Version/license a muxer; prove fragments, rotation, eviction and latency |
| FFmpeg | 9.0.2; LGPL-2.1-or-later unless GPL parts enabled | Native remux/software-decode fallback | Do not select initially | Fixed configure, linking/source obligations, ABI/package and latency evidence |
| WebTransport | W3C CR 2026-07-30; HTTP/3 binding draft | Future transport | Defer | HTTP/3/TLS server, local certificates, browser/host/UDP constraints and fallback |


ADB policy evidence: [official Platform-Tools release notes](https://developer.android.com/tools/releases/platform-tools) and [Android SDK License Agreement](https://developer.android.com/studio/terms). “Recent” is not a public version label: acceptance is based on required behavior, with the exact observed version recorded. Passing the probe does not create a global support claim for every future ADB release; each release used in a support claim must appear in real validation evidence.

### 13.1 Runtime/build candidates requiring a dedicated selection gate

Current official facts queried 2026-10-23:

- Node.js 24 is LTS according to the [official Node release table](https://nodejs.org/en/about/previous-releases).
- `ws` 8.22.0 declares MIT and Node ≥10 in its [published package metadata](https://unpkg.com/ws@8.22.0/package.json); its upstream documents Autobahn testing and warns that per-message compression adds memory/performance cost.
- TypeScript 7.0.2 declares Apache-2.0 in its [published metadata](https://unpkg.com/typescript@7.0.2/package.json).
- esbuild 0.28.2 declares MIT, Node ≥18 and platform binaries in its [published metadata](https://unpkg.com/esbuild@0.28.2/package.json).
- `@modelcontextprotocol/ext-apps` 2.0.3 is an MIT release and requires Node ≥20 in its [published metadata](https://unpkg.com/@modelcontextprotocol/ext-apps@2.0.3/package.json) and [official release](https://github.com/modelcontextprotocol/ext-apps/releases/tag/v2.0.3).

These facts are insufficient to approve a stack. The required comparison remains:

| Runtime option | Potential fit | Evidence still missing |
| --- | --- | --- |
| Node.js + TypeScript | One language for binary Runtime and Viewer build; official MCP Apps SDK ecosystem; Node built-ins cover process/net/http/crypto; `ws` supplies tested server framing | macOS arm64 packaging, child/ADB cancellation, binary-copy profile, security/update policy, Node-vs-alternatives prototype and complete transitive lock audit |
| Python | Aligns with the sibling project's language and is familiar for process/control code | Approved WebSocket server, binary streaming/backpressure profile, packaging/runtime distribution and separate Viewer toolchain evidence |
| Rust | Strong ownership, bounded memory and single-binary packaging potential | Higher implementation cost, WebSocket/MCP/frontend split, target library versions/licenses and developer maintenance evidence |
| Go | Simple process/network runtime and single-binary packaging potential | Approved WebSocket dependency, binary/media memory profile, frontend split and target versions/licenses |

No Runtime language or concrete `ws`/TypeScript/esbuild/ext-apps version is presented for user approval in this design. A separate versioned selection record must compare the four options and approve each exact dependency/use before implementation Ready. `ext-apps` is relevant only to the later MCP App work package.

## 14. Feature plan

The confirmed first product feature is one behavior-first standalone live-view lease. It stays the only active feature while four strictly serial, single-owner module work packages are completed. No work package is independently declared a product feature or Done; the feature has one cumulative budget and is Done only after the real Viewer closure passes.

### ANDROID-STANDALONE-01 — Real standalone live-view lease

- **Observable behavior:** start local service → open protected standalone pairing URL → approve one Viewer → lazily capture one real USB Android → display read-only Live → close the final Viewer → stop capture and release all owned resources.
- **Non-goals:** MCP App, external launch/attach Adapter, multiple Viewers, automatic recovery beyond explicit retry, audio/control/future platforms.
- **Feature acceptance:** a representative real Android meeting the confirmed capability class + standalone Chrome on macOS meeting the Viewer capability contract; exact device/OS/encoder/Chrome/macOS versions recorded in evidence; confirmed resolution/FPS/startup policy; correct rotation and non-Live states; no frames in model/MCP/on disk; final lease expiry stops capture; complete failure/cleanup evidence. The feature makes no glass-to-glass latency bound or support claim.
- **Feature validation:** actual browser surface, Capture/Runtime conformance probes and independent full review of the cumulative feature diff. External glass-to-glass capture is deferred non-blocking research.
- **Cumulative budget:** product ≤2690 changed lines; tests ≤3170; docs ≤350. The user explicitly approved the exception to the approximate 1200-product-line target for this inseparable standalone lease. Budgets do not reset per work package or Capture/Runtime/Viewer subpackage.

Strict work-package sequence:

| Work package | Sole primary module | Behavior/seam gate | Product | Tests | Docs |
| --- | --- | --- | ---: | ---: | ---: |
| WP1 | Contracts | Freeze only F1 identities, states, errors and envelope semantics; contract fixtures/version rules accepted before Capture writes | ≤240 | ≤220 | ≤50 |
| WP2 | Capture | Strictly serial WP2a Artifact (≤220/260/40), WP2b ADB/transport (≤280/300/30), WP2c normalization/lifecycle/real smoke (≤250/340/30); total ≤750/900/100 | ≤750 | ≤900 | ≤100 |
| WP3 | Runtime | Strictly serial WP3a lifecycle/auth/HTTP (≤320/400/35), WP3b WS/media/backpressure (≤360/450/35), WP3c Capture integration/real smoke (≤220/250/30); total ≤900/1100/100; **no external launch/attach seam yet** | ≤900 | ≤1100 | ≤100 |
| WP4 | Viewer | Strictly serial WP4a protocol/build/Worker (≤320/400/30), WP4b app/render/state (≤300/350/35), WP4c integration/browser (≤180/200/35); total ≤800/950/100 | ≤800 | ≤950 | ≤100 |

Each work package receives unique ownership, validation and independent review before its next dependency. WP2, WP3 and WP4 each require internal a→b→c acceptance under one module owner. `ANDROID-STANDALONE-01` remains the single active inseparable feature; no subpackage is independently shippable.

### ANDROID-LIFECYCLE-02 — Truthful interruption and bounded recovery

- **Observable behavior:** media interruption, device disconnect, pause, explicit stop and the approved bounded recovery policy show truthful states and clean resources without stale Live.
- **Concurrency:** exactly one active Viewer; a second request is rejected as `VIEWER_LIMIT_REACHED` without disturbing recovery of the existing Viewer.
- **Serial packages:** Contracts → Capture → Runtime → Viewer.
- **Dependency:** ANDROID-STANDALONE-01 accepted.
- **Cumulative budget:** product ≤850; tests ≤1000; docs ≤300.

### ANDROID-ADAPTER-03 — External launch-or-attach

- **Observable behavior:** an external Adapter starts or attaches, negotiates version, idempotently receives the existing Stream/Viewer description and never creates duplicate capture; Viewer absence never stops Appium control.
- **Concurrency:** exactly one active Viewer remains the public limit; launch/attach must return the existing Viewer description rather than create a second Viewer or stream.
- **Ownership:** Contracts package then Runtime package. Appium_connect_agent work is a separately authorized cross-repository task.
- **Dependency:** ANDROID-LIFECYCLE-02 accepted.
- **Cumulative budget:** product ≤700 in this repository; tests ≤750; docs ≤350.

This feature exclusively owns external launch/attach. Earlier features own only direct standalone service startup.

### ANDROID-MCP-VIEWER-04 — MCP App and safe URL fallback

- **Observable behavior:** one later-confirmed MCP Apps host embeds the same Viewer/media pipeline; unsupported/unsafe hosts transition to the protected standalone pairing URL without a second media implementation. No MCP host is selected or claimed by the first standalone feature.
- **Concurrency gate:** this feature must explicitly decide whether standalone + MCP dual viewing is supported. Until separately approved and validated, Runtime continues rejecting a second active Viewer.
- **Serial packages:** Contracts → Runtime → Viewer.
- **Dependency:** ANDROID-ADAPTER-03 and confirmed host/security behavior.
- **Cumulative budget:** product ≤750; tests ≤900; docs ≤400.

The Android batch completes only after all authorized behavior features pass their own SPEC gates, real validation and independent review. iOS and macOS remain separate future batches.

## 15. Expected SPEC deltas

After user confirmation and before implementation:

- Root SPEC: approved support matrix, capture/decode/transport/stack decisions, performance definitions and loopback security principles.
- Contracts SPEC: identities, Viewer access separation, state/error/version semantics and serialized control/media envelopes.
- Capture SPEC: Capture interface, epochs/config/key/PTS ordering, pinned artifact identity, limits, cancellation and cleanup.
- Runtime SPEC: handshake/ensure/inspect/stop, launch/attach rendezvous, leases, concurrency, auth/origin, binary envelope, bounded queues and cleanup.
- Viewer SPEC: named browser/MCP host, selected decode/transport, state machine, visibility/credit, rotation, CSP, fallback and read-only boundary.

Candidate comparisons, experiments, feature status and budget remain in design/task materials rather than SPEC.

## 16. Cross-repository impact

A separately authorized Appium_connect_agent task must:

- consume the same versioned definitions for `DeviceRef`, `StreamId`, `ViewerDescriptor`, state/error and protocol versions;
- use handshake plus idempotent ensure/attach without hardcoding port/PID/path;
- select embed versus standalone from actual host capability while preserving one StreamId;
- keep `ViewerGrant` out of model-visible output, logs and telemetry;
- preserve Appium Session and control independently from Viewer lifecycle;
- avoid parsing scrcpy or media envelopes.

No change to the other repository is authorized by this design workflow.

## 17. Confirmed design and closure status

All product and architecture decisions in this document, including exact Contracts serialization and adjusted cumulative budgets, are user-confirmed. The active `$spec-driven` workflow closed Runtime/build selection, exact dependency/lock review, root/module SPEC gates, implementation, real-device/browser validation, physical unplug, legal dispositions and the cumulative independent audit.

Glass-to-glass capture is removed from `ANDROID-STANDALONE-01` acceptance and moved to non-blocking performance research. The feature has no remaining acceptance gate, makes no glass-to-glass latency bound or support claim, and is **Done**. The support matrix remains empty until a later SPEC delta names a supported combination.

This delta changes only a performance characteristic in the Viewer module's interface. It adds no interface method, seam or Adapter, changes no implementation and introduces no dependency. First Live, steady-state frame rate/p95, five-minute stability, rotation, cleanup and real device-disconnect evidence remain mandatory.

The later external `Appium_connect_agent` seam remains separately gated by synchronized cross-repository SPEC/task material.

## 18. Independent design review

The first independent full review covered all fixed evidence and the complete one-file design diff. It returned `status=findings` with six high-severity design findings:

- DR-01 feature/module ownership and duplicate launch/attach scope;
- DR-02 unsupported exact stack recommendation;
- DR-03 missing H.264 config-to-key WebCodecs mapping;
- DR-04 END/media terminal race;
- DR-05 undefined shared Capture→Runtime overflow behavior;
- DR-06 incomplete protected standalone/MCP bootstrap and framing policy.

This revision addressed DR-01 through DR-06, and the original independent quality context closed all six without direct regression. Subsequent confirmed scope, dependency, protocol and security increments were independently reviewed. The latest Contracts serialization clarification, implementation, real-device/browser closure and cumulative audit also passed their required reviews. The confirmed glass-to-glass delta removes the final acceptance blocker, so `ANDROID-STANDALONE-01` is Done without an end-to-end latency or support claim.
