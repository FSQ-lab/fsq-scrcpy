# iOS WDA Video Observation Design

- **Status:** Final design confirmed by the user; independent design review passed; implementation not authorized
- **Date:** 2026-10-26
- **Authorized workflow:** `/requirements-to-design`
- **First platform combination:** macOS arm64 local host + one USB iPhone + one externally owned WebDriverAgent MJPEG source + one logical stream + one standalone Chrome Viewer
- **Implementation authorization:** none; a later explicit `/spec-driven docs/superpowers/specs/2026-10-26-ios-wda-observation-design.md` is required

## 1. Background

FSQ_scrcpy provides live video observation while a device is operated by a test or Coding Agent. It must also run as a standalone product and remain usable with future iOS automation stacks that do not use WebDriver.

The related `Appium_connect_agent` owns automation Sessions, device actions and semantic observation. For iOS it may later use Appium XCUITest and WebDriverAgent (WDA), but FSQ_scrcpy must not make WebDriver, an Appium Session or that repository part of its video interface.

The Android implementation already has a useful deep path:

```text
platform Capture Adapter
  → normalized bounded Capture events
  → Runtime lifecycle/auth/backpressure
  → protected local media transport
  → one standalone Viewer pipeline
```

The first iOS route reuses this architecture. It attaches to the MJPEG broadcaster of an already running and externally forwarded WDA Runner. It does not issue WebDriver commands and does not own WDA, Appium, XCUITest signing, installation, launch or USB forwarding.

The user confirmed a staged product direction:

1. deliver a WDA MJPEG Adapter first because it composes naturally with Appium and optimizes setup convenience;
2. retain a platform-neutral Capture seam so a later independently selected non-WDA iOS Adapter can replace the source without changing Agent, Runtime or Viewer control interfaces.

## 2. Confirmed requirements

### 2.1 Product behavior

- The first combination is a local macOS arm64 host, one USB-connected iPhone, one externally running WDA Runner, one host-loopback forwarding endpoint for the WDA MJPEG port, one logical FSQ stream and one active standalone Chrome Viewer.
- FSQ_scrcpy runs in its own process and can be started without `Appium_connect_agent`. Standalone operation still requires the WDA Runner and host port forward to have been prepared by the user or another external owner.
- `Appium_connect_agent` may later provide the same device identity and an owner-only local Capture binding, but FSQ does not depend on its process, Python types, WebDriver object, Session ID or internal layout.
- The public device identity remains stable when the Capture Adapter changes. WDA endpoint, iPhone UDID and provider-specific locator are private local configuration, never fields of `DeviceRef`.
- WDA MJPEG is consumed as a video source only. FSQ sends no WDA/WebDriver/Settings command and does not create, inspect, reuse, stop or delete an Appium Session.
- Visible authenticated Viewer demand lazily opens the MJPEG source. No visible Viewer means FSQ eventually closes its own source connection under the existing five-second Viewer grace.
- Closing FSQ or its Viewer closes only FSQ-owned sockets, queues, images, grants and leases. It does not stop WDA, Appium, XCUITest, the external USB forward or device automation.
- WDA or the external forward disappearing makes FSQ leave Live truthfully and end the current stream. The first feature performs no automatic same-StreamId source restart.
- A later non-WDA Adapter must satisfy the same Capture interface. No empty Adapter, fallback chain or generic plugin registry is implemented before that source is selected.

### 2.2 Convenience and quality

- The only numerical first-feature media target is **first valid authenticated visible demand to first freshly painted Live frame ≤5 seconds**, assuming the accepted WDA Runner and host-loopback forward are already healthy and available.
- Human signing, installation, trust, Developer Mode, WDA launch and USB-forward setup occur before that measurement and remain external prerequisites.
- There is no minimum decoded resolution, steady-state FPS, FPS percentile or glass-to-glass latency acceptance target for this WDA route.
- Actual JPEG dimensions, orientation, arrival rate, drops and startup stages are recorded as evidence, not converted into support promises.
- Only a complete JPEG received after FSQ opened this source, decoded with its actual orientation and successfully painted may enter Live. HTTP connection, multipart headers, a cached image or a partial JPEG are not Live.
- Aspect ratio and orientation must remain truthful. A low-quality frame may be displayed; a stretched, cropped, stale or wrongly oriented frame may not be labeled Live.

### 2.3 Privacy and safety

- Frames remain in memory and are not recorded, uploaded, persisted, placed in model text, returned through ordinary MCP results, logged or included in telemetry.
- The WDA endpoint, UDID, Appium Session ID, port-forward handle and provider errors are excluded from public values, ordinary logs, model output and Viewer URLs.
- The browser never receives the WDA endpoint. It connects only to the existing protected FSQ Runtime origin.
- Runtime and Viewer remain loopback-only and preserve the existing pairing, capability, CSP, Host and Origin protections.

## 3. Non-goals

- Starting, signing, provisioning, installing, updating, stopping or repairing WDA.
- Creating or controlling an Appium/XCUITest Session.
- Sending taps, gestures, keys, clipboard operations or any other device command through FSQ.
- Changing WDA MJPEG framerate, quality, scaling or orientation settings.
- Owning or creating usbmuxd forwarding, `iproxy`, `appium-ios-device` or an Appium port-forward lifecycle.
- Audio, recording, remote/cloud access, multiple devices, streams or Viewers.
- A support claim for a model family, iOS range, Xcode range, resolution, FPS or latency.
- Selecting or implementing the later non-WDA iOS source.
- Modifying `Appium_connect_agent`; that repository requires a separate authorized design and SPEC workflow.

## 4. Source alternatives and decision

| Candidate | Useful property | Reason not selected for the first Adapter |
| --- | --- | --- |
| WDA v16.15.3 MJPEG | Existing Appium ecosystem prerequisite; independent JPEG frames; Runner-level broadcaster survives individual WebDriver Session deletion | **Selected** as an externally owned, attach-only source |
| `pymobiledevice3` CoreDevice screen stream | Host-side source with no signed device helper and its own browser Viewer | GPL-3.0, reverse-engineered private protocol, HEVC and a second Viewer/control stack; retained only as later research |
| Meta idb AVFoundation/CoreMediaIO leaf | Public Apple framework leaf and H.264 output over USB | Requires a native macOS implementation/dependency path rejected for this batch |
| WDA direct browser `<img>` | Minimal display code | Leaks endpoint to the browser and bypasses FSQ auth, Live, state, limits and cleanup ownership |
| Server-side MJPEG→H.264 transcode | Preserves the existing H.264 Viewer | Adds decode/encode, copies, latency, native dependencies and fabricated media timing with no convenience benefit |
| AirPlay/UxPlay | Convenient user-selected mirroring | Network path, second Viewer and GPL/reverse-protocol boundary; not the confirmed USB first route |

Decision: strictly parse WDA MJPEG inside a Capture Adapter, preserve JPEG bytes, transport them through FSQ, and decode them in the existing Viewer Worker. No direct browser WDA access and no H.264 transcode.

## 5. Module architecture and seams

```text
Appium_connect_agent (later)             Standalone local configuration
  │ DeviceRef + owner-only binding         │ DeviceRef + owner-only binding
  └──────────────────────┬──────────────────┘
                         ▼
                 FSQ composition root
            selects exactly one Capture Adapter
                         │
              CaptureSource interface
                         │
          WdaMjpegCaptureAdapter (first)
                         │ exact loopback HTTP
                         ▼
        external USB forward → WDA MJPEG :9100
                         │ independent JPEGs
                         ▼
     normalized Capture events (provider-neutral)
                         │
                      Runtime
                         │ FSQV media v1.0/v1.1
                         ▼
             one protected Viewer Worker
                         │
               Canvas + truthful state
```

### 5.1 Module depth

- **Contracts** owns stable device identity, state/error semantics and serialized control/media values. It contains no WDA, WebDriver, endpoint or JPEG parser type.
- **Capture** hides WDA HTTP, multipart framing, JPEG metadata, host-arrival timing, source queueing and source cleanup behind one small interface.
- **Runtime** remains the lifecycle authority. It owns admission, pairing, visible demand, stream state, bounded transport, Viewer credit/ACK and terminalization; it does not learn WDA or Appium semantics.
- **Viewer** owns codec-specific browser decode/render inside one Worker/Main pipeline. It never connects to WDA and never controls the device.
- **Appium_connect_agent** later owns Appium, XCUITest, WDA and Session automation. Its only FSQ dependency is the stable public control seam; it must keep any local binding out of model-visible output.

The deletion test supports this seam: removing the WDA Adapter would force endpoint validation, multipart parsing, JPEG timing, errors and cleanup into Runtime. Keeping those details in Capture preserves Runtime and Viewer locality for later sources.

### 5.2 No generic source registry yet

The composition root receives one configured `CaptureSource` for the current process. It does not try WDA and then silently fall back to another source. A later second iOS Adapter will make an explicit local selection policy necessary; that policy is a later interface decision, not prebuilt infrastructure.

## 6. Contracts control cutover

Current Contracts v1 rejects every platform other than `android`. Adding `ios` while retaining `contractVersion:1` would make old v1 consumers reject a value advertised as the same version.

The recommended SPEC delta is a clean Contracts control v2 cutover:

```text
DeviceRef {
  contractVersion: 2
  platform: "android" | "ios"
  namespace: string
  opaqueId: canonical UUID
}
```

- `opaqueId` remains an application identity, never a UDID, WDA URL, port, Session ID, PID or filesystem path.
- `namespace` names the owning identity domain, not the Capture provider. Switching WDA to a later Adapter does not change the same logical `DeviceRef`.
- `StreamSnapshot`, `ViewerDescriptor`, validators, Runtime idempotency canonical bytes and all repository callers move to control v2 in one cutover.
- No v1 alias, dual validator, automatic upgrader or compatibility shim is retained. External cross-process launch/attach is not yet public and the support matrix is empty.
- Contracts control v2 is distinct from the FSQV media major/minor version.

Provider-specific local binding is not serialized:

```text
WdaMjpegBinding {
  deviceRef: exact {
    contractVersion: 2,
    platform: "ios",
    namespace,
    opaqueId
  }
  endpoint = exact http://127.0.0.1:<port>/
}
```

It exists only in the trusted composition root/Capture configuration and is never returned through Contracts.

Construction validates, privately copies and freezes the complete `DeviceRef`. `open()` requires equality of all four identity fields; matching only `opaqueId` is forbidden because separate identity domains may reuse the same UUID. The provider locator remains private even though the full stable identity is used as the binding key.

## 7. Deep Capture interface

The current exported `CaptureSource` and `CaptureSession` classes are Android concrete implementations. The clean cutover makes the public names platform-neutral interfaces and gives the Android implementation its confirmed Adapter name.

```text
CaptureSource.open(
  { deviceRef },
  cancellation?: AbortSignal
) -> Promise<CaptureSession>

CaptureSession.events() -> bounded AsyncIterable<CaptureEvent>
CaptureSession.stop("explicit-stop" | "cancelled") -> Promise<CaptureClosed>
CaptureSession.closed() -> Promise<CaptureClosed>
```

Concrete Adapters:

```text
ScrcpyV501CaptureAdapter       // existing Android implementation
WdaMjpegCaptureAdapter         // first iOS implementation
```

No base class, platform dispatcher or factory hierarchy is public. Runtime depends only on the two interfaces and normalized event values.

Capture policy is fixed when the concrete Adapter is constructed, not passed through Runtime. Runtime therefore has no platform or codec branch in its open request. `ScrcpyV501CaptureAdapter` retains the existing exact H.264/720/30/8-Mbps/no-crop/no-upscale policy internally; `WdaMjpegCaptureAdapter` accepts the externally configured WDA JPEG source and makes no quality request. Both reject a `DeviceRef` that does not exactly match their private configuration. The clean cutover removes `VideoConstraints` and migrates every current Runtime, test and composition-root caller rather than retaining a compatibility overload.

### 7.1 Codec-specific normalized events

```text
SessionStarted {
  epoch,
  codec: "h264-annexb" | "mjpeg",
  codedSize,
  displaySize,
  timebase: 1_000_000,
  timestampOrigin: "source" | "host-arrival"
}

CodecConfig { epoch, bytes }                  // H.264 only
Frame { epoch, sequence, ptsUs, key, bytes }
SessionEnded { epoch, cause }
Discontinuity { epoch, reason, discardThroughCaptureSequence }
CaptureEnded { cause }
CaptureFailed { error }
```

Rules common to both codecs:

- `SessionStarted` precedes dependent frames.
- `epoch` is positive and strictly increases on a display/codec configuration change.
- `sequence` is positive and strictly increases across the CaptureSession.
- `ptsUs` is nonnegative and nondecreasing inside one epoch.
- Exactly one whole-stream terminal event is emitted; no event follows it.
- `stop()` is concurrent-safe and idempotent; `closed()` returns one cached result only after FSQ-owned resources are released.

H.264 retains all existing config/key/epoch rules. MJPEG adds no fake H.264 config:

- `CodecConfig` is forbidden.
- Each Frame is one complete JPEG and is independently decodable; `key` is always true.
- `ptsUs` is elapsed host monotonic microseconds from source-session start, sampled immediately after the complete JPEG is received and validated. `timestampOrigin` is `host-arrival`; it is not represented as device capture PTS.
- A coded size or EXIF orientation change ends the old epoch as `reconfigured` and starts a new epoch before that JPEG is emitted.
- Capture keeps at most one parsed, not-yet-delivered JPEG. A newer JPEG replaces it. MJPEG needs no decoder GAP because the next image is independent; replacement is counted as adapter drop evidence.

## 8. WDA v16.15.3 source contract

Accepted source identity:

- repository/tag: `appium/WebDriverAgent` `v16.15.3`
- commit: `02cb92f0e93c8b021443bcbb8eeb80932c113220`
- release date: 2026-10-16
- device-side default MJPEG port: 9100
- WDA deployment target evidence: iOS 15.0; this is not a supported iOS matrix claim

Source facts fixed from WDA:

- `FBWebServer.startServing` starts the WDA HTTP server and then the Runner-level MJPEG broadcaster. Deleting one WebDriver Session does not stop the broadcaster; `stopServing` does.
- Default settings are 10 FPS, JPEG quality 25 and scale 100 percent. FSQ does not mutate them.
- Frames are XCTest screenshots of the current screen encoded as independent JPEGs.
- One failed screenshot does not close the connection; WDA backs off up to 10 seconds and tries again.
- WDA allows multiple MJPEG clients. It bounds each client to four pending frames and drops later frames for that client.
- The wire has no device capture PTS, DTS, duration, sequence, GOP, codec config or reliable platform-orientation event.

### 8.1 External ownership

The external owner is responsible for:

- Xcode/iOS compatibility, trust, Developer Mode, signing and provisioning;
- installing and starting the exact accepted WDA Runner;
- establishing and maintaining one host-loopback USB forward to the WDA device port;
- proving the binding belongs to the intended private `DeviceRef`;
- stopping or retaining WDA and the forward independently from FSQ.

For later Appium integration, XCUITest driver or `appium-ios-device` may own this setup. They are not FSQ runtime dependencies and their versions require a separate cross-repository selection gate.

### 8.2 Endpoint policy

The first Adapter accepts exactly:

```text
http://127.0.0.1:<decimal-port>/
```

- port is 1..65535 with no leading zero;
- scheme downgrade/upgrade, redirects, proxy environment, alternate hosts, IPv6, DNS names, userinfo, query, fragment and alternate paths are rejected;
- endpoint bytes remain private and are redacted from every error/log/result;
- HTTP connect, header and idle/deadline values are bounded in the later Capture SPEC; no automatic retry is added by design.

This narrow policy prevents SSRF and prevents an unauthenticated WDA listener from becoming a remote product interface.

### 8.3 Exact multipart parser

The Adapter implements a small bounded parser for the fixed WDA grammar:

```text
HTTP/1.0 200 OK\r\n
Server: WDA MJPEG Server\r\n
Connection: close\r\n
Max-Age: 0\r\n
Expires: 0\r\n
Cache-Control: no-cache, private\r\n
Pragma: no-cache\r\n
Content-Type: multipart/x-mixed-replace; boundary=--BoundaryString\r\n
\r\n
--BoundaryString\r\n
Content-type: image/jpeg\r\n
Content-Length: <canonical decimal>\r\n
\r\n
<JPEG bytes>\r\n
\r\n
```
- It parses across arbitrary TCP chunk boundaries.
- The response requires exactly one of each listed header, no unlisted header, no obsolete folding and no duplicate. Header names are compared case-insensitively as HTTP requires; values after bounded optional-whitespace normalization must equal the fixed v16.15.3 values above. The fixture is generated from commit `02cb92f0e93c8b021443bcbb8eeb80932c113220` source bytes, including header values and delimiters, rather than from a generic MIME example.
- Every part requires exactly the two listed headers and no other field. One canonical `Content-Length` is required; declared length is checked before allocation.
- Response headers are at most 8 KiB, one part header is at most 1 KiB, compressed JPEG bytes are at most 8,126,464, and no parser buffer may exceed the bytes still required by the current bounded state.
- The JPEG must have SOI/EOI and a valid bounded SOF dimension record. Encoded width and height are each `1..4096`; overflow-safe area validation requires `width <= floor(8_388_608 / height)`, so one decoded four-byte image is at most 32 MiB before browser-internal overhead.
- Missing/duplicate/invalid headers, length mismatch, partial EOF, bad boundary, malformed JPEG or any byte/dimension/pixel limit violation fails closed as `malformed-media` before browser decode.
- Parsing never searches an unbounded buffer for an EOI marker.

The user approved this limited self-development exception because the grammar is WDA-version-specific Adapter behavior and a general MIME stack would add more surface while not proving WDA's exact delimiter semantics.

### 8.4 JPEG metadata dependency

The user approved exact production dependency `exifr==7.1.3` for one purpose only:

- parse JPEG EXIF orientation from an in-memory `Uint8Array` without pixel decode.

Evidence and boundary:

- MIT license;
- no production dependencies;
- Node/browser support;
- exposes orientation/rotation-specific entry points;
- no URL/path input is used by FSQ;
- it does not parse multipart, perform networking, decode pixels or make product decisions.

A bounded Adapter-local SOF scan determines encoded width/height. EXIF orientation determines display width/height and epoch change. Viewer decode must honor the same orientation. Any disagreement between Adapter metadata and decoded image is terminal `malformed-media`, not silently stretched.

## 9. FSQV media v1.1 MJPEG increment

Android H.264 remains byte-for-byte media minor 0. MJPEG uses media major 1, minor 1; the 40-byte envelope layout and ordering fields are unchanged.

New minor-1 rules:

- Session codec FourCC is `mjpg` (`0x6d6a7067`).
- Session payload retains coded/display size and `timebase=1_000_000`.
- Config envelopes are forbidden.
- Frame payload is exactly one complete JPEG and uses key flag 1.
- Frame `ptsUs` carries Adapter-normalized host-arrival elapsed microseconds.
- Ordinary MJPEG replacement occurs only in an unsequenced Runtime staging slot before envelope encoding, sequence allocation or logical credit. Once `MediaChannel` assigns an envelope sequence, that frame is never replaced and retains its byte, callback and ACK ownership until the existing release path completes.
- End reasons and terminal ordering remain unchanged.

The new Viewer accepts H.264 minor 0 and MJPEG minor 1. An existing minor-0-only Viewer rejects minor 1, which is the current fail-closed behavior. Minor 1 does not reinterpret any H.264 field or config rule.

Runtime codec rules:

- retains current session plus H.264 config only when codec requires one;
- stages at most one unsequenced MJPEG source frame per Viewer. Staging payload bytes count in the same existing 8 MiB Runtime total-ownership cap as media/control application queues, assigned logical Frame references, pending-send bytes and WebSocket transport pressure; the 64 KiB control reserve remains unavailable to staging. A new source frame may replace an existing staging frame only after atomically releasing/counting out the old bytes. If `owned bytes - old staging bytes + candidate bytes` would exceed the media admission ceiling, Runtime releases the candidate immediately and records a source drop; it never retains both beyond the cap. Admission atomically removes the slot and calls `sendFrame` once; only then are envelope sequence and logical credit assigned while the same payload bytes remain continuously counted under their new ownership category;
- permits at most one assigned outstanding MJPEG frame. A delayed send callback or ACK blocks further assignment but not a cap-valid replacement inside the unsequenced slot. A maximum assigned frame may therefore leave no capacity for staging, in which case incoming frames are dropped until ownership falls. Sequence remains contiguous, and an assigned frame is never released before callback/ACK/GAP/terminal ownership completes;
- uses existing cumulative ACK ownership with the minor-1 painted-ACK extension below. It does not manufacture a GAP for ordinary independent-image replacement;
- treats config for MJPEG, non-key MJPEG, wrong codec/order/epoch or invalid size as `malformed-media`;
- preserves one serialized terminal path and sends no media after END.

MJPEG reconfiguration uses the existing transport-resync GAP reason 3 with codec-specific recovery grammar. Runtime first discards any unsequenced old-epoch staging frame, emits reason 3 with a watermark covering the highest assigned old-epoch Frame whose ownership is invalidated, and releases ownership through that watermark. The next accepted media is one strictly higher-epoch MJPEG Session followed directly by one key JPEG Frame; config is forbidden. Viewer resets and releases through the watermark before accepting that pair. The H.264 reason-3 rule remains exactly higher-epoch Session → one Config → key Frame. Reasons 1 and 2 remain H.264 same-epoch replay paths and are never emitted for ordinary MJPEG replacement.

## 10. Viewer MJPEG path

The standalone page, pairing, cookie, visibility, credit, state overlay, Canvas and Main/Worker ownership model remain one shared Viewer implementation.

Worker codec branch:

```text
FSQV MJPEG Frame
  → strict envelope/JPEG size check
  → Blob(type="image/jpeg")
  → createImageBitmap(..., { imageOrientation: "from-image" })
  → transfer one ImageBitmap to Main
  → draw to Canvas
  → close ImageBitmap
  → frame-complete / cumulative ACK
```

Rules:

- capability probing includes Worker `createImageBitmap`, transferable `ImageBitmap` and Canvas draw; unsupported surfaces become `viewer-unsupported` without starting/renewing demand.
- Worker has at most one decode and one transferred-not-completed image. Main has at most one render image. The accepted SOF side/area limits are rechecked before decode and against the decoded orientation-correct `ImageBitmap`; any disagreement closes the bitmap and fails as `malformed-media`.
- Every `ImageBitmap` is closed on draw, replacement, reset, hide, terminal and error paths. Resource evidence accounts for the possible Worker-decoding image plus Main-owned image, each bounded to 32 MiB of logical four-byte pixels.
- Canvas backing size equals the orientation-correct decoded image. CSS preserves aspect ratio; convenience scope does not permit crop, stretch or stale Live.
- A new epoch synchronously removes Live. For MJPEG reason 3, Viewer releases old ownership through the watermark, requires one higher-epoch Session and then a key JPEG without Config, and restores Live only after that image is painted. H.264 keeps its existing Session/Config/key grammar.
- Hidden/pagehide stops visible demand and clears queued/decode/render ownership under the existing lease behavior.
- No `<img src=WDA>` path, browser-visible source endpoint, object URL retention, storage or frame persistence is allowed.

### 10.1 Painted-frame proof and cumulative ACK

Media minor 1 extends the authenticated Viewer ACK shape to exactly:

```text
{ v:1, type:"ack", sequence:<decimal-u64>, paintedSequence:<decimal-u64> }
```

`sequence` keeps its existing cumulative ownership-release meaning. `paintedSequence` is the greatest MJPEG Frame envelope sequence that Main successfully drew and closed; it is `0` before the first paint, monotonic, never above `sequence`, and must identify a Frame sent for the current stream. Worker sends an immediate ACK after every newly painted sequence rather than waiting for ACK coalescing. Released-but-not-painted images advance `sequence` but not `paintedSequence`.

Runtime accepts this exact ACK only while the current stream uses MJPEG minor 1. It records the Frame sequence→epoch mapping, rejects future/unknown/regressing painted values, treats an identical repeat as idempotent, and regards a paint as current only when that sequence belongs to the current epoch. H.264 minor 0 retains its original exact ACK shape and behavior.

The authoritative First Live timer begins when the first valid authenticated `lease-renew visible:true` linearizes after hello and starts source demand. A valid current-epoch `paintedSequence` advancement is the only success signal. If none arrives within exactly five seconds, Runtime wins terminalization with `start-timeout`, fences Capture, sends END failed and publishes the matching final snapshot; a late ACK cannot revive it. This makes the confirmed painted-frame target reachable without trusting browser-local UI state.

## 11. Lifecycle

### 11.1 Source and stream

```text
configured WDA binding
  → demand-pending
  → authenticated visible Viewer
  → connecting-source
  → parsing-multipart
  → syncing
  → first fresh JPEG painted
  → live

live → interrupted               (no new current-epoch paintedSequence for 2s)
interrupted → syncing → live     (fresh same-epoch MJPEG paints before terminal deadline)
live → syncing                    (size/orientation epoch change)
live/syncing/interrupted → grace  (last visible Viewer stops renewing)
grace → syncing                   (visible Viewer returns before 5s)
grace --5s→ stopping → stopped    (close FSQ MJPEG socket only)
source EOF/reset → interrupted → failed
explicit stop → stopping → stopped
first fresh paint >5s → failed(start-timeout)
visible MJPEG without a fresh paint for 12s → failed(stream-interrupted)
```

MJPEG freshness uses Runtime monotonic time and the authenticated cumulative `paintedSequence`, not HTTP activity or source arrival alone. Exactly two seconds after the latest current-epoch paint, Runtime synchronously removes Live and publishes `interrupted/stream-interrupted` while retaining the same CaptureSession and connection. A new valid paint before twelve seconds moves through `syncing` back to Live; this is same-session independent-image recovery, not an automatic source restart. At twelve seconds the first-cause gate terminalizes as `stream-interrupted`, closes the FSQ source and requires a new StreamId for retry.

The source HTTP read-idle deadline is the same twelve seconds and may not fire earlier. This permits one WDA maximum ten-second retry backoff plus its one-second screenshot timeout while ensuring a stale frame is never labeled Live indefinitely. Freshness timers are suspended in grace because the Viewer is already non-Live; visible return starts `syncing` and a twelve-second fresh-paint deadline. First startup remains governed by the stricter five-second first-paint deadline.

### 11.2 Ownership invariants

- The WDA Runner and USB forward are external and survive FSQ normal close.
- FSQ owns one HTTP request/socket, parser buffers, at most one pending JPEG, Runtime transport references, Viewer decoded images, pairing/grants/cookies and stream state.
- Source cancellation aborts the in-flight connect/read, closes the local socket, empties buffers and waits for the producer to exit.
- Runtime terminalization fences the producer before END and final snapshot, as in the existing contract.
- A WDA/Appium Session transition has no direct FSQ effect unless it changes the MJPEG source connection.
- An Appium Session can end while WDA MJPEG continues; the FSQ stream continues while visible demand and fresh source frames remain.
- A Viewer can end while Appium automation continues; no automation resource is cleaned by FSQ.

## 12. Error mapping

No WDA-specific public error names are introduced unless implementation evidence proves the generic table insufficient.

| Condition | Public mapping | Cleanup/retry |
| --- | --- | --- |
| missing/refused/unreachable endpoint before source opens | `dependency-unavailable` or `capture-start-failed` as frozen by Capture SPEC | close local attempt; external owner repairs WDA/forward; explicit new stream |
| valid source but no current-epoch painted ACK within 5s of first visible demand | `start-timeout` | Runtime-authoritative terminalization closes FSQ source and Viewer resources; do not stop WDA |
| no current-epoch paint for 2s after Live | `stream-interrupted` / interrupted, nonterminal | retain the same MJPEG CaptureSession until a fresh paint or the 12s terminal deadline |
| no current-epoch paint for 12s while visible | `stream-interrupted` then terminal `failed` | close FSQ source; explicit retry/new StreamId |
| non-2xx, redirect, wrong/extra response or part header, wrong boundary, malformed JPEG, length/byte/dimension/pixel limit violation | `malformed-media` | close source; no fallback |
| EOF/reset/forward loss after start, device state not independently known | `stream-interrupted` then terminal `failed` | close source; do not claim device-disconnected; explicit retry/new StreamId |
| visible Viewer leaves and grace expires | `lease-expired` / stopped | close FSQ source only |
| explicit FSQ stop/cancel | explicit-stop / stopped | idempotent local cleanup only |
| decoded metadata disagrees with declared session/EXIF or pixel limits | `malformed-media` | close ImageBitmap, release ownership and terminate |
| browser cannot decode JPEG path | `viewer-unsupported` | no Live/support claim |

`device-disconnected` is never inferred from WDA EOF because WDA or its port forward may have stopped while the iPhone remains connected.

## 13. Security and privacy

- Reuse the existing protected FSQ pairing, cookie, exact Origin/Host and CSP path.
- Treat WDA as an unauthenticated local source. Its endpoint is accepted only through the trusted local binding and never proxied as a generic URL fetcher.
- Ignore HTTP proxy environment and reject redirects.
- Bound every response/header/part/frame/parser queue before allocation.
- Public safe errors contain fixed source-stage codes only, not raw Objective-C, Appium, Node HTTP or endpoint details.
- Do not retain or persist JPEGs for diagnostics. Protocol fixtures use synthetic minimal images without user content.
- No WDA device-control or clipboard endpoint is reachable through FSQ.
- The later Agent Adapter receives only `ViewerDescriptor` and state. Any owner-only Capture binding travels through a protected local control channel not visible to the model.

## 14. Acceptance and validation

### 14.1 No-device verification

- Contracts v2 strict values reject v1, unknown platform, provider fields and UDID/endpoint additions.
- Android Adapter regression remains complete after the Capture interface cutover.
- WDA HTTP fixture exactly reproduces v16.15.3 response and part grammar.
- Parser fixtures split every delimiter/header/length/JPEG boundary across chunks and cover duplicate/missing headers, noncanonical length, oversize, partial EOF, bad JPEG, orientation and dimensions.
- Queue fixtures prove latest-frame-wins, one pending source JPEG, one Viewer decode/render image, bounded bytes and no unclosed image ownership.
- Runtime fixtures prove H.264 minor 0 remains unchanged and MJPEG minor 1 forbids config/non-key/GAP replay misuse.
- Runtime pre-envelope staging replacement preserves contiguous sequence and exact callback/byte/credit ownership under delayed sends and ACKs.
- Runtime cap fixtures place a maximum assigned MJPEG payload beside maximum/new staging candidates and prove `assigned + staging + application + pending + transport + control reserve` never exceeds 8 MiB; rejected/replaced candidates release input exactly once without sequence or credit allocation.
- MJPEG reason-3 fixtures release the old watermark and accept only higher-epoch Session→key JPEG without Config; H.264 reason-3 Session→Config→key stays unchanged.
- Minor-1 ACK fixtures cover zero/advance/duplicate/regression/future/wrong-epoch `paintedSequence`, first-paint timeout races and late ACK after terminal.
- Monotonic freshness fixtures prove 2s interrupted, recovery before 12s, 12s terminal failure, grace timer suspension and HTTP idle deadline equality.
- JPEG fixtures reject side >4096, area >8,388,608, multiplication overflow and decoded-bitmap metadata disagreement before retaining browser resources.
- Cancellation/terminal races prove exactly one END/final snapshot and no later media.
- Secret-safety fixtures prove endpoint/UDID never enter serialized values, errors, logs or inspect output.

### 14.2 Real-device/browser acceptance

With separately authorized resources, the external owner prepares exact WDA v16.15.3 and one USB forward. FSQ then verifies:

1. standalone start without `Appium_connect_agent`;
2. protected pairing and visible demand;
3. source connection and first authenticated current-epoch painted ACK within 5 seconds after the first valid visible demand;
4. observed JPEG dimensions, orientation and arrival statistics, without quality/FPS pass thresholds;
5. portrait/landscape transition emits reason 3, releases old ownership, leaves Live and accepts higher-epoch Session→key JPEG without Config before an orientation-correct fresh paint;
6. an externally induced 2–11 second WDA no-frame interval becomes interrupted/non-Live and recovers on a fresh paint; 12 seconds becomes terminal failed;
7. Viewer hide/close suspends freshness timing and releases FSQ source after existing grace while WDA and automation remain alive;
8. ending an Appium Session does not end video when WDA remains alive;
9. killing WDA or removing only its forward makes FSQ non-Live/terminal without claiming physical device disconnect;
10. FSQ stop leaves no socket, parser buffer, staging frame, assigned frame, ImageBitmap, callback/ACK ownership, grant, lease or queue residue;
11. no pixels, endpoint or device locator appear in files, logs, model-visible output or telemetry.

No support-matrix entry is created from fixture-only evidence. Exact iPhone, iOS, macOS, Xcode, WDA artifact identity, forward owner and Chrome versions are preserved in real acceptance evidence.

## 15. Dependency and license record

### 15.1 WDA

- External prerequisite only; not downloaded, bundled, linked, imported or redistributed by FSQ.
- Source tag v16.15.3 root license is BSD-style. Its npm package metadata says Apache-2.0; this inconsistency must be resolved before any later redistribution decision.
- WDA uses XCTest/private headers and requires an externally signed Runner. FSQ makes no App Store, signing or WDA compatibility claim.

### 15.2 `exifr`

- exact version: 7.1.3
- license: MIT
- production dependencies: none
- purpose: in-memory JPEG EXIF orientation only
- excluded purposes: network/path loading, general metadata, GPS, thumbnail extraction, persistence or browser delivery
- implementation gate: actual package bytes, lock closure, integrity, exported API/types, license file and focused malformed-input behavior must be verified before implementation Ready

### 15.3 Standard library and self-development

Node 24 HTTP, URL, stream, AbortSignal and monotonic clock APIs remain the implementation baseline. The user approved bounded WDA multipart and JPEG SOF parsing as a narrow Adapter-specific exception. It must not grow into a general MIME/JPEG decoder and is verified against exact source fixtures plus hostile fragmentation/limit cases.

No dependency is installed by this design workflow.

## 16. Feature plan

Only one feature may be in implementation at a time. Changed-line budgets are cumulative additions plus deletions from each feature baseline; tests and docs are counted separately.

### IOS-WDA-STANDALONE-01 — Protected standalone WDA observation

**Observable behavior:** with an externally prepared WDA MJPEG loopback source, a user starts FSQ independently, completes protected Viewer pairing, creates valid visible demand, and sees the first fresh iPhone JPEG in standalone Chrome within five seconds. Closing the Viewer stops only FSQ observation and leaves WDA/automation alive.

**Non-goals:** WDA ownership, WebDriver/Appium commands, automatic source restart, quality/FPS claims, cross-repository Agent launch/attach and non-WDA sources.

**Serial work packages:**

| WP | Primary module | Behavior/seam gate | Product | Tests | Docs |
| --- | --- | --- | ---: | ---: | ---: |
| WP1 | Contracts + Capture seam | control v2 and two real Adapter types; Android regression unchanged | ≤280 | ≤350 | ≤70 |
| WP2 | Capture | strict attach-only WDA source, multipart/JPEG metadata, cancellation | ≤360 | ≤470 | ≤100 |
| WP3 | Runtime | media minor 1 MJPEG, one-frame ownership, terminalization | ≤250 | ≤310 | ≤80 |
| WP4 | Viewer | Worker ImageBitmap decode, Canvas/Live/visibility cleanup | ≤310 | ≤370 | ≤100 |
| **Total** | | | **≤1200** | **≤1500** | **≤350** |

Each WP has unique file ownership, module verification and independent review before the next WP. The feature is Done only after the cumulative real WDA/iPhone/Chrome path passes and a new independent review closes the complete implementation diff.

### IOS-WDA-LIFECYCLE-02 — Truthful source changes and failure cleanup

**Observable behavior:** orientation/size changes, malformed multipart, source EOF/reset, forward loss, explicit stop and Viewer grace all produce truthful non-Live/terminal state and release only FSQ-owned resources. The core 2s/12s freshness state and recovery required to prevent stale Live are already delivered by `IOS-WDA-STANDALONE-01`; this feature adds exhaustive platform failure coverage rather than deferring that invariant.

- Dependency: `IOS-WDA-STANDALONE-01` Done.
- No automatic same-StreamId WDA restart.
- Product ≤650; tests ≤900; docs ≤220.
- Real acceptance includes orientation and externally induced WDA/forward loss; fixtures cover malformed and race paths.

### IOS-AGENT-BINDING-03 — Agent launch/attach without automation coupling

**Observable behavior:** a separately authorized `Appium_connect_agent` Adapter supplies stable device identity and an owner-only local source binding, then receives the protected FSQ Viewer description without sharing WebDriver objects or coupling Viewer and Session lifetime.

- Dependencies: WDA platform batch accepted; FSQ external launch/attach control seam separately confirmed.
- FSQ and `Appium_connect_agent` changes require synchronized SPEC/design/task material and separate repository authorization.
- No media bytes traverse the Agent control seam.
- Budget is not frozen until the existing deferred cross-process launch/attach protocol is designed.

### IOS-INDEPENDENT-SOURCE-04 — Non-WDA observation Adapter

**Boundary only:** select and implement a source such as a later-approved CoreDevice, public host capture or other observation route behind the same Capture interface. It must not change public `DeviceRef`, Agent control or Viewer state semantics merely to expose provider internals.

No candidate, version, dependency, budget or support claim is approved by this design. This feature requires a new requirements/design and library-selection decision.

## 17. Current platform completion condition

The WDA platform batch is not complete merely because `IOS-WDA-STANDALONE-01` paints a frame. Completion requires:

- `IOS-WDA-STANDALONE-01` and `IOS-WDA-LIFECYCLE-02` each pass their SPEC gate, implementation verification, real iPhone/Chrome evidence and independent review;
- Android regression remains accepted after Contracts/Capture/media changes;
- external prerequisite, source ownership, endpoint safety and cleanup are documented and reproduced;
- no quality, FPS, model/iOS family or physical-disconnect claim exceeds the evidence;
- a later user-confirmed SPEC delta explicitly names any support-matrix entry.

Agent binding and a non-WDA source are later product features, not hidden completion requirements for the first WDA platform batch.

## 18. Expected SPEC deltas

After final design confirmation and explicit `/spec-driven` authorization:

- **Root SPEC:** add the WDA iOS platform combination, staged WDA-first/non-WDA-later strategy, convenience-only target and external ownership boundary.
- **Contracts SPEC:** control v2, `android|ios`, stable provider-neutral identity and media minor-1 MJPEG semantics/errors.
- **Capture SPEC:** platform-neutral interfaces, explicit Android/WDA Adapters, codec-specific event ordering, WDA grammar, endpoint limits, host-arrival timing and cleanup.
- **Runtime SPEC:** codec-aware retained state and queue rules, MJPEG independent-frame behavior, unchanged auth/lease/terminal ownership.
- **Viewer SPEC:** MJPEG Worker decode, ImageBitmap ownership, capability rejection, Canvas/Live rules and no endpoint exposure.

The design document retains alternatives, version research, feature order, budgets and validation detail. SPEC contains only the user-confirmed current contract.

## 19. Cross-repository impact

A future separately authorized `Appium_connect_agent` iOS design must:

- own Appium/XCUITest/WDA/Session and USB-forward lifecycle;
- map its device to the shared provider-neutral `DeviceRef` without exposing UDID;
- pass any source binding through a protected owner-only local channel, never ordinary Agent/model output;
- receive only FSQ public Viewer/state values;
- keep automation alive when Viewer observation stops;
- tolerate FSQ ending when WDA disappears without treating that as Appium Session truth;
- never route MJPEG frames through MCP or the model.

No change to that repository is authorized here.

## 20. Risks and stopping conditions

- WDA v16.15.3 wire or orientation behavior differs from fixed source evidence.
- A compatible signed WDA artifact and USB forward cannot be provided without FSQ taking ownership.
- First fresh paint cannot meet five seconds from an already healthy endpoint.
- JPEG orientation cannot be made consistent without mutating WDA or pixel re-encoding.
- Media minor 1 would require an H.264 regression or a second Viewer pipeline.
- Endpoint, device locator, frame data or automation secret crosses a public/model-visible seam.
- `exifr` actual package/API/license/integrity differs from the approved record.
- Product changed-line budget is clearly insufficient; the feature must be resplit before implementation.
- Required real iPhone/WDA/Chrome evidence or independent review is unavailable.

Any of these stops the relevant feature and returns to the user; they are not handled by silent fallback, lower standards, additional dependencies or unapproved source selection.

## 21. Decision record

Confirmed by the user in this requirements workflow:

- convenience is prioritized over stream quality;
- first source is WDA, followed later by an independently selected non-WDA Adapter;
- automation and observation lifecycles remain independent;
- WDA is externally owned and FSQ is attach-only;
- service-side MJPEG parsing and shared FSQ Runtime/Viewer are selected over direct `<img>` and transcoding;
- only First Live ≤5 seconds remains as a numerical media gate;
- `exifr==7.1.3` is approved for orientation-only use;
- bounded WDA multipart/JPEG SOF parsing is an approved narrow self-development exception;
- this design approval does not authorize implementation.
- the user explicitly confirmed this final design on 2026-10-26 as the basis for a later SPEC gate; confirmation does not authorize implementation.

## 22. Independent design review

The first independent full review returned `status=findings` with `DR-IOS-01..08`: undefined platform-neutral open policy, incomplete binding identity, incomplete WDA headers, sequence/credit loss during replacement, missing MJPEG reconfiguration grammar, stale Live, unreachable painted-first-frame timeout and unbounded decoded pixels. The repair-only review closed seven findings and identified direct regression `DR-IOS-04-R1` because staged plus assigned JPEG bytes were not both counted in the Runtime cap. The final targeted repair froze one continuous 8 MiB ownership calculation and maximum-payload fixtures. The same independent context verified content SHA-256 `4a18876828390efaed03b16086e53af1e5d6029cdab0a490c461231a2defbaf3`, closed `DR-IOS-01..08` and `DR-IOS-04-R1`, found no direct regression and returned **PASS**.
