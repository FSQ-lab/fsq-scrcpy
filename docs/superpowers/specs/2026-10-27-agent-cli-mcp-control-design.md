# Unified FSQ_scrcpy Android/iOS CLI and MCP Control Design

- **Historical source:** This former sequential plan is retained only as design provenance. GitHub Issues own current scope, priority, dependencies, status, and acceptance; Issue #2 owns the migrated `IOS-AUTO-BINDING-MACOS-09` completion record.

- **Status:** confirmed by the user; independent full review plus repair-only rounds 1–2 passed; explicit `/spec-driven` authorization received for the sequential feature plan. Implementation remains gated by the current Android regression, per-feature SPEC confirmation, selection evidence, verification and independent audit.
- **Date:** 2026-10-27
- **Authorized workflows:** `/requirements-to-design` produced and reviewed this design; `/spec-driven docs/superpowers/specs/2026-10-27-agent-cli-mcp-control-design.md` authorizes only the confirmed sequential FSQ_scrcpy scope. `Appium_connect_agent` still requires its own repository workflow.
- **TaskID:** `ANDROID-IOS-AGENT-CLI-MCP-DESIGN`
- **Current repository baseline:** `main` at `656717de68a9b61f08c7fdf61df579527e4ca7f4`
- **Target product:** independently installable `FSQ_scrcpy` command-line and Model Context Protocol tools, composable by an Agent Host with independently installable `Appium_connect_agent` tools

## 1. Background

`FSQ_scrcpy` owns video capture, stream lifecycle, distribution and the protected standalone Viewer. `Appium_connect_agent` owns Appium Session lifecycle, device actions, semantic observation and its own Agent integrations. The projects already have a confirmed responsibility seam, but `FSQ_scrcpy` currently exposes only an in-process Runtime interface:

```text
ensureStandaloneViewer
inspect
stop
approvePairing
```

The existing `serve:viewer:real` entry is a standalone acceptance surface with stdin owner commands. It is not a stable cross-process product interface, command-line contract or Model Context Protocol Server.

The user wants:

1. one `FSQ_scrcpy` command-line interface shared by Android and iOS;
2. one `FSQ_scrcpy` Model Context Protocol Server exposing the same video-control behavior to Agents;
3. independent `Appium_connect_agent` command-line and Model Context Protocol tools for automation;
4. an Agent Host that can load either project alone or both projects together;
5. no media bytes through command-line output, Model Context Protocol messages or model context;
6. Appium Session/video-lifecycle independence verified when both projects are integrated.

## 2. Confirmed product decisions

The following decisions were explicitly confirmed in this requirements workflow:

- `FSQ_scrcpy` and `Appium_connect_agent` remain independently installable and independently useful.
- `FSQ_scrcpy` owns its own command-line tool and its own Model Context Protocol Server. `Appium_connect_agent` owns its own command-line tool and its own Model Context Protocol Server. The Agent Host composes them by loading two independent Servers; no aggregator Server is added.
- `FSQ_scrcpy` supports macOS and Windows host products. macOS targets Android and iOS; Windows initially targets Android only. Local iOS through WebDriverAgent remains macOS-only.
- Runtime control uses a dedicated HTTP/1.1 JSON listener bound to exact `127.0.0.1` on a stable, private per-`DeviceRef` port. It is separate from the Viewer HTTP/WebSocket origin and never transports media.
- One persistent `FSQ_scrcpy Runtime` process owns exactly one `DeviceRef`, one logical stream and one active Viewer. Client exit does not stop Runtime or stream. Runtime shutdown is an explicit owner operation.
- Model Context Protocol tools may start or attach, ensure a Viewer, inspect/wait state and explicitly stop a stream. They cannot approve browser pairing, mutate device configuration or shut down Runtime.
- A human approves Viewer pairing through the owner `FSQ_scrcpy` command-line tool.
- State waiting uses bounded long-polling; cancellation ends only the wait.
- `FSQ_scrcpy` requires no hand-written device configuration. It automatically maintains the minimum per-user private local state needed for stable safe `DeviceRef`, provider binding and Runtime rendezvous; Agents receive only safe values.
- The first Model Context Protocol presentation returns the existing protected standalone `ViewerDescriptor`; embedded Model Context Protocol App presentation is deferred.
- One npm package publishes both `FSQ_scrcpy` executables.
- The first real Model Context Protocol Host is Oh My Pi.
- Implementation order is macOS Android, Windows Android, macOS iOS, then the Model Context Protocol Adapter.
- The first Windows combination is Windows 11 x64 with USB Android. Windows ARM64 is deferred.
- The local threat model protects against other operating-system users, browser-origin requests, accidental callers and secret disclosure. A malicious process already running under the same operating-system account is out of scope.
- Windows support retains an equivalent private-storage/security contract through a small audited and signed Windows-native helper. Its language, interface, build provenance and signing remain a later explicit selection gate.
- Windows Android verifies the pushed scrcpy-server on the device with SHA-256 rather than trusting the Android Debug Bridge version alone.

## 3. Approved dependency direction

The user explicitly confirmed native-language official Model Context Protocol SDKs:

### FSQ_scrcpy

- Candidate approved for future implementation: exact `@modelcontextprotocol/server@2.3.1`
- Source tag commit: `fcef852f6cdafea07f36cf6fae69b37c8adf85be`
- License: Apache-2.0
- Runtime floor: Node.js 20 or newer; current Node.js 24.22.1 satisfies it
- Published direct dependencies: `@modelcontextprotocol/core@2.3.1`, `zod@^4.2.0`
- Initial Agent Host transport: standard input/standard output through the SDK `serveStdio` lifecycle
- `stdout` is protocol-only; diagnostics use bounded, secret-safe `stderr`

### Appium_connect_agent

- Candidate approved for its later independent design: exact Python package `mcp==2.3.0`
- Source tag commit: `2118f14f8a19bc158d8a1cf90af58d85d187f849`
- License: MIT
- Python floor: 3.10; current `Appium_connect_agent` Python 3.11 satisfies it
- The package has a broad dependency closure including `mcp-types`, Pydantic, AnyIO, `httpx2`, Starlette, Uvicorn, JSON Schema, PyJWT and OpenTelemetry
- `Appium_connect_agent` already uses `httpx==0.28.1`; `httpx2` is a distinct distribution but creates a second HTTP stack and therefore requires an explicit lock/security/license review

This approval does not authorize installation. Each future implementation must verify exact lock integrity, all transitive licenses, current vulnerability state, package-index availability and actual TypeScript/Python compatibility before Ready.

The command-line parser for `FSQ_scrcpy` uses stable Node.js 24 `node:util.parseArgs`; no command-line parsing dependency is selected.

## 4. Product scenarios

### S1 — Start a Runtime and ensure a Viewer

No compatible Runtime is listening for the requested platform/device. On first Android use, `FSQ_scrcpy` requires exactly one authorized local device, creates a stable safe `DeviceRef` mapping automatically, starts the fixed composition, waits for authenticated readiness and calls `ensureViewer`. The result says `started`, includes the safe `DeviceRef`, `ViewerDescriptor` and initial `StreamSnapshot`, and does not open Capture until an authenticated visible Viewer renews demand.

### S2 — Attach to an existing Runtime

A compatible Runtime for the same exact safe `DeviceRef` already owns the automatically stored control port. The caller authenticates, verifies instance/control/Contracts versions, attaches and returns `attached`. It does not create a second Runtime or Capture. An unrelated listener, different device identity, incompatible version or failed authentication is a typed conflict; no process is killed or replaced.

### S3 — Inspect and wait

The caller reads the current `StreamSnapshot`, or waits up to a bounded interval for changes after a revision. Changes remain strictly ordered. An old cursor returns the current snapshot with `reset:true`. Timeout is a successful empty wait, not a stream failure. Cancellation ends only that request.

### S4 — Human Viewer pairing

The Agent obtains a non-secret standalone `ViewerDescriptor` and the user opens it. The page displays the existing eight-character pairing code. The user enters the code through the owner command-line tool. Runtime retains `ViewerGrant`; no command-line JSON or Model Context Protocol result contains it.

### S5 — Explicit stream stop

The command-line or Model Context Protocol tool stops only the selected FSQ stream, preserving existing expected-revision and idempotent terminal semantics. It releases FSQ-owned Capture, media, Viewer auth and queue resources. It does not stop Runtime, the global Android Debug Bridge server, WebDriverAgent, USB forwarding or any Appium Session.

### S6 — Explicit Runtime shutdown

Only the owner command-line tool may request Runtime shutdown, naming the current instance generation. Runtime first terminalizes its stream, closes control/Viewer listeners and exits. Model Context Protocol tools cannot invoke this operation.

### S7 — Independent composition with Appium_connect_agent

An Agent Host may load both independent Model Context Protocol Servers. `Appium_connect_agent` tools own Session/actions/semantic observation; `FSQ_scrcpy` tools own video. The Host or acceptance harness coordinates through public tool results and the same safe logical device identity. Neither project imports the other's internal implementation.

## 5. Scope and non-goals

### In scope

- local macOS and Windows command-line tools;
- local standard-input/standard-output Model Context Protocol Server;
- provider-neutral Android/iOS `DeviceRef` input;
- automatic private device binding and local Runtime state;
- start-or-attach, ensure Viewer, inspect, bounded wait, stream stop;
- owner pairing approval and Runtime shutdown through command line only;
- one Runtime per device;
- persistent Runtime after clients exit;
- standalone Viewer URL result;
- macOS Android/iOS and Windows Android feature sequence;
- cross-project acceptance using two independent Agent tools.

### Out of scope

- frame/JPEG/H.264 data in control HTTP, command-line output, Model Context Protocol, resources or model text;
- direct Capture/Viewer/internal-object access from adapters;
- `ViewerGrant`, cookie, WDA endpoint, UDID, Android serial, Appium Session ID, filesystem path, PID or raw provider error in Agent-visible values;
- a combined/aggregating Model Context Protocol Server;
- embedded Model Context Protocol App presentation in the first release;
- remote/LAN/cloud control, TLS, relay or Windows-to-macOS remote iOS;
- multiple devices per Runtime, multiple streams or multiple Viewers;
- Runtime shutdown or pairing approval from Model Context Protocol;
- automatic download/management of Android Debug Bridge, USB drivers, WebDriverAgent or USB forwarding;
- Windows iOS capture;
- Windows ARM64 in the first Windows feature;
- support-matrix claims before exact real-platform acceptance.

## 6. Module architecture

```text
Agent Host
  ├── FSQ_scrcpy Model Context Protocol Adapter ─┐
  ├── FSQ_scrcpy command-line Adapter ───────────┤
  │                                               ▼
  │                                      RuntimeControl client
  │                                               │
  │                             authenticated loopback HTTP/1.1 JSON
  │                                               │
  │                                               ▼
  │                                      RuntimeControl provider
  │                                               │
  │                                existing in-process Runtime interface
  │                                               │
  │                     Capture → Runtime media → protected Viewer
  │
  └── Appium_connect_agent Model Context Protocol/CLI
         └── Appium Session, actions and semantic observation
```

### RuntimeControl — deep module

The seam sits outside the in-process Runtime and inside all external adapters. `RuntimeControl` hides:

- automatic stable per-device control endpoint state;
- process discovery, launch, readiness and attach;
- instance/version/feature negotiation;
- independent control authentication;
- private provider binding selection and composition;
- current `ViewerGrant` retention;
- idempotency-key generation/retention;
- bounded revision waiting;
- cancellation linearization and state reconciliation;
- persistent process ownership and shutdown;
- platform-specific private storage and owned process behavior.

Deleting `RuntimeControl` would force the same launch/attach/auth/version/watch/secret/cleanup logic into command-line and Model Context Protocol adapters. The module therefore has depth. Deleting either adapter removes only parsing and presentation.

### Adapter responsibilities

The command-line Adapter owns arguments, human/JSON rendering, exit status and owner-only commands. The Model Context Protocol Adapter owns tool schemas, structured results, cancellation forwarding and safe model-readable messages. Neither Adapter implements stream state machines, discovery or process policy.

### Existing modules

- Contracts remains the unique owner of `DeviceRef`, `StreamId`, `ViewerDescriptor`, `StreamSnapshot` and shared safe errors.
- Runtime owns in-process ensure/inspect/stop, media lifecycle, Viewer authentication and the new control provider/client implementation.
- Capture remains hidden behind `CaptureSource`; host-platform details are private Adapters.
- Viewer remains the sole media surface. No second Viewer is introduced.
- A new outer Integrations module is expected to own the two executable Adapters and depend on RuntimeControl plus Contracts. Runtime/Capture/Viewer do not depend on Integrations.

## 7. Candidate RuntimeControl interface

This is a design candidate for a future SPEC delta, not an active contract.

```ts
type ControlVersion = Readonly<{ major: 1; minor: 0 }>;
type AcquireMode = "attach-only" | "start-or-attach";

type DeviceSelector =
  | Readonly<{ kind: "auto"; platform: "android" | "ios" }>
  | Readonly<{ kind: "known"; deviceRef: DeviceRef }>;

type ControlError = Readonly<{
  controlVersion: ControlVersion;
  code:
    | "instance-not-found"
    | "instance-conflict"
    | "control-version-mismatch"
    | "unauthorized"
    | "malformed-control"
    | "deadline-exceeded"
    | "request-cancelled"
    | "runtime-exited"
    | "runtime-overload"
    | "dependency-unavailable"
    | "adb-incompatible"
    | "device-not-found"
    | "device-ambiguous"
    | "device-unavailable"
    | "artifact-unavailable"
    | "artifact-mismatch"
    | "local-state-recovery-required";
  disposition: "recoverable" | "terminal" | "state-unknown";
  operationState: "not-applied" | "unknown";
  safeMessage: string;
}>;

type RevisionConflictError = Readonly<{
  controlVersion: ControlVersion;
  code: "revision-conflict";
  disposition: "recoverable";
  operationState: "not-applied";
  safeMessage: string;
}>;

type ControlResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: ControlError }>;

type StopStreamResult =
  | ControlResult<Readonly<{ snapshot: StreamSnapshot }>>
  | Readonly<{ ok: false; error: RevisionConflictError; snapshot: StreamSnapshot }>;

type RuntimeInstance = Readonly<{
  controlVersion: ControlVersion;
  instanceId: string;
  generation: string;
  contractVersion: 2;
  deviceRef: DeviceRef;
  features: readonly ["wait-v1"];
}>;

type RuntimeAttachment = Readonly<{
  disposition: "started" | "attached";
  instance: RuntimeInstance;
}>;

type AcquireRuntimeRequest = Readonly<{
  mode: AcquireMode;
  selector: DeviceSelector;
}>;

function acquireRuntime(
  input: AcquireRuntimeRequest,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<ControlResult<RuntimeControlSession>>;

interface RuntimeControlSession extends AsyncDisposable {
  readonly attachment: RuntimeAttachment;
  readonly control: RuntimeControl;
  close(): Promise<void>; // control connection/waits only; no stream or Runtime side effect
}

interface RuntimeControl {
  ensureViewer(
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ControlResult<Readonly<{
    deviceRef: DeviceRef;
    descriptor: ViewerDescriptor;
    snapshot: StreamSnapshot;
  }>>>;

  inspect(
    input: Readonly<{ streamId: StreamId; afterRevision?: number }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ControlResult<InspectValue>>;

  wait(
    input: Readonly<{
      streamId: StreamId;
      afterRevision: number;
      waitMs: number; // 0..30000
    }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ControlResult<InspectValue>>;

  stopStream(
    input: Readonly<{ streamId: StreamId; expectedRevision?: number }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<StopStreamResult>;
}

type InspectValue = Readonly<{
  snapshot: StreamSnapshot;
  changes: readonly StreamSnapshot[];
  reset: boolean;
  timedOut: boolean;
}>;
```

Owner-only command-line operations use the same provider but are excluded from Model Context Protocol:
```ts
approveViewerPairing({ streamId, pairingCode }, { signal })
shutdownRuntime({ instanceId, generation }, { signal })
inspectLocalState({ platform })
resetControlState({ platform, expectedDeviceRef }, { signal })
rebindDevice({ platform, expectedDeviceRef }, { signal })
```

### Interface invariants


- `acquireRuntime` is the only external entry for start-or-attach and automatic first use. `selector:{kind:"auto",platform}` resolves/initializes the one supported local slot and returns its generated/reused safe `DeviceRef`; `selector:{kind:"known",deviceRef}` never remaps identity. `attach-only` never spawns. `start-or-attach` returns exactly one `started|attached` disposition after authenticated readiness.
- The injected Capture-owned binding resolver is private to the provider. CLI/Model Context Protocol never call it directly; zero/multiple/offline/ADB/artifact failures map to the exact safe `ControlError` codes above.
- Cancellation before readiness cleans only a provably unready owned child and uncommitted runtime state; cancellation after readiness leaves the persistent Runtime running and is reconciled by a new acquire/inspect call.
- `RuntimeControlSession.close()` closes only the control connection and pending waits.
- Runtime retains the `ViewerGrant`; external results contain only the resolved safe `deviceRef`, descriptor and snapshot.
- External callers do not supply media profile, Capture Adapter, endpoint, serial, artifact path or platform process fields.
- RuntimeControl privately generates and retains the in-process ensure idempotency key for the active Runtime generation and device. Transport correlation IDs are not semantic idempotency keys.
- A terminal stream followed by a new ensure receives a new semantic key/StreamId.
- Stop retains expected-revision compare-and-set and terminal idempotency. Generic failures use the snapshot-free `ControlResult` branch. Only exact `revision-conflict` uses `StopStreamResult`'s required current `snapshot`; runtime validators reject `snapshot` on every other failure.
- `wait` atomically establishes revision observation inside the provider; no inspect-then-subscribe gap. Timeout/cancellation never stops stream or Runtime.
- Scenarios S1/S2 use the selector union through `acquireRuntime`; S6 uses owner-only `shutdownRuntime`, never `stopStream` or session close.
## 8. Cross-process control protocol

### Endpoint and singleton authority

Each automatically managed device state receives one stable control port and independent 256-bit control credential. Runtime binds:

```text
127.0.0.1:<automatic-state-control-port>
```

The kernel listener is the instance claim:

1. authenticated hello succeeds with exact `DeviceRef` and compatible versions → attach;
2. connection refused → start the fixed Runtime composition and wait for readiness;
3. concurrent starters race to bind; one wins, losers exit before Capture allocation and attach to the winner;
4. a listener that fails identity/version/authentication → `instance-conflict`; never kill, replace or silently choose another port.

This avoids stale lockfiles and dynamic-port discovery. The automatic device-state initializer selects and persists the port before Runtime launch; users do not configure it. Port conflict recovery is an explicit future owner operation and is forbidden while a matching Runtime is live.

One Runtime process owns one exact `DeviceRef`. A single multi-device daemon is a later scope change.

### Listener separation

The control listener is not the Viewer listener. It has no Viewer assets, pairing routes, WebSocket media or browser CORS surface. The Viewer continues to use its existing ephemeral protected origin.

### Security policy

- exact IPv4 loopback bind `127.0.0.1`; no wildcard, `localhost`, IPv6 or remote address;
- independent random control credential, never a Viewer grant/cookie/bootstrap value;
- `Authorization: FSQ-Control <opaque>` on every request;
- exact Host for the configured authority;
- reject Origin, CORS preflight, `Forwarded`, `Via`, `X-Forwarded-*` and proxy-auth headers;
- canonical JSON content type, explicit Content-Length, no transfer encoding;
- at most 32 headers/8 KiB headers/16 KiB request and response bodies;
- five-second ordinary request deadline; wait uses its explicit maximum 30-second budget plus bounded transport overhead;
- no redirects, proxy environment or alternate authority;
- fixed safe response/error bodies; no raw exception or private-state evidence;
- `Cache-Control: no-store`;
- control major/minor, Contracts version, exact `DeviceRef`, instance ID, generation and features are returned only after authentication.

The threat model does not defend against a malicious process already running as the same operating-system user and able to read that user's private files. It does defend against other users when platform storage enforcement is available, browser requests, accidental local callers and credential disclosure through normal outputs.

### Response and concurrency bounds

- One Runtime admits at most 8 authenticated control connections, at most 8 ordinary in-flight requests and at most 4 concurrent waits. A client may have at most one active wait. Admission above a limit returns HTTP 429 carrying `runtime-overload`; it allocates no wait listener or unbounded queue.
- Each inspect/wait result contains at most 16 changes and at most 12 KiB of canonically encoded `changes`. The complete response remains at most 16 KiB.
- If the internal Runtime history after `afterRevision` cannot fit both caps, the provider returns only the current snapshot with `changes:[]`, `reset:true`, `timedOut:false`. It never slices an arbitrary prefix and never emits invalid JSON. A current snapshot that cannot fit the hard response cap is `runtime-overload`.
- A wait retains no per-client history. It resolves on the first observable change, timeout, terminal snapshot or cancellation, then releases its listener/timer in `finally`.
- Contract verification covers 16 KiB−1/16 KiB/16 KiB+1, 16/17 changes, 12 KiB changes, history reset, four/five waits, eight/nine connections and requests, slow clients and listener cleanup.

### Version axes

The design keeps three independent versions:

1. Contracts serialized values: currently `contractVersion: 2`;
2. external RuntimeControl protocol: proposed major 1/minor 0;
3. Viewer media: FSQV major 1, H.264 minor 0, MJPEG minor 1.

Major mismatch fails closed. Minor additions are additive only after feature negotiation, but exact validators emit the selected minor schema rather than relying on callers to ignore fields.

## 9. Zero-manual-configuration local state

`FSQ_scrcpy` has no user-authored JSON configuration and no device-config arguments containing provider locators. It automatically maintains the smallest local state needed for stable identity and start-or-attach. This is product-owned state, not a public configuration interface.

### Locations, exact state classes and first-use claim

- macOS candidate: `~/Library/Application Support/FSQ_scrcpy/`
- Windows candidate: `FOLDERID_LocalAppData/FSQ/FSQ_scrcpy/`
- persistent platform slots are exact `devices/android-only.json` and `devices/ios-only.json`;
- ephemeral Runtime state is keyed by safe `DeviceRef` under `runtime/` and is removed on normal Runtime exit.

No state is read from the repository, current working directory or arbitrary caller path. The first local threat model relies on current-account private directory semantics (macOS 0700/0600; explicit Windows ACL through the approved helper), rejects link/reparse substitution, and excludes a malicious same-account process. It does not impose APFS-only or network-home detection.

Persistent slot state owns exactly: generated safe `DeviceRef`, private binding, stable control port, long-lived 256-bit control credential, state revision and bounded timestamps. Runtime-generation state owns exactly: instanceId, generation and readiness metadata; it contains no provider locator and cannot replace persistent identity. Port/credential rotate only through the owner recovery operation below.

First-use initialization linearizes at one create-if-absent publication of the platform slot before any Runtime child is spawned. Concurrent callers may generate candidates, but only the publication winner is retained; every loser deletes/zeroes its candidate, reads and validates the winner, then attaches/races on the winner's single port. A crash before publication leaves no committed identity and spawns no child. A crash after publication but before spawn leaves reusable persistent state and no Runtime. A child may start only from committed winner state, preventing split-brain Runtime instances.

### Android automatic binding

- `selector:{kind:"auto",platform:"android"}` invokes the private Capture resolver and requires exactly one authorized Android device. Zero devices is `device-not-found`; multiple devices or a committed slot mapped to a different connected serial is `device-ambiguous`; offline/unauthorized is `device-unavailable`. No caller silently selects the first row.
- The winning slot privately stores the exact serial mapping. Later runs require the same device unless the human owner performs the explicit rebind operation. The built-in pinned scrcpy-server and fixed private cache/online artifact policy remain composition choices; offline/custom artifact input is deferred.

### iOS logical video slot

- `selector:{kind:"auto",platform:"ios"}` refers only to the current macOS account's single logical video slot at externally owned `127.0.0.1:9100`. The external owner supplies exact WDA v16.15.3 and creates/maintains the forward; `FSQ_scrcpy` does not inspect UDID or prove physical-device continuity.
- Repointing the external forward to another iPhone keeps the same logical slot and `DeviceRef`. `FSQ_scrcpy` claims neither wrong-device nor second-source detection. Physical automation/video target consistency belongs to the later `Appium_connect_agent` owner-mapping integration acceptance. Multiple simultaneous iPhone slots are a separate feature.

### Supported recovery and privacy

- Normal use is zero-manual-configuration. Persistent slot creation and Runtime state updates use bounded strict schemas, private files and atomic create/replace; users never choose ports or credentials.
- If Runtime state is missing/partial and the stable port is free, start-or-attach may discard only the uncommitted/ephemeral generation state and rebuild it from the valid persistent slot. If an authenticated matching Runtime answers, it is authoritative and state is reconstructed from its hello. An occupied port with failed auth/identity, persistent-state corruption, credential mismatch or actual Android device replacement returns `local-state-recovery-required`; no automatic deletion/remap occurs.
- The owner command-line surface includes `local-state status` and an interactive `local-state reset/rebind --platform ...`. It is forbidden through Model Context Protocol. It first proves no authenticated matching Runtime is live, displays only safe DeviceRef/platform/generation facts, requires explicit human confirmation, then atomically rotates port/credential and either preserves DeviceRef (`reset-control`) or creates a new DeviceRef/binding (`rebind-device`). Unknown live ownership remains fail closed.
- Control authority, serial and WDA locator never appear in arguments, command JSON, Model Context Protocol, Viewer URLs, logs or model-visible errors. Removing/importing/editing state files manually is unsupported.

## 10. Process lifecycle and ownership

Runtime persists after command-line or Model Context Protocol clients exit.

### Start

- the client calls the single `acquireRuntime` interface with an exact auto/known selector;
- the provider resolves an existing committed slot or atomically publishes one winner through the private Capture resolver, before spawning any child;
- it attempts authenticated attach using the winner's persistent control authority and current Runtime-generation state;
- if no matching Runtime is live and safe recovery permits start, it spawns the internal Runtime executable without provider secrets in arguments/environment;
- the child reads committed product-owned state, binds the winner's port and atomically publishes generation readiness;
- before readiness, cancellation/failure reaps only the caller's unready child and ephemeral generation state; after readiness, ownership transfers to persistent Runtime.

### Stop stream versus shutdown Runtime

`stopStream` terminalizes one stream and leaves Runtime listening. `shutdownRuntime` is a separate owner-only command requiring current instance ID and generation. Attached clients never terminate Runtime merely because they disconnect.

### Platform process Adapters

macOS may reuse owned POSIX process-group behavior only for processes that `FSQ_scrcpy` actually spawned and owns. Windows cannot model graceful termination with Node.js signal names. RuntimeControl requests application-level graceful shutdown; hard escalation for owned Windows processes belongs to the future native helper/host Adapter.

The Windows Android Capture Adapter must not kill or contain the shared global Android Debug Bridge server. Direct Android Debug Bridge client cleanup and any Windows Job Object policy require real qualification before approval.

## 11. Command-line Adapter

Proposed executable from the shared npm package:

```text
fsq-scrcpy viewer ensure (--platform <android|ios> | --device-ref <uuid>) --json
fsq-scrcpy stream inspect --stream-id <uuid> [--after-revision N] --json
fsq-scrcpy stream wait --stream-id <uuid> --after-revision N [--wait-ms N] --json
fsq-scrcpy stream watch --stream-id <uuid> [--after-revision N] --json-seq
fsq-scrcpy stream stop --stream-id <uuid> [--expected-revision N] --json
fsq-scrcpy viewer approve --stream-id <uuid> --code <8-char-code>
fsq-scrcpy local-state status|reset-control|rebind-device --platform <android|ios>
fsq-scrcpy runtime shutdown --device-ref <uuid>
```

Names are design candidates pending SPEC confirmation. `node:util.parseArgs` performs strict syntactic parsing; Contracts/RuntimeControl perform semantic validation.

Human output and JSON render the same typed result. JSON output is one complete value; watch uses JSON Text Sequences or equivalent explicitly documented framing, never ad hoc mixed logs. Diagnostics go to stderr and are safe/bounded. Exit codes map only the stable control error disposition; raw provider errors are never printed.

## 12. FSQ_scrcpy Model Context Protocol Adapter

Proposed second executable from the same npm package:

```text
fsq-scrcpy-mcp
```

The Agent Host launches it locally through standard input/standard output. Tools are candidates:

```text
fsq_viewer_ensure
fsq_stream_inspect
fsq_stream_wait
fsq_stream_stop
```

All call the same RuntimeControl client as the command-line Adapter.

`fsq_viewer_ensure` uses the same exact selector union as `acquireRuntime`: either `{kind:"auto",platform}` or `{kind:"known",deviceRef}`. No separate discovery/binding tool exists in the Model Context Protocol Adapter.

### Tool behavior

- input/output schemas are exact and versioned;
- success returns `structuredContent` built from the same provider-neutral DTO plus minimal human text;
- expected control failures return sanitized `isError:true` tool results;
- protocol/schema failures remain protocol errors;
- handler cancellation forwards `AbortSignal` to RuntimeControl;
- after Model Context Protocol cancellation the SDK sends no response and discards any late handler value. RuntimeControl still records the internal not-applied/unknown outcome, but the Agent must issue a new ensure/inspect call to reconcile it;
- Server standard output contains only Model Context Protocol messages;
- no pairing approval, Runtime shutdown or device configuration tools;
- no media content block, image, resource URI, screenshot or frame-derived result;
- no embedded Viewer in the first feature: the result returns the standalone `ViewerDescriptor`.

### Protocol era for Oh My Pi

Oh My Pi at the reviewed source snapshot sends protocol revision `2025-11-25`, which belongs to the official SDK's 2025 legacy era. `FSQ_scrcpy` therefore uses `serveStdio(factory, { legacy: "serve" })`; `legacy:"reject"` would reject the first required Host. The factory exposes the same RuntimeControl tool schemas and safe DTO semantics in both SDK eras:

- real Oh My Pi acceptance fixes the `2025-11-25` initialize/initialized lifecycle, structured tool result and cancellation behavior;
- SDK contract tests also exercise the modern `2026-07-28` discover/`_meta` era and prove tool/result/error parity;
- era-specific handshake and cancellation framing stay inside the Model Context Protocol Adapter; RuntimeControl never learns protocol era;
- this is protocol compatibility, not a support claim for untested Agent Hosts.

Evidence: Oh My Pi `packages/coding-agent/src/mcp/types.ts` fixes `MCP_PROTOCOL_VERSION = "2025-11-25"`; official SDK v2.3.1 `docs/protocol-versions.md` and `docs/serving/legacy-clients.md` define both eras and `serveStdio` legacy behavior.

## 13. Control errors and cancellation

The exact Contracts-owned `ControlError` and `ControlResult` are defined in the candidate interface in §7. Existing `StreamError` continues to describe stream behavior; adapters do not create parallel error types. `controlVersion` always uses the same `{major:1,minor:0}` object shape as `RuntimeInstance`. No raw socket/Node/Windows/Android Debug Bridge/WebDriverAgent/Appium error crosses the interface.

Provider cancellation rules:

- before child spawn: no side effect and internal `not-applied`;
- before readiness: terminate/reap only this caller's unready child;
- after readiness transfer: cancellation does not stop Runtime; outcome is reconciled by a new acquire/inspect call;
- before mutating linearization: internal `not-applied`;
- after linearization with lost response: internal `state-unknown`, reconciled by attach/inspect or retained semantic key;
- stop cannot be undone after linearization;
- wait cancellation releases only its listener/timer and has no stream side effect.

Adapter behavior is distinct:

- the command-line Adapter may render a local cancellation result if it still owns the invocation and output channel;
- the Model Context Protocol SDK sends no response after the Host cancels a call. It discards late results; the Host must make a subsequent ensure/inspect request to learn the outcome;
- Oh My Pi acceptance covers pre-linearization cancellation, post-linearization lost response and subsequent reconciliation.

## 14. Platform matrix

| Host | Device | First status in this plan | Notes |
| --- | --- | --- | --- |
| macOS arm64 | USB Android | first detailed Agent control/CLI feature | reuses current ScrcpyV501CaptureAdapter after Android real regression |
| Windows 11 x64 | USB Android | later independent platform features | requires secure host Adapters/native helper, Windows packaging and real Viewer acceptance |
| macOS arm64 | USB iPhone/WDA | later CLI platform extension | reuses completed standalone WDA feature and owner-managed WDA/forward |
| Windows | iPhone/WDA | out of scope | local WDA path requires macOS/Xcode |
| any host | remote device/Runtime | out of scope | requires remote auth/TLS/relay design |

Uniform command/tool names do not imply a support claim. Results must fail safely when the selected host/device combination has not been implemented and accepted.

## 15. Windows Android design gates

Windows is not a configuration alias for the existing macOS Capture implementation.

### Reusable behavior

- pinned scrcpy-server v5.0.1 identity and Android-side wire;
- normalized Capture events and H.264 policy;
- Android Debug Bridge reverse topology;
- artifact signature/checksum/SHA-256 verification;
- Runtime media/lifecycle/security;
- one Viewer Worker/Canvas pipeline.

### Required Windows host Adapters

Private implementation seams are required for:

- `adb.exe` plus companion DLL discovery;
- direct owned Android Debug Bridge client lifecycle without killing the shared global server;
- Windows per-user private storage, explicit ACL verification and Known Folder resolution;
- junction/reparse rejection and handle-based file identity;
- safe same-volume atomic replacement;
- Windows path/volume/filesystem policy;
- build/package selection for Node.js 24.22.1, TypeScript and esbuild;
- Chrome executable/capability discovery for acceptance only.

### Native helper direction

The user approved designing a small audited/signed Windows-native helper. Its implementation technology is not yet selected or authorized. The helper may expose only generic Windows host primitives needed by private Adapters, such as:

- current-user LocalAppData Known Folder;
- owner and effective ACL creation/verification;
- reparse-safe handle open and file identity;
- ACL-preserving replacement;
- narrowly justified owned-process primitives.

It contains no media, DeviceRef policy, Capture parsing or Model Context Protocol behavior. A later selection gate must fix source, license, build provenance, Node.js integration, Windows 11 x64 artifact signing, update/vulnerability policy and exact threat model. No mature reviewed Node.js package currently satisfies the full contract.

### Android Debug Bridge push integrity

After pushing the pinned server, the Windows Adapter executes an approved bounded device-side SHA-256 capability and requires the exact pinned digest before launch. Missing capability is `adb-incompatible`; mismatch is `artifact-mismatch`. This does not permit arbitrary device commands or change public identity.

### External prerequisites

The user installs Node.js, official Android SDK Platform-Tools, the correct Google/OEM Windows USB driver and Chrome. `FSQ_scrcpy` does not download or redistribute them and never kills the global Android Debug Bridge server.

## 16. Cross-project composition

`FSQ_scrcpy` and `Appium_connect_agent` remain independent. The Agent Host may load:

```text
FSQ_scrcpy Model Context Protocol Server only
Appium_connect_agent Model Context Protocol Server only
both Servers together
```

No aggregator Server and no internal-code import is introduced.

A later `Appium_connect_agent` requirements/design workflow must define its own command-line/Model Context Protocol Adapter, safe mapping to the shared logical identity, iOS Session support and WebDriverAgent/forward ownership. Its approved Python SDK candidate is `mcp==2.3.0`. Depending on the selected owner model, its root, Contracts, Automation and Integrations modules are always affected, while Configuration and Runtime are additionally affected when they own private mapping, WebDriverAgent/forward preparation or process lifecycle.

The moved Session-independence acceptance belongs to the future integration stage and is mandatory in both directions:

1. create external Appium Session A through `Appium_connect_agent`;
2. use `FSQ_scrcpy` to ensure Viewer and obtain a fresh Live paint;
3. end Session A and prove a post-quit fresh paint on the same FSQ stream while external source prerequisites remain healthy;
4. create Session B, prove it usable, end it while the FSQ stream remains Live and prove another post-quit fresh paint;
5. create Session C, prove it usable, stop the FSQ stream, and prove Session C remains usable;
6. end Session C and inspect both Model Context Protocol transcripts/logs for zero media, secret or provider-locator leakage;
7. repeat the complete sequence independently on Android and iOS. For iOS, the external integration owner—not `FSQ_scrcpy` alone—must attest that Appium automation and the fixed logical video slot target the intended same physical iPhone.

Passing one direction or one platform is not evidence for the other. `FSQ_scrcpy`'s iOS `DeviceRef` remains a logical video-slot identity, not a physical-device attestation.


## 17. Dependency and source evidence

### Official TypeScript Model Context Protocol SDK

- <https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/server/package.json>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/serving/stdio.md>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/servers/logging-progress-cancellation.md>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/protocol-versions.md>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/serving/legacy-clients.md>
- <https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle>
- <https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/cancellation>
- Oh My Pi fixed client evidence: `/Users/qunmi/Documents/FSQ_LAB/oh-my-pi/packages/coding-agent/src/mcp/types.ts` (`MCP_PROTOCOL_VERSION = "2025-11-25"` at the reviewed snapshot).

### Official Python Model Context Protocol SDK

- <https://pypi.org/project/mcp/2.3.0/>
- <https://github.com/modelcontextprotocol/python-sdk/releases/tag/v2.3.0>
- <https://github.com/modelcontextprotocol/python-sdk/blob/v2.3.0/pyproject.toml>

### Node.js

- `util.parseArgs`: <https://nodejs.org/docs/latest-v24.x/api/util.html#utilparseargsconfig>
- loopback HTTP/server lifecycle: <https://nodejs.org/docs/latest-v24.x/api/http.html>
- child process platform semantics: <https://nodejs.org/docs/latest-v24.x/api/child_process.html>

### Windows and Android

- Android Debug Bridge: <https://developer.android.com/tools/adb>
- Platform-Tools releases: <https://developer.android.com/tools/releases/platform-tools>
- Windows USB driver guidance: <https://developer.android.com/studio/run/win-usb>
- Windows Job Objects: <https://learn.microsoft.com/windows/win32/procthread/job-objects>
- Windows Known Folders: <https://learn.microsoft.com/windows/win32/shell/knownfolderid>
- Windows file security: <https://learn.microsoft.com/windows/win32/fileio/file-security-and-access-rights>

## 18. Feature plan

Changed-line estimates are additions plus deletions from each feature's accepted predecessor HEAD. Product, tests and docs are counted separately. Each row is one platform combination and one owning module, or an explicitly no-product-churn platform gate. Every feature requires its own SPEC gate, implementation verification and independent audit before the next dependent feature.

Before Feature 01, the existing macOS/USB Android standalone regression must pass on the current reviewed code; it is a prerequisite gate, not evidence that Agent control exists.

### `ANDROID-AUTO-BINDING-MACOS-01`

- **Platform/module:** macOS arm64 + USB Android; Capture.
- **Observable behavior:** with no user-authored config, a private Android binding resolver accepts exactly one authorized device, applies the fixed Android Debug Bridge/artifact/cache policy and returns one owner-private binding for composition; zero/multiple/different devices fail explicitly.
- **Non-goals:** public `DeviceRef`, persistent Runtime state, listener/process, CLI, wait, iOS, Windows, Model Context Protocol.
- **Dependencies:** accepted Android standalone regression; current pinned ScrcpyV501CaptureAdapter and artifact evidence.
- **SPEC impact:** root + Capture; Contracts/Runtime/Viewer no-delta.
- **Acceptance/real entry:** actual macOS USB Android with zero/one/two-device fixtures, PATH Android Debug Bridge discovery, authorized/offline states, online pinned artifact/cache reuse, no serial/path in ordinary output and no Capture open during resolve.
- **Budget/baseline:** product 220–380, tests 400–650, docs 140–220; baseline is the accepted Android-regression HEAD.

### `ANDROID-RUNTIME-CONTROL-MACOS-02`

- **Platform/module:** macOS arm64 + USB Android; Runtime.
- **Observable behavior:** RuntimeControl uses an injected owner-private binding resolver, automatically maintains stable safe `DeviceRef`/control/runtime state, and lets concurrent clients start or attach exactly one persistent authenticated Runtime and call ensure/inspect/stop.
- **Non-goals:** public CLI, wait, direct Android Debug Bridge logic, Windows, iOS, Model Context Protocol, remote, multi-device.
- **Dependencies:** Feature 01; exact automatic-state, control protocol/auth/error SPEC delta.
- **SPEC impact:** root, Contracts and Runtime; Capture interface consumption only.
- **Acceptance/real entry:** provider contract suite; concurrent fresh-install winner/loser adoption, crash before/after state publication, no orphan Runtime, same/different device identity, missing/partial Runtime state reconstruction, free/occupied/wrong-auth port, credential mismatch, bind conflict, response/connection limits, pre/post-readiness cancellation, client exit persistence and actual Android Viewer through a temporary control client.
- **Budget/baseline:** product 750–1050, tests 1000–1500, docs 240–340; baseline is Feature 01 accepted HEAD.

### `ANDROID-CLI-MACOS-03`

- **Platform/module:** macOS arm64 + USB Android; new outer Integrations module.
- **Observable behavior:** the packaged `fsq-scrcpy` command exposes automatic first-use ensure, attach, inspect, stop, human pairing approval, owner Runtime shutdown, safe local-state status and explicit reset-control/rebind-device recovery without hand-written configuration.
- **Non-goals:** wait/watch, Model Context Protocol, Windows, iOS, embedded Viewer.
- **Dependencies:** Feature 02; Node.js `parseArgs` selection.
- **SPEC impact:** root + new Integrations module; Runtime interface unchanged.
- **Acceptance/real entry:** actual executable, human/JSON parity, zero-manual first use, strict parsing, pairing, stream stop versus Runtime shutdown, safe status, proof-of-no-live-Runtime reset-control, confirmed device rebind with new DeviceRef, corrupt/ambiguous-state remediation, real Android Viewer and complete privacy audit.
- **Budget/baseline:** product 260–420, tests 450–700, docs 150–230; baseline is Feature 02 accepted HEAD.

### `ANDROID-CONTROL-WAIT-MACOS-04`

- **Platform/module:** macOS arm64 + USB Android; Runtime.
- **Observable behavior:** bounded `wait` resumes from revision without missed state, unbounded queues or cancellation side effects; a temporary control client proves provider behavior.
- **Non-goals:** command-line watch/rendering, Model Context Protocol, Windows, iOS, notifications/subscriptions.
- **Dependencies:** Features 02–03.
- **SPEC impact:** Contracts + Runtime only.
- **Acceptance/real entry:** atomic wait, timeout, reset/coalesce, 16 KiB/count boundaries, connection/wait limits, terminal completion, reconnect cursor and cancel cleanup.
- **Budget/baseline:** product 180–300, tests 400–650, docs 120–180; baseline is Feature 03 accepted HEAD.

### `ANDROID-CLI-WATCH-MACOS-04B`

- **Platform/module:** macOS arm64 + USB Android; Integrations.
- **Observable behavior:** `fsq-scrcpy stream wait/watch` maps confirmed bounded wait to one-shot JSON and resumable JSON Text Sequences without owning revision state.
- **Non-goals:** Runtime wait implementation, Model Context Protocol, Windows, iOS.
- **Dependencies:** Feature 04 and Feature 03 command-line baseline.
- **SPEC impact:** Integrations only.
- **Acceptance/real entry:** actual executable timeout/change/reset/terminal/cancel/reconnect output, cursor parity, stdout/stderr privacy and no stream side effect.
- **Budget/baseline:** product 120–220, tests 250–450, docs 80–140; baseline is Feature 04 accepted HEAD.

### `WINDOWS-RUNTIME-HOST-05`

- **Platform/module:** Windows 11 x64 + USB Android; Runtime.
- **Observable behavior:** automatic local state, persistent Runtime launch/attach and control authority satisfy the approved Windows ACL/reparse/atomic-replace contract through a selected signed helper whose low-level primitives contain no product policy.
- **Non-goals:** Capture cache, Android Debug Bridge, media, Viewer, CLI parity, Windows ARM64.
- **Dependencies:** explicit helper source/language/license/build/signing approval; Features 01–04B behavior frozen.
- **SPEC impact:** root + Runtime + dependency/packaging record.
- **Acceptance/real entry:** clean standard-user Windows machine; LocalAppData/DACL/reparse/identity/replacement, stable port conflict, persistent Runtime graceful control shutdown and owned-child hard escalation without unrelated-process impact.
- **Budget/baseline:** product 500–750, tests 650–950, docs 180–260; baseline is Feature 04B accepted HEAD. Split storage and process ownership if either observable behavior approaches the product target.

### `WINDOWS-CAPTURE-HOST-06`

- **Platform/module:** Windows 11 x64 + USB Android; Capture.
- **Observable behavior:** the existing `ScrcpyV501CaptureAdapter` uses private Windows ArtifactStore/AdbHost/binding-resolver Adapters to discover `adb.exe`/DLLs, securely cache/push/verify the pinned server, capture/rotate and clean only direct owned clients/reverse/jar without killing the global Android Debug Bridge server.
- **Non-goals:** Runtime state/process policy, Viewer, CLI, Model Context Protocol, Windows ARM64.
- **Dependencies:** Feature 05 low-level helper package only; user-installed Platform-Tools/USB driver; device-side SHA-256 capability.
- **SPEC impact:** root + Capture + dependency/selection record.
- **Acceptance/real entry:** actual Windows USB device; explicit/PATH discovery, zero/one/multiple device behavior, ACL/reparse cache, device-side hash, reverse create/list/remove, cancellation/timeouts, rotation, unplug, direct-child cleanup and global server survival.
- **Budget/baseline:** product 450–700, tests 600–900, docs 180–260; baseline is Feature 05 accepted HEAD.

### `WINDOWS-ANDROID-STANDALONE-GATE-07`

- **Platform/module:** Windows 11 x64 + USB Android; no-product-churn cross-module acceptance gate.
- **Observable behavior:** the unchanged protected Runtime/Viewer pipeline satisfies existing Android quality, lifecycle, security and cleanup in real Windows Chrome.
- **Non-goals:** new interfaces, CLI, Model Context Protocol, support-matrix entry.
- **Dependencies:** Feature 06.
- **SPEC impact:** root/Viewer acceptance platform only; any discovered product change becomes a separately scoped feature.
- **Acceptance/real entry:** real Chrome pairing→WebCodecs→Canvas, 720p/30 thresholds, First Live, rotation, five-minute ownership, grace/stop/failure cleanup, Host/Origin/auth/privacy and exact environment evidence.
- **Budget/baseline:** product 0; acceptance scripts/tests 250–450, docs 120–180; baseline is Feature 06 accepted HEAD.

### `ANDROID-CLI-WINDOWS-08`

- **Platform/module:** Windows 11 x64 + USB Android; Integrations.
- **Observable behavior:** the same packaged `fsq-scrcpy` commands expose identical automatic-first-use and control DTO/error semantics on the accepted Windows Runtime.
- **Non-goals:** Capture/security implementation, iOS, Model Context Protocol, Windows ARM64.
- **Dependencies:** Feature 07 and macOS CLI contract.
- **SPEC impact:** Integrations platform support; Runtime/Contracts no behavior delta.
- **Acceptance/real entry:** actual Windows executable/pairing/start-or-attach/inspect/wait/stop/shutdown with macOS JSON parity, path/console/secret checks and real Viewer.
- **Budget/baseline:** product 180–320, tests 350–550, docs 120–180; baseline is Feature 07 accepted HEAD.

### `IOS-AUTO-BINDING-MACOS-09`

- **Platform/module:** macOS arm64 + USB iPhone/external WDA; Capture.
- **Observable behavior:** with external WDA v16.15.3 already forwarded to fixed `127.0.0.1:9100`, one private iOS resolver returns the single owner-private logical video-slot binding without exposing endpoint/UDID/Session identity.
- **Non-goals:** physical iPhone identity attestation, second-source detection, creating/repairing WDA/forward, Runtime state, CLI, Model Context Protocol, Appium Session.
- **Dependencies:** completed iOS standalone feature, confirmed logical-slot semantics and fixed external prerequisites.
- **SPEC impact:** Capture; Contracts/Runtime no-delta.
- **Acceptance/real entry:** actual owner-managed WDA/forward, pinned grammar and fixed-slot behavior; repointing forward keeps slot identity; no provider locator output and no source open during resolve. Physical device correlation is deferred to cross-project integration.
- **Budget/baseline:** product 80–160, tests 180–320, docs 80–140; baseline is Feature 08 accepted HEAD.

### `IOS-RUNTIME-CLI-MACOS-10`

- **Platform/module:** macOS arm64 + USB iPhone/external WDA; Integrations, consuming unchanged RuntimeControl.
- **Observable behavior:** the same `fsq-scrcpy` command automatically creates/reuses the local iOS `DeviceRef` state, controls the accepted iOS Runtime and returns the existing standalone Viewer descriptor/state.
- **Non-goals:** Android changes, Model Context Protocol, WDA/forward management, embedded Viewer.
- **Dependencies:** Feature 09 and accepted macOS RuntimeControl/CLI.
- **SPEC impact:** Integrations iOS platform mapping; Runtime only if a separately confirmed state schema increment is required.
- **Acceptance/real entry:** actual command-line first use/start-or-attach/pairing/inspect/wait/stop/shutdown on real iPhone/WDA with Android JSON parity and privacy review.
- **Budget/baseline:** product 180–320, tests 350–600, docs 120–190; baseline is Feature 09 accepted HEAD.

### `MCP-ADAPTER-MACOS-ANDROID-11`

- **Platform/module:** Oh My Pi on macOS arm64 + USB Android; Integrations.
- **Observable behavior:** Oh My Pi launches `fsq-scrcpy-mcp` and obtains automatic-first-use ensure/inspect/wait/stop results equivalent to the accepted command line.
- **Non-goals:** Windows/iOS claims, pairing approval, Runtime shutdown/state maintenance, embedded Viewer, media, `Appium_connect_agent` tools.
- **Dependencies:** Feature 10 and therefore accepted Features 01–10; approved SDK lock/security/license closure; legacy `2025-11-25` and modern era tests.
- **SPEC impact:** root + Integrations; Contracts only if tool-safe DTOs require additions.
- **Acceptance/real entry:** actual Oh My Pi discovery/invocation/cancellation/reconcile, standalone Viewer opening, CLI parity, stdio lifecycle and transcript/stdout/stderr privacy on macOS Android only.
- **Budget/baseline:** product 350–600, tests 600–900, docs 200–300; baseline is Feature 10 accepted HEAD.

### `MCP-PARITY-WINDOWS-ANDROID-12`

- **Platform/module:** Oh My Pi on Windows 11 x64 + USB Android; no-product-churn Integrations parity gate.
- **Observable behavior:** the unchanged Model Context Protocol Adapter produces identical tools/results on the accepted Windows Runtime.
- **Non-goals:** new tools or Windows Capture changes.
- **Dependencies:** Features 08 and 11.
- **SPEC impact:** Integrations verified platform status only.
- **Acceptance/real entry:** actual Oh My Pi/Windows stdio, all tools/cancel/reconcile, real Viewer and privacy/cleanup; any product change becomes a new feature.
- **Budget/baseline:** product 0; tests/acceptance 180–320, docs 80–140; baseline is Feature 11 accepted HEAD.

### `MCP-PARITY-MACOS-IOS-13`

- **Platform/module:** Oh My Pi on macOS arm64 + USB iPhone/external WDA; no-product-churn Integrations parity gate.
- **Observable behavior:** the unchanged Model Context Protocol Adapter produces identical tools/results for the accepted iOS Runtime.
- **Non-goals:** embedded Viewer, Appium Session integration, WDA/forward management.
- **Dependencies:** Features 10–12.
- **SPEC impact:** Integrations verified platform status only.
- **Acceptance/real entry:** actual Oh My Pi/macOS/iPhone/WDA tools/cancel/reconcile, post-tool Viewer paint, no media/locator leakage and external resource survival.
- **Budget/baseline:** product 0; tests/acceptance 180–320, docs 80–140; baseline is Feature 12 accepted HEAD.

### Separate Appium_connect_agent design

`Appium_connect_agent` command-line/Model Context Protocol work, Python SDK integration, safe identity mapping and Session-transition acceptance require a separate `/requirements-to-design` in that repository followed by separate authorization. This document cannot authorize or define its implementation files.

## 19. Verification strategy

### Provider contract suite

The same RuntimeControl contract suite runs against an in-memory fake and the actual loopback transport. It covers:

- authenticated hello/version/features;
- concurrent start-or-attach;
- instance identity/generation and conflicts;
- ensure idempotency and response-loss reconciliation;
- inspect/wait revision ordering/reset/timeout;
- stop compare-and-set/idempotency;
- cancellation around linearization;
- process/client exit and explicit shutdown;
- bounded headers/bodies/timers/connection counts;
- no public secret/provider/media fields.

### Adapter verification

Command-line tests verify only argument/result/exit rendering. Model Context Protocol tests verify only schema, structured result, cancellation and stdio lifecycle. Neither duplicates Runtime lifecycle tests.

### Real platform acceptance

Each feature uses its published surface, not only internal tests:

- macOS Android: `fsq-scrcpy` start/attach and real Chrome Viewer; existing Android quality/rotation/lifecycle; global Android Debug Bridge server survival;
- Windows 11 x64 Android: real USB/driver/Platform-Tools/cache/reverse/Capture/Chrome/control/CLI matrix;
- macOS iOS: external WDA/forward, real Chrome Viewer and CLI parity;
- Oh My Pi: actual `fsq-scrcpy-mcp` stdio Server, all tools/cancellation/privacy;
- later cross-project: two independent Servers loaded together, Android and iOS Appium Session-transition matrix.

Simulation never creates a platform/support claim.

## 20. Expected SPEC impact

No SPEC is changed by this design workflow. Later confirmed implementation requires synchronized deltas.

### FSQ_scrcpy

- **Root SPEC:** local external control, independent command-line/Model Context Protocol product, host/platform order, no-media and process ownership.
- **Contracts SPEC:** control version, instance/attachment/error/wait values; strict safe serialization; ViewerGrant exclusion.
- **Runtime SPEC:** external provider/client, automatic local state, control HTTP security, start-or-attach, persistent lifecycle, per-device instance, idempotency, wait, cancellation and shutdown ownership.
- **Capture SPEC:** Windows host Adapters/threat model, Android Debug Bridge Windows discovery/process cleanup, device-side SHA-256 and Windows real acceptance.
- **Viewer SPEC:** Windows Android acceptance surface; standalone descriptor remains first Model Context Protocol presentation.
- **New Integrations module SPEC:** command-line and Model Context Protocol Adapter responsibilities, dependency direction and parity.

### Appium_connect_agent

A separate workflow must update its root, Contracts, Automation and Integrations SPEC for independent tools, safe logical identity mapping and Session-transition acceptance. Configuration and Runtime SPEC are also affected if the later design assigns either module private DeviceRef/binding configuration, WebDriverAgent/forward ownership or process lifecycle. No cross-repository implementation is authorized here.

## 21. Risks and stop conditions

- Windows native helper technology/source/license/signing is not selected; Windows feature is not Ready.
- Windows Android cannot reuse POSIX signal, permission or anti-symlink claims.
- A Windows listener/control success cannot substitute for real Windows Capture/Viewer acceptance.
- An automatically selected stable control port may be occupied by an unrelated process; authenticated identity mismatch never kills it and requires owner-only reset-control after proving no matching Runtime.
- Corrupt/ambiguous persistent slot state, credential mismatch or Android device replacement returns `local-state-recovery-required`; zero-manual-configuration never means silent deletion/remapping, and supported recovery is only the explicit owner command.
- Model Context Protocol SDK lock closure or security differs from approved evidence; stop for selection review.
- A Model Context Protocol result/log contains grant, locator, Session ID or media; stop as privacy failure.
- Runtime client exit changes stream/process state without explicit operation; stop as lifecycle defect.
- CLI and Model Context Protocol adapters diverge from provider DTO/error semantics; deepen the shared module instead of adding compatibility aliases.
- Windows or iOS work is not started before its preceding platform feature passes.
- Remote access, embedded Viewer, multiple devices/streams/Viewers or aggregator Server requires a new requirements/SPEC workflow.

## 22. Decision record and remaining gates

Confirmed in this workflow:

- independent `FSQ_scrcpy` and `Appium_connect_agent` tools composed by the Agent Host;
- macOS Android+iOS; Windows 11 x64 Android only;
- dedicated exact-loopback control HTTP, separate from Viewer;
- one persistent Runtime per `DeviceRef`, explicit owner shutdown;
- Agent may ensure/inspect/wait/stop stream but not approve pairing/shut down/configure;
- human command-line pairing approval;
- bounded long-poll wait;
- zero-manual-configuration with automatically managed per-user device and Runtime state;
- iOS `DeviceRef` identifies one local logical video slot at externally owned `127.0.0.1:9100`, not permanent physical iPhone identity;
- safe automatic ephemeral-state recovery plus owner-only reset-control/rebind-device for unresolved local state;
- standalone Viewer descriptor first;
- one npm package/two executables;
- Oh My Pi first Agent Host;
- official TypeScript SDK 2.3.1 and Python SDK 2.3.0 direction;
- Windows secure native-helper direction, Windows 11 x64 first;
- device-side SHA-256 after Windows Android Debug Bridge push;
- focused feature order defined above.

Still gated before implementation Ready:

- exact Windows helper technology/source/license/build/signing selection;
- exact automatic device/Runtime state schema, path, lifecycle and macOS/Windows private-storage contract during the first relevant SPEC gates;
- exact npm/Python lock closures and security/license verification;
- separate `Appium_connect_agent` requirements/design and repository authorization.

The user subsequently supplied the explicit `/spec-driven` invocation for this path. That authorizes only sequential FSQ_scrcpy SDD after every named gate; it does not authorize `Appium_connect_agent`, bypass Android regression, pre-approve a SPEC delta or approve unresolved Windows/helper dependency selections.

## Implementation evidence

Completed-feature implementation, audit and real-acceptance records are historical provenance, not active design input. Current completion and acceptance state is maintained in the owning GitHub Issues; the legacy evidence ledger remains available at [the implementation evidence ledger](../evidence/2026-10-27-agent-cli-mcp-control-implementation.md).
