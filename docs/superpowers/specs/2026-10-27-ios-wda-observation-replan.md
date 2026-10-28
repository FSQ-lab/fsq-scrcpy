# iOS WDA Observation — Design Repair and Gate Decision

- Status: confirmed ACK/profile SPEC and one-feature exception implemented; WP3 full+repair1 and WP4 cumulative full+repair1 code audits closed all findings. Native iPhone/WDA/Chrome standalone acceptance now includes real grace-expiry cleanup and exact reason-3/no-Config wire evidence after one focused Runtime timer repair. The user moved Appium Session-transition verification to the later Agent integration feature, so `IOS-WDA-STANDALONE-01` is Done; Android regression, unified CLI/MCP Agent integration and platform/support-matrix acceptance remain deferred.
- Authorization: the original design/review scope was renewed by explicit spec-driven authorization for the1600/2000/350 exception, its AGENTS/design record and subsequent ACK/profile gate→WP3→WP4 sequence. No implementation starts before SPEC confirmation; no other feature/platform/dependency or prohibited operation is authorized.
- Source design: [2026-10-26 design](2026-10-26-ios-wda-observation-design.md), SHA-256 `c447be999e1a32fe2feec9c38438a19e2bd336c03a672839e3f5a266c832373c` before this repair.
- Baseline: `main`, HEAD `471e56ca29b504007faef17e517ad4ef382b5c01`, initially clean. Current task snapshot: `/tmp/fsq-ios-wp2-audit/manifest.json`; all 39 files and eight complete diff artifacts preserved. No WP3/WP4 code exists.

## 1. Decision and unchanged obligations

The user explicitly chose **保持 iOS 单一目标**, **1024 条／滚动十秒** for ACK protection, and **采用目标 profile**, then confirmed the precise ACK/profile SPEC delta. The Android-v2 predecessor remains rejected; no platform reordering, WDA separation/replay or accepted-baseline reset follows. `IOS-WDA-STANDALONE-01` remains the single original end-to-end target under the renewed scope; WP3 precedes WP4 and all applicable verification/review gates remain.

The original1200-line target was not declared feasible or bypassed by splitting. The user explicitly authorized a one-feature exception of1600 product/2000 test/350 documentation additions+deletions from the same original HEAD. Root AGENTS records that narrow override; other features keep the default rule. No owner-based exclusion, compression, net-growth accounting or new baseline is permitted.

The protected iOS goal retains all original requirements: external WDA/forward ownership, no automation commands, one source/stream/Viewer, strict identity, protected loopback pairing/Host/Origin/CSP, in-memory frames, First Live ≤5 seconds from first valid visible demand, 2-second stale/non-Live, 12-second terminal, same-session recovery, truthful orientation/epoch changes, bounded ImageBitmap/transport ownership and deterministic local cleanup. No non-WDA Adapter, Appium repository change, source restart, FPS/resolution/latency claim or support-matrix entry is added.

## 2. Evidence and authorized size gate

WP1 module/seam verification passed full review plus one documentation-budget repair review. WP2 Capture module verification and full independent review passed. Neither result is a complete feature or real-platform acceptance.

| Accounting category | Current original-HEAD cumulative |
| --- | ---: |
| Product, including generated outputs and package/lock | 538 |
| Tests and smoke | 775 |
| Documents and notices | 121 |

The cumulative evidence predates this new design document; this document and any subsequent edits also count. The existing work and its attribution remain traceable even if a later accepted feature establishes a new baseline.

The WP3 engineer's original normal-code estimate is 340–440 product additions+deletions and 340–430 test lines, excluding generated files. An additional pre-demand profile path costs approximately 20–35 Runtime-side product and 25–40 test lines; Main/Worker preflight is additional Viewer work. These are estimates, not measured diffs.

A main-session read of `viewer/src/protocol.ts`, `worker.ts` and `app.ts` identifies codec/version/reset grammar, bounded SOF checks, native bitmap decode and fencing, render-size adaptation, immediate ACK, local non-Live timing, capability probes and owner-configured startup as required changes. The old WP4 310-line allocation is **not** evidence that this complete work fits. A conservative normal-code planning range is 310–450 Viewer/integration product lines, with generated output counted separately. This is an inference, not a committed implementation budget.

All current538 product lines stay in the original-HEAD ledger. Runtime340–440 + profile20–35 + Viewer310–450 yields an inferred1208–1463 total before additional generation/integration closure; this remains an estimate, not measured output. The newly authorized1600 cap provides bounded headroom. The source design's serial allocation reserves WP3 product530/tests550/docs20 and WP4 product532/tests675/docs30 after measured prior code/tests, with all prior/new gate documentation in one300-line reserve. The total is exactly1600/2000/350; caller/generated/packaging closure is included, not excluded. Exceeding an allocation requires a documented within-total reallocation; exceeding any feature total stops work for the user. This resolves the policy-size gate without declaring SPEC/real-resource gates passed.

## 3. Rejected independent-predecessor alternative

`ANDROID-CONTROL-V2-MIGRATION-01` was investigated as a genuine independent behavior: v2 owner API through real Scrcpy/Runtime/production Viewer, including Android quality, rotation, leases and cleanup. It could avoid the Capture-only acceptance cycle, but changes platform order and would require preserving/separating current WDA work and new scope authorization. The user rejected it in favor of the single iOS target. No such feature, budget allocation, separation/replay or new accepted baseline is adopted.

## 4. Original iOS feature remains end-to-end

`IOS-WDA-STANDALONE-01` retains its original HEAD baseline and the newly authorized one-feature cap/serial allocation. WDA Capture, Runtime media1.1 and the sole production Viewer remain one end-to-end behavior; Runtime and Viewer do not become separately “Done” features. Core5/2/12-second safety is not moved into LIFECYCLE-02. Actual WDA/iPhone/forward/Chrome are the standalone gate; the user deferred Android regression to §17 platform completion.

The renewed explicit spec-driven authorization is limited to this original iOS feature and the stated process exception. It requires the ACK/profile SPEC gate before WP3 and WP3 verification/independent review before WP4. Any genuinely new feature/process exception or unapproved dependency still needs its own authorization; real-platform acceptance cannot be substituted with fixtures.

## 5. Proposed minor-1 ACK contract

The user selected and confirmed **1024 ACK messages per rolling10seconds** for accepted MJPEG minor1 in the precise SPEC gate. H.264 minor0 remains128. Non-ACK remains32 and text remains4096bytes. The window is `(now−10000,now]`; at the same monotonic timestamp the first1024 pass the rate check and the1025th closes1008. All ACKs, including duplicates, zero/release-only and old-epoch values, count. Counters are bounded; no new limiter dependency/framework is introduced.

This is an abuse-policy limit, **not** an FPS cap, source throttle, WDA setting, performance claim or proof that every legitimate buffered burst stays below it. Ideal60 completions/second corresponds to600 ACKs/10s, but upstream asynchronous processing/forwarding does not establish a strict rolling arrival bound.640 saves little memory and has less margin. If the owner requires all valid progress to be exempt from a fixed counter, that requires a different explicitly confirmed protection model; this recommendation does not claim that property.

- Mode comes from Runtime-accepted Session codec/minor, not a client paint field. Before binding, retain existing startup-zero ACK behavior/128 limit and reject the minor1 four-field form. Binding does not reset existing rate records.
- Minor1 shape is exactly `{v:1,type:"ack",sequence:<canonical-u64-string>,paintedSequence:<canonical-u64-string>}`. Minor0's exact three-field shape and batching remain unchanged.
- Each draw **or discard** closes/releases its image, then immediately sends exactly one combined ACK. A paint advances both values; discard advances release only. No release-then-paint pair for the same closed image, four-frame wait, lease-tick wait or paint fabrication.
- Validate both values without side effects before atomically releasing credit/bytes, committing paint/freshness or flushing a next Frame. A stale release cannot bypass invalid paint checks. New release and paint values must identify actually sent Frames; paint≤release, monotonic, and never retroactively painted after release-only completion.
- The current accepted paint value may repeat idempotently, but repeats do not renew demand/freshness. Replaying an older paint after advancement is regression, not guaranteed historical idempotency. Old-epoch in-flight ACKs may reconcile known ownership but cannot restore Live or refresh current-epoch paint time.
- Frame-proof metadata must not grow over the whole stream. Proposed bound:1024 unconfirmed sent-Frame records, no JPEG payload references; normal cumulative ACK reclaims them, while GAP-invalidated unconfirmed records remain until reconciliation. Capacity is checked before sequence assignment; overflow follows existing runtime-overload terminalization, never silent evidence eviction. Only the most recent accepted paint scalars survive normal reclamation.
- At most one assigned JPEG remains; new assignment waits for both callback and ACK/GAP/terminal ownership release. Staging,8MiB total ownership and64KiB control reserve are unchanged.
- Malformed/rate failures close the Viewer1008 with existing grace/cleanup semantics; they do not become device disconnect. Oversize1009 and internal transport1011 remain. ACK never renews lease. Deadline checks also run at ACK linearization; late ACK cannot beat an already reached5s/12s deadline merely because a timer callback was delayed.

The1024 timestamp ring plus32-control ring uses8448 bytes of raw Float64 slots, not an RSS claim.1024 maximum-size ACKs plus controls permits4.125MiB accepted text/10s, not simultaneous buffering. Metadata representation/index overhead must be included separately; no claim that a JavaScript Map costs only its raw integer fields.

## 6. Proposed pre-demand media profile

The user selected and confirmed the target-profile contract: the trusted composition root supplies a required immutable provider-neutral `mediaProfile: "h264-annexb" | "mjpeg"` when constructing Runtime alongside its selected fixed CaptureSource. It is not inferred from platform and is not an endpoint/provider locator. Invalid/missing profile is a fixed safe construction failure before listening or allocating Capture. No compatibility default or source registry is added; every current constructor caller migrates. The precise bootstrap/start/probe rules are active in the confirmed module SPEC sections.

Runtime places the enum in the protected Viewer bootstrap, not DeviceRef, URL, reusable bearer or public ViewerDescriptor. Main passes it in the exact Worker start schema. Worker probes only the target foundation APIs/transfer/Canvas path before any visible renewal/source demand: H.264-only surfaces do not newly require JPEG APIs, JPEG-only surfaces do not require AVC APIs. A bounded synthetic capability probe is not a source frame, Live proof or guarantee that all later media content decodes. Probe failure/timeout disposes its resources and sends no visible renewal; actual Session must match the declared profile or fail closed without fallback.

The exact bootstrap/start/probe contract below was independently reviewed and confirmed in the module SPEC gate. The total preflight deadline is5000 monotonic milliseconds from accepted Worker start, separate from First Live. A late asynchronous result is fenced and any returned bitmap is closed. Actual content validation failures after successful foundation preflight remain typed failures; foundation preflight does not promise every source codec profile/content is decodable.

### 6.1 Exact candidate bootstrap and preflight protocol

- `RuntimeServiceOptions.mediaProfile` is required with exactly the two enum values above. Missing/invalid values throw local `TypeError("Invalid media profile")` before HTTP bind/source allocation; no new serialized StreamError, permissive default or provider-dispatch type is added. The composition root remains responsible for choosing the matching fixed source; Runtime rejects a first or later Session codec inconsistent with this immutable declaration as malformed-media.
- The existing no-store Viewer HTML emits exactly one root attribute `data-media-profile="h264-annexb"` or `data-media-profile="mjpeg"` from the validated enum. No query parameter, inline executable code, external fetch or ViewerDescriptor field is added. Main rejects missing/unknown profile as unsupported before worker start/demand; it does not guess from DeviceRef/platform. Existing protected route/manifest/CSP/authority and pairing remain unchanged.
- Main obtains the actual production Canvas2D context before start; no usable context means unsupported and no start/demand. Main→Worker start is exactly `{type:"start",origin,streamId,mediaProfile}`; existing origin/UUID/single-start checks remain. Visibility updates only the desired flag during preflight, cannot cause a lease, and does not invalidate this tiny synthetic probe; it may finish while hidden without entering Live. Pagehide/dispose invalidates it. A hidden successful start connects without visible demand until a later visible transition.
- H.264 retains its existing foundation checks for Worker, binary WebSocket, VideoDecoder and EncodedVideoChunk plus Main Canvas readiness. It acquires no JPEG/createImageBitmap capability requirement. Exact AVC configuration support still depends on the later real SPS/config; no new raw-VideoFrame constructor or synthetic AVC decoder requirement is imposed.
- MJPEG requires Worker createImageBitmap, transferable ImageBitmap and Main Canvas draw; Main also requires its ImageBitmap constructor for exact resource validation, without adding that requirement to H.264. Worker decodes one fixed, bounded synthetic JPEG (coded1×2, EXIF orientation6) using `{imageOrientation:"from-image"}`; its expected bitmap is2×1. The fixture is at most4KiB, contains no user content and is never a source Frame, source metric, paintedSequence or Live proof. Worker performs no WebSocket connection/hello/visible renewal until this profile's probe succeeds.
- Worker→Main probe is exactly `{type:"capability-probe",generation:1,mediaProfile:"mjpeg",frame:ImageBitmap}` with that bitmap transferred once. Main accepts it only from the current Worker while one startup probe is pending, verifies type/2×1 size, exercises the actual production bitmap/Canvas render path without entering Live or metrics, clears the tiny probe pixels, and closes the bitmap in finally. Main→Worker result is exactly `{type:"capability-result",generation:1,supported:boolean}`, once for that pending probe. This is capability testing in the sole production pipeline, not a second Viewer/source transport.
- The sender closes an untransferred bitmap on decode/transfer failure; after successful transfer Main is sole closer, including stale source, malformed message, pagehide/dispose and render-error paths. If decode completes after timeout/dispose/generation fencing, Worker closes the late result without transferring it. Timeout/unsupported discards all known probe resources and disposes the Worker; no persistent probe image, object URL or source socket remains.
- Probe false/failure/5000ms deadline becomes viewer-unsupported with zero Capture.open/visible-renewal count. Receiving an unexpected/duplicate probe or result is malformed-control and cannot open a socket. The deadline is checked again when handling success, so delayed timer callbacks cannot admit late success. A normal successful profile proceeds to the existing WebSocket hello and desired visible renewal; the authoritative five-second First Live timer still begins only at the first valid visible renewal. Ended/disposed/old-generation probe messages never revive the Worker.


## 7. Required verification of the repair

- Minor0 ACK128/129, minor1 ACK1024/1025, exact window expiry, controls32/33 and4096/4097-byte boundaries; counters do not reset on mode binding and the client cannot select its quota.
- One completion→one immediate combined ACK, including release-only; invalid paint cannot release ownership or admit another frame. Callback-only/ACK-only cannot assign a second JPEG.
- Current duplicate, old regression, future/unknown/non-Frame identity, release-only then retro-paint, GAP/old-epoch races and bounded proof-record reclamation/overflow.
- First-paint5s, stale2s, recovery before12s, terminal at12s, delayed timer callback, grace suspension/return and no late resurrection remain exercised through real Runtime and actual Viewer.
- H.264-only/JPEG-only capability fixtures, unsupported target with Capture.open count0 and visible renew count0, missing/mismatched profile rejection, no implicit platform mapping/fallback, probe timeout and late-bitmap close.
- Actual Chrome/iPhone/WDA/forward, actual orientation and resource ownership; no image/locator/secret enters files, logs, model output or screenshots sent to the model. Test fixtures are synthetic; real frame content remains private.

## 8. Rejected shortcuts and external gates

Capture-only feature plus a temporary JPEG decoder/Canvas bridge was investigated and rejected as an accepted-baseline workaround: it can supplement component correctness, but reuse of `drawFrame` alone does not validate the actual production Viewer protocol, generation/ownership and lifecycle. It cannot waive the project video-surface rule or become a second production pipeline.

A single-epoch first iOS feature with terminal retry on orientation change was also evaluated. It would reduce functionality and require explicit user approval; the engineer still estimates315–450 Runtime product and305–435 test lines including profile-side wiring, so it does not demonstrably solve the size gate. This repair does not adopt it or silently move reconfiguration out of the original feature.

No Chrome was found in checked application directories; no private device/WDA acceptance configuration keys were present. External owners must supply the actual resources and separately authorize their verification. FSQ must not install/start/sign/stop WDA or establish/repair the forward. Neither current feature is accepted on fixtures. Missing resources, a still-infeasible iOS budget or absent scope/SPEC confirmation keeps implementation blocked.

## 9. Confirmation and SPEC ownership

Confirmed decisions: single original iOS goal; no Android predecessor;1024 ACK/rolling10s; target-profile preflight; explicit1600/2000/350 original-HEAD exception; precise ACK/profile SPEC delta. WP3 implementation/verification/independent audit comes before WP4. Actual resources, real acceptance and final complete-feature review remain required. No scope reduction, accepted-baseline reset or automatic platform claim follows.

The confirmed SPEC gate covers Runtime ACK rate/atomic validation/bounded proof metadata and required constructor/bootstrap profile; Contracts paint identity semantics; Viewer immediate completion ACK and exact target-profile start/probe schema. Existing Capture/global ownership rules stay unchanged. Feature budgets/status remain in AGENTS/design/task materials, not SPEC; the module sections now contain active contracts rather than pending deltas.

## 10. Independent design review result

Fresh quality context `WdaReplanAudit` fully reviewed the101-line/16206-byte decision record SHA-256 `29b13f4f62ce9801e00a7cf1c9710e771c673a3b1ba7075fd7d239e89947b984` and the original design/SPEC/source evidence. It returned PASS for record/candidate coherence, no new technical/drafting findings, and explicitly `implementationReady=false/blocked`. G-01 still requires a feasible complete iOS size plan; G-02 still requires user scope/contract decisions and applicable authorization/SPEC gates; G-03 still requires real resources and verification authorization. This review does not approve any candidate or clear these gates. The reviewed content snapshot is preserved in the session evidence; this status/result addition changes no technical proposal or product code.

## 11. Renewed one-feature authorization

User authorization: `/spec-driven 仅对 IOS-WDA-STANDALONE-01 授权一次性规模例外：产品1600行、测试2000行、文档350行，全部按原HEAD累计；允许在AGENTS.md及设计材料记录本次例外。保持完整iOS目标和所有验收要求，先完成 ACK/profile的SPEC delta gate，再串行推进WP3→WP4；其余禁止事项不变`.

This explicitly resolves the former G-01 policy limit for this feature only. Historical blocked-review conclusions above describe their fixed snapshots, not a rejection of this later authorization. Recording the process exception is process-only no-delta under root SPEC's workflow-ownership clause; the separately prepared ACK/profile SPEC delta was independently reviewed and subsequently user-confirmed. No new dependency or self-development scope is selected by this documentation change.
