# Host-neutral MCP and Automatic Viewer Authorization Design

- **Status:** Confirmed by the user; independent full review `AVD-01..06` closed by repair-only R3 with pass; no SPEC or implementation authorization
- **Date:** 2026-10-29
- **TaskID:** `AGENT-AUTO-VIEWER-AUTH-DESIGN-20261029`
- **Platform:** local macOS arm64 + exactly one authorized USB Android + standalone Chrome Viewer
- **Authorization:** current explicit `/requirements-to-design` request: normal use has no pairing code, CLI approve or per-stream human authorization; authenticated Agent ensure authorizes one short-lived StreamId+Runtime-generation auto-bootstrap; no secret enters Agent/MCP/CLI/URL/log/argv/persistence; define lifecycle, races, cleanup, CLI behavior, SPEC impact, feature split and budgets while preserving current MCP work
- **Repository baseline:** `main`/`origin/main` at `efb29dcd57f1cbf7cb61fe374eee62ad76e3c3d5`; current worktree contains the preserved, paused Feature11 implementation and active prior SPEC delta
- **Pre-revision design SHA-256:** `5b690182017f0e2f83c5fff2e927718b984c2bf6db332740567f3e5958321840`

This workflow changes only this design. It does not authorize SPEC, product, tests, dependencies, device operations, commit, push or publish.

## 1. Problem and supersession

The current MCP transport works, but the confirmed product flow still requires an eight-character browser code and `viewer approve`. That is not an acceptable Coding Agent experience. A user must be able to say “open the Android screen,” receive or open the safe Viewer URL, and reach Live without a code, command, StreamId copy or per-stream approval.

If confirmed, this revision supersedes every owner-approved-pairing requirement in the preceding Feature11 design while preserving Host-neutral MCP, four tools, AgentControl, dual-era stdio, exact dependencies, CLI JSON fallback, empty verified-Host register and all non-viewer owner/media/platform restrictions.

## 2. Final user journey

```text
User: “Open the Android screen”
  → trusted local Agent calls fsq_viewer_ensure
  → authenticated ensure atomically arms one auto-bootstrap permit
  → Host opens, or presents one click to, safe standaloneUri
  → first eligible Viewer claims the permit
  → Runtime sets an HttpOnly media session cookie
  → Authorizing → Connecting → Syncing → Live
```

Normal use has no pairing page, pairing code, owner prompt, CLI approve or persistent auto-view setting. Hosts that cannot open a URI may present one clickable safe URL; strict zero-touch acceptance requires a Host/browser launcher, but the FSQ product contract never adds a secret URL.

User stop remains an Agent `stream stop`; Runtime remains available. A later ensure creates a new StreamId after terminal and repeats the same zero-pairing flow.

## 3. Confirmed trust decisions

- “Trusted Agent” means a local same-owner caller authenticated by the existing exact Runtime client bearer and current RuntimeTarget/generation. The model never receives that bearer.
- An authenticated ordinary ensure intentionally gains one additional power: mint one Viewer bootstrap permit for its current Stream. inspect/wait/stop stay unchanged; shutdown/reset/rebind/device/Appium authority remains owner-only.
- The user accepts the residual rule **first eligible browser wins**. With non-secret standalone URI and no browser extension, native helper, client certificate or browser-held pre-shared secret, loopback TCP cannot prove which macOS owner launched Chrome. Random StreamId prevents blind guessing, Host/Fetch Metadata blocks ordinary cross-site use, but another OS owner who already knows the full URI could win during the permit window.
- Manual pairing is removed by clean cut, not retained as fallback. This avoids two authorization state machines, downgrade ambiguity and pairing-slot denial of service.
- Cancellation before ensure linearization applies nothing. Cancellation or response loss after linearization does not revoke the permit; it remains until consume, absolute expiry or terminal so same-selector retry can reconcile.

Same-account malicious processes remain outside the existing threat model. Remote access, other platforms, multiple Viewers and Host support claims remain outside this revision.

## 4. Scope and non-goals

In scope: trusted in-process/RuntimeControl ensure auto-authorization, Runtime-private permit/session state, loopback HTTP claim, Viewer zero-code bootstrap, removal of pairing/approve surfaces, CLI caller migration, deterministic tests and real Chrome/Android acceptance.

Out of scope: remote/LAN/cloud, TLS/relay, browser extension/native helper/mTLS, secret URL/query/fragment, MCP Apps, embedded Viewer, second Viewer, recording/audio, device/Appium control, Windows/iOS, new library dependencies and support-matrix entries.

Capture and media protocols are unchanged. Capture still opens only after authenticated visible WebSocket demand; permit/claim/session creation must keep Capture.open at zero.

## 5. Preserved MCP implementation baseline

The paused `MCP-ADAPTER-MACOS-ANDROID-11A` implementation is preserved: shared AgentControl, exact four tools, dual projection, dual-era stdio process, second bin, server2.3.1/zod4.6.7/client2.3.1 lock closure and tests. Current evidence is Integrations 59/59, Contracts 30/30, Runtime 243/243, Capture 120/120 and Viewer 45/45.

Current cumulative churn from `efb29dc…` is product/config 598/600 and tests 885/900. No automatic-authorization code or test may be hidden in the remaining 2/15 lines or used to silently rebaseline Feature11A.

## 6. Deep ViewerAuthorization module

Runtime owns one deep internal `ViewerAuthorization` module. Its small interface hides permit, claim cookie, delivery rollback, media session, refresh/grace and terminal cleanup:

```text
armEnsuredStreamLocked(streamId) -> ViewerDescriptor
navigate(verifiedTopLevelRequest) -> claim decision
createSession(verifiedSameOriginRequest) -> session delivery
refresh(cookie) / deleteSession(cookie)
validateUpgrade(cookie) / connect(descriptor) / resumeVisible(...) / disconnect()
```

Only `RuntimeService.ensureControlViewer` and trusted in-process `ensureStandaloneViewer` may arm while holding the existing StateStore mutex. LoopbackHttp constructs verified request values only after exact Host/Origin/Fetch Metadata/framing checks. RuntimeControl, AgentControl, MCP and CLI interfaces add no token, mode, flag or result field.

Deleting this module would scatter permit, claim, rollback, session, grace and revoke logic across RuntimeService and HTTP, so the seam has real depth and locality. It reuses the existing mutex and terminal participant; no second product lock exists.

## 7. Auto-bootstrap state machine

One Runtime generation and active Stream have at most one authorization state:

```text
vacant -- authenticated ensure --> armed
armed -- first eligible top-level GET --> claim-delivering
armed -- permit deadline --> vacant
claim-delivering -- Viewer HTML response finish before deadline --> claimed
claim-delivering -- close/error before finish --> armed or vacant
claim-delivering -- permit deadline --> vacant
claimed -- same-origin session POST --> session-delivering
claimed -- permit deadline or DELETE before session --> vacant
session-delivering -- response finish before deadline --> session-issued
session-delivering -- close/error before finish --> claimed or vacant
session-delivering -- permit deadline --> vacant
session-issued -- authenticated WebSocket before media-session deadline --> connected
session-issued -- media-session deadline or DELETE before connect --> vacant
connected -- hidden/pagehide/socket/session expiry --> grace
grace -- same session within 5s --> connected/syncing
grace -- 5s expiry --> terminal lease-expired
any nonterminal -- stop/failure/shutdown/generation change --> revoked

### Permit and claim

- Permit TTL is exact 30,000 monotonic ms. `ViewerDescriptor.expiresAt` is a wall-clock description and never extends the monotonic deadline.
- Binding context includes fixed audience, Runtime instanceId/generation, StreamId and absolute deadline. Nothing persists across Runtime generation.
- Repeated/concurrent ensure while armed reuses the same permit and deadline; it never slides expiry or creates another permit.
- If armed expires before claim and no session exists, a later authenticated ensure may arm one new permit on the same nonterminal StreamId and return a descriptor with the new expiry.
- GET `/viewer/<StreamId>` with exact Host, no Origin and top-level `Sec-Fetch-Site:none`, `Mode:navigate`, `Dest:document`, no prefetch/prerender atomically reserves the first browser claimant. The HTML response is transactional: finish commits claimed and sets the claim cookie; close/error before finish rolls back to armed if TTL remains, otherwise vacant. A second claimant gets fixed 409 and cannot evict.
- Claim cookie is 32 CSPRNG bytes, canonical base64url, `HttpOnly; SameSite=Strict; Path=/; Max-Age=30`. Runtime stores only a context-bound HMAC digest. Viewer JavaScript cannot read it. A committed claimant may reload idempotently with that cookie; a cookie-less browser is never treated as the same claimant.
- Expiry/finish/terminal races linearize under the same mutex. Terminal fencing always revokes and wins. Otherwise `now >= absoluteDeadline` expires before claim/finish/session commit; deadline-1 commit wins. Late callbacks observe identity/state mismatch and allocate no replacement. `vacant` on a still-active Stream may be re-armed only by a new authenticated ensure; claimed/delivering/session-issued/connected/grace ensure never authorizes takeover.

### Session and media

- Viewer JavaScript POSTs exact `{streamId}` to `/v1/sessions`. A current claim cookie is the only bootstrap credential; no pairing code, pairingId, bootstrap grant or Authorization header exists.
- Valid POST atomically reserves `session-delivering`; 204 response provisionally sets `fsq_media_v1` but keeps `fsq_auto_v1` through pre-WebSocket delivery/retry. Response finish commits session-issued, while close/error before finish makes any browser-installed media cookie server-invalid and rolls state back to claimed if TTL remains, otherwise vacant.
- A committed response with lost client delivery is ambiguous. The same current claim retries with claim cookie plus optional media cookie: an existing valid media cookie is idempotent 204; absent/invalid media cookie rotates/reissues the same session identity without minting a second Viewer.
- First successful WebSocket connect consumes the server-side claim digest. The browser claim cookie may remain until Max-Age or a later media-authenticated HTTP response clears it; it has no authority after digest removal. Media cookie retains current 60-second reconnect TTL, 30-second HTTP refresh cadence, visible lease renewal and 5-second grace. Refresh never re-arms permit or renews visible demand. A valid same-Stream media cookie may reload Viewer HTML during session-issued/connected/grace without consuming a permit.
- Second WebSocket/Viewer remains fail closed. Only fresh painted output reaches Live; all cached frames are covered when Paused, Interrupted or any other non-Live state.

## 8. Idempotency, cancellation and cleanup

- Ensure pre-linearization cancel returns request-cancelled/not-applied and creates no permit.
- Ensure linearizes Stream resources, permit and coordinator publication in one mutex critical section. Post-linearization cancel/timeout/response loss returns existing state-unknown semantics while the permit remains; same-selector retry returns the same StreamId and permit state.
- Claimed/session-issued/connected/grace repeat ensure returns current descriptor/snapshot and never authorizes takeover. Expired armed state may re-arm as specified above. Terminal ensure always creates a new StreamId.
- Concurrent ensure shares one permit. Concurrent GET is first-winner. Concurrent session POST admits one delivering flight; other calls fail/retry deterministically.
- stop, device failure, Runtime shutdown, generation replacement and policy violation revoke permit, claim cookie, media cookie, pending delivery and raw wrappers before unified terminal cleanup. Cleanup failure never replaces the first terminal cause.
- Lost stop is reconciled by inspect of the original StreamId. Adapter never automatically retries mutations.

## 9. HTTP and browser surface clean cut

Keep Viewer/assets, `POST /v1/sessions`, refresh, DELETE and WebSocket routes. Delete:

- `POST /v1/pairings`;
- `POST /v1/pairings/<id>/redeem`;
- pairing cookie/code/pairingId/bootstrapGrant states;
- `POST /v1/viewer/approve` owner control route;
- CLI `viewer approve --code`;
- Viewer pairing-code DOM, surface interface and redeem polling.
Session POST requires exact Host, exact same Origin, `Sec-Fetch-Site:same-origin`, `Mode:cors`, `Dest:empty`, canonical JSON `{streamId}`, exactly one current claim cookie and no CORS/OPTIONS. Unknown/inactive route is 404; missing/expired/wrong claim is 401; no permit, other claimant or delivery/Viewer conflict is 409; existing size/media/admission errors remain fixed and secret-free.

Cookie names are exact `fsq_auto_v1` and `fsq_media_v1`; at most one of each is accepted and duplicate/unknown names or malformed values fail before state allocation. Before WebSocket connect, a current claim cookie with an absent, valid or server-invalid provisional media cookie identifies the same claimant and permits idempotent HTML/session retry; invalid media is overwritten, never treated as separate authority. After connect, a valid same-Stream media cookie authorizes reload even if the browser still presents a now-stale claim cookie, which the response clears. When a newly armed Stream is opened, stale revoked/other-Stream/old-generation cookies are cleared before a new claim cookie is committed. A cookie-less browser is never the same claimant.

DELETE `/v1/sessions/current` accepts the exact state-appropriate cookie set. A current claim digest before successful WebSocket connect authorizes DELETE with claim plus optional media cookie; it returns 204, clears both names and transitions claimed/session-delivering/session-issued to vacant without grace or terminal. After claim consumption, a current media cookie with optional stale claim cookie preserves existing revoke→grace semantics and clears both names. Missing, duplicate, unknown, stale-only, other-Stream or old-generation credentials return fixed 401 with presented known cookie names cleared and no state mutation.

Eligible top-level navigation accepts either direct/native `Sec-Fetch-Site:none`, or an explicit user-activated link with `Sec-Fetch-User:?1` and `Sec-Fetch-Site` in `same-origin|same-site|cross-site`; all require no Origin, `Mode:navigate`, `Dest:document`. Missing user activation for non-`none`, iframe/nested destinations, and any `Purpose`/`Sec-Purpose` prefetch or prerender are rejected. The accepted known-URI first-browser residual applies to both native open and user-activated links.

Viewer displays Authorizing, Connecting, Syncing, Live, Paused, Interrupted and existing terminal states. Hidden/pagehide produces Paused/grace, fresh return produces Syncing until a new paint, and source freshness loss produces Interrupted; every non-Live state covers cached imagery. A 401 says authorization expired and asks the Agent to show the Viewer again; a 409 says the Viewer is already open elsewhere. Browser retry never calls control ensure or extends the permit.

## 10. Safe data and authority

Agent, model, MCP/CLI results, ViewerDescriptor URI, logs, argv, env and persistent files contain no permit, claim cookie, media cookie, ViewerGrant, bootstrap grant, pairing code, pairingId, owner/root/client credential or Runtime locator. Runtime raw values are non-enumerable/redacted wrappers and stored only as context-bound digests where possible.

The owner bearer remains for shutdown and maintenance only. Ordinary client bearer accessing owner routes remains 401. No MCP tool or CLI Agent command gains shutdown, reset, rebind, device control or Appium authority.

## 11. CLI and MCP behavior

The four MCP tools, schemas, results and dual-era behavior remain unchanged. `fsq_viewer_ensure` now automatically arms the permit through the same AgentControl interface; AgentControl does not know permit internals.

CLI-only Agent `fsq-scrcpy viewer ensure ... --json` gets identical zero-pairing behavior. `viewer approve` is removed by clean cut and becomes deterministic invalid CLI syntax before product I/O. Existing inspect/wait/watch/stop, status/shutdown/reset/rebind behavior remains.

Old pairing Runtime and new auto-bootstrap clients fail closed through exact `RuntimeInstance.features` clean cut: `features` becomes `['wait-v1','auto-bootstrap-v1']`; missing, extra, duplicate or reordered tuples are incompatible. No pairing compatibility shim or deprecated alias remains.

## 12. Module SPEC impact

- **Root:** replace owner-approved pairing with authenticated-ensure auto-bootstrap, record first-eligible-browser residual and no support claim.
- **Contracts:** `ViewerDescriptor` shape remains and expiresAt becomes the permit deadline. Serialized `EnsureViewerValue` remains exact `{deviceRef,descriptor,snapshot}`, so AgentControl/MCP ensure results remain unchanged. Add exact feature tuple `['wait-v1','auto-bootstrap-v1']`. Remove ViewerGrant, ViewerAccess, ApproveViewerValue and their validators/canonical forms. Remove application `ControlError unauthorized` from its union/validator/canonical order/route allow-sets; browser/transport 401 and StreamError unauthorized remain separate.
- **Runtime-local ensure:** `EnsureResult` clean-cuts to `{ok:true,value:{descriptor:ViewerDescriptor,snapshot:StreamSnapshot}}|{ok:false,error:StreamError}` for both trusted in-process and control composition. IdempotencyKey/device binding/retention remain; same key retries follow the permit rules above, pre-linearization cancel applies nothing, post-linearization response loss retains permit, and every existing caller/fixture migrates in one cut with no ViewerAccess alias.
- **Runtime:** own ViewerAuthorization; arm in ensure; replace pairing/redeem/bootstrap flow; remove owner approve route/client/local seam; preserve shutdown and all media/session/grace behavior.
- **Viewer:** remove code UI and pairing/redeem; consume claim-cookie session POST; fixed 401/409 UI; Worker/media pipeline unchanged.
- **Integrations:** MCP interface no-delta; remove CLI approve grammar/mapping/tests and owner-local approve; migrate feature validators/fixtures. CLI ordinary ensure becomes zero-pairing.
- **Capture:** no-delta; prove permit/session stages allocate no Capture.

No new dependency is selected. Existing server/client/zod lock closure remains valid unless implementation changes the lock.

## 13. Feature split and order

### `MCP-ADAPTER-MACOS-ANDROID-11A`

- **Goal:** current Host-neutral four-tool dual-era Adapter and shared AgentControl.
- **Acceptance:** installed official-client/byte-level protocol, full automated regressions and independent implementation audit. It creates no Host/platform support claim and does not claim final Viewer UX.
- **Current cumulative size:** product/config 598/600; tests 885/900; documentation remains under the confirmed 360–460 envelope. No further product/test scope may be added; audit findings beyond remaining 2/15 lines require user budget action.
- **SPEC impact:** current active Root + Integrations sections, later narrowed where 11B clean-cut changes shared auth wording.

### `AGENT-AUTO-VIEWER-BOOTSTRAP-MACOS-ANDROID-11B`

- **Goal:** one Runtime-owned vertical clean cut from authenticated ensure to zero-code standalone Live; Contracts/Viewer/Integrations are caller migrations, not parallel authorization modules.
- **Dependency:** 11A accepted and fixed as baseline. No new dependency.
- **Owning module:** Runtime; narrow clean-cut migrations in Contracts, Viewer and Integrations; Capture no-delta.
- **SPEC impact:** Root + Contracts + Runtime + Viewer + Integrations.
- **Budget from accepted 11A baseline:** product 700–1100, tests 1000–1700, documentation/SPEC 350–650 additions+deletions. Exceeding any upper bound stops for user decision; no test deletion, line packing or reclassification.
- **Real acceptance:** installed CLI and both MCP eras each reach real Chrome Live without code/approve; first-browser race, TTL±1, repeat/response-loss ensure, cancel, response delivery rollback, refresh/grace, Runtime restart, stop/new StreamId, privacy and global ADB/device-setting survival.
Order is accepted 01→04B → confirm this design → new `/spec-driven` first performs a document-only split SPEC gate that narrows 11A to Adapter/transport acceptance and assigns final Viewer chain to 11B → audit/accept 11A against that confirmed basis → 11B SPEC gate/implementation/real chain → future exact Host parity gates. The split SPEC gate may precede 11A acceptance; 11A acceptance is required only before 11B product implementation.

## 14. Verification matrix

1. Contracts: exact feature tuple and clean removal of ViewerGrant/Access/Approve exports; ensure/descriptor safe shapes unchanged.
2. Runtime deterministic: 30,000ms deadline-1/exact/late callbacks, wall jumps, every pending/delivering/session-issued expiry and DELETE path, concurrent/repeat ensure, expired re-arm, cancel/stop races, generation ABA, first-browser race, HTML/session delivery commit/rollback, valid/stale cookie reload, refresh/grace/revoke and Capture.open=0 before visible demand.
3. HTTP: native open and user-activated Host link, Host/Origin/Fetch-User/Site/Mode/Dest, iframe/prefetch/prerender, exact cookie combinations/duplicates/stale clearing, 404/401/409/429, removed pairing/redeem/approve routes and all close/error counters.
4. Viewer: no pairing DOM/code/poll/grant; session 204 before Worker; Authorizing/Connecting/Syncing/Live/Paused/Interrupted/terminal transitions; fixed 401/409; H.264/MJPEG, paint/ACK/visibility regressions unchanged.
5. Integrations: approve grammar rejected before I/O; owner seam removed; four MCP tools/results unchanged; cancel/EOF/session close never stop stream/Runtime.
6. Real macOS Android: native open and one-click link, fresh/reattach zero-code ensure, first fresh Live existing ≤5s metric after authenticated visible demand, rotation/quality, two-profile race, TTL/response rollback and stale cookies, response-loss same StreamId, refresh/5s grace, stop-only-stream, new StreamId, old claim invalid after Runtime restart, owner shutdown, privacy scan and global ADB/device settings survival. Run both legacy and modern MCP chains; verified Host register remains empty.

No device frame, screenshot, pairing value or secret enters model context, evidence files or logs. Human visual confirmation is limited to current-device image/orientation/quality.

## 15. Risks and stop conditions

- Accepted residual: another OS user who already knows the complete non-secret URI may win the 30-second first-browser race. If cross-UID claimant isolation becomes mandatory, stop and select a browser-bound trusted channel or restore human pairing.
- Stop if any secret must enter URI, model, MCP/CLI, argv/env, persistence or logs; if Integrations needs owner bearer/new tool; if dual pairing fallback is retained; if feature negotiation cannot clean-cut old Runtime; if a second Viewer/remote/helper/new dependency is needed; if Capture/media behavior changes; or if budgets are exceeded.
- Prompt injection or autonomous trusted-Agent ensure can authorize viewing. This follows the accepted trust model: authenticated local Agent calls represent user viewing intent.
- The current Feature11 worktree remains preserved and paused until this design is reviewed/confirmed and a new `/spec-driven` authorizes revised SPEC and implementation sequence.

## 16. Confirmed decisions and remaining gate

Confirmed on 2026-10-29:

- authenticated Agent ensure is the viewing authorization;
- first eligible browser wins within the 30-second permit window, with no known-URI cross-UID claimant guarantee;
- manual pairing, pairing/redeem routes, owner approve and CLI approve are deleted by clean cut;
- Agent/MCP/CLI interfaces carry no authorization secret and gain no other owner power;
- Feature11A preserves the current MCP implementation and exact budgets; Runtime-owned Feature11B performs the zero-pairing clean cut under its separate budget;
- independent full review `AVD-01..06` passed after repair-only R1–R3.

Only a later `/spec-driven docs/superpowers/specs/2026-10-29-macos-android-mcp-early-design.md` may first revise the split SPEC basis, accept 11A, and then authorize the 11B SPEC gate/implementation sequence.
