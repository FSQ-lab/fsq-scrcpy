import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createMessage, generateKey, sign, type PrivateKey } from "openpgp";
import { ArtifactError, artifactInternals, rehashArtifact, type ArtifactIdentity, type ArtifactSource } from "../src/artifact/index.js";
type OfflineSource = Extract<ArtifactSource, { mode: "offline" }>;

const encoder = new TextEncoder();
const server = encoder.encode("fixture-server-bytes");
const digest = createHash("sha256").update(server).digest("hex");
const pair = await generateKey({ type: "curve25519", userIDs: [{ name: "Fixture" }], subkeys: [{ type: "curve25519", sign: true }], format: "object" });
const otherPair = await generateKey({ type: "curve25519", userIDs: [{ name: "Other" }], subkeys: [{ type: "curve25519", sign: true }], format: "object" });
const signing = await pair.publicKey.getSigningKey();
const identity: ArtifactIdentity = Object.freeze({ protocol: 1, version: "test", commit: "0123456789012345678901234567890123456789", assetName: "server-test", assetUrl: "https://github.com/test/server-test", keyUrl: "https://blog.rom1v.com/test.asc", checksumUrl: "https://github.com/test/SHA256SUMS.txt", signatureUrl: "https://github.com/test/SHA256SUMS.txt.asc", size: server.length, sha256: digest, primaryFingerprint: pair.publicKey.getFingerprint().toUpperCase(), signingFingerprint: signing.getFingerprint().toUpperCase() });

async function signed(text: string, privateKey: PrivateKey = pair.privateKey): Promise<Uint8Array> { return await sign({ message: await createMessage({ binary: encoder.encode(text) }), signingKeys: privateKey, detached: true, format: "binary" }); }
async function material(text = `${digest}  server-test\n`): Promise<{ key: Uint8Array; sums: Uint8Array; signature: Uint8Array }> { const sums = encoder.encode(text); return { key: encoder.encode(pair.publicKey.armor()), sums, signature: await signed(text) }; }
async function failure(run: () => Promise<unknown>, code = "artifact-mismatch"): Promise<void> { await assert.rejects(run, (error: unknown) => error instanceof ArtifactError && error.code === code && !error.message.includes("/")); }
async function fixture(root: string, serverBytes = server): Promise<OfflineSource> { const data = await material(); const paths = { keyFile: join(root, "key"), checksumFile: join(root, "sums"), signatureFile: join(root, "sig"), serverFile: join(root, "server") }; await Promise.all([writeFile(paths.keyFile, data.key), writeFile(paths.checksumFile, data.sums), writeFile(paths.signatureFile, data.signature), writeFile(paths.serverFile, serverBytes)]); return { mode: "offline", ...paths }; }
async function temp(): Promise<string> { return await mkdtemp(join(await realpath(tmpdir()), "fsq-artifact-")); }
async function trusted(root: string, name = "cache"): Promise<string> { const path = join(root, name); await mkdir(path, { mode: 0o700 }); await chmod(path, 0o700); return path; }
class FakeResponse extends EventEmitter { statusCode = 200; headers: { location?: string; "content-length"?: string } = {}; resumed = false; destroyed = false; idle?: () => void; resume(): void { this.resumed = true; } destroy(error?: Error): void { this.destroyed = true; queueMicrotask(() => this.emit("error", error ?? new Error("destroyed"))); } setTimeout(_ms: number, callback: () => void): void { this.idle = callback; } }
class FakeRequest extends EventEmitter { destroyed = false; destroy(error?: Error): void { this.destroyed = true; queueMicrotask(() => this.emit("error", error ?? new Error("destroyed"))); } }
function fakeNetwork(kind: "connect" | "idle" | "total" | "redirect" | "escape") {
  const requests: FakeRequest[] = [], responses: FakeResponse[] = []; let cleared = 0;
  const hooks = { now: () => 0, clearTimer: () => { cleared++; }, setTimer: (_ms: number, callback: () => void) => { if (kind === "total") queueMicrotask(callback); return {}; }, request: (_url: URL, callback: (response: FakeResponse) => void) => { const request = new FakeRequest(); requests.push(request); queueMicrotask(() => { if (kind === "connect") { const socket = { setTimeout: (_ms: number, timeout?: () => void) => queueMicrotask(() => timeout?.()), once: () => undefined, destroy: (error?: Error) => request.destroy(error) }; request.emit("socket", socket); return; } const response = new FakeResponse(); responses.push(response); if (kind === "redirect" || kind === "escape") { response.statusCode = 302; response.headers.location = kind === "escape" ? "https://example.com/no" : "https://github.com/again"; } callback(response); if (kind === "idle") queueMicrotask(() => response.idle?.()); }); return request; } };
  return { hooks: hooks as unknown as NonNullable<Parameters<typeof artifactInternals.fetchBytes>[5]>, requests, responses, cleared: () => cleared };
}

await test("verifies exact detached material and pins both signer fingerprints", async () => {
  const good = await material(); await artifactInternals.verifyManifest(identity, good.key, good.sums, good.signature);
  await failure(() => artifactInternals.verifyManifest(identity, encoder.encode(otherPair.publicKey.armor()), good.sums, good.signature));
  await failure(() => artifactInternals.verifyManifest({ ...identity, primaryFingerprint: otherPair.publicKey.getFingerprint().toUpperCase() }, good.key, good.sums, good.signature));
  await failure(() => artifactInternals.verifyManifest({ ...identity, signingFingerprint: otherPair.publicKey.getSubkeys()[0]!.getFingerprint().toUpperCase() }, good.key, good.sums, good.signature));
  const wrongSignature = await signed(new TextDecoder().decode(good.sums), otherPair.privateKey); await failure(() => artifactInternals.verifyManifest(identity, good.key, good.sums, wrongSignature));
  const damaged = good.signature.slice(), at = damaged.length - 2; damaged[at] = (damaged[at] ?? 0) ^ 1; await failure(() => artifactInternals.verifyManifest(identity, good.key, good.sums, damaged));
});

await test("signature covers exact checksum bytes including newline", async () => {
  const good = await material(); await failure(() => artifactInternals.verifyManifest(identity, good.key, encoder.encode(`${digest}  server-test`), good.signature));
  await failure(() => artifactInternals.verifyManifest(identity, good.key, encoder.encode(`${digest}  server-test\n\n`), good.signature));
});

await test("requires one exact asset line and its pinned digest", async () => {
  for (const text of [
    `${digest}  another\n`,
    `${digest}  server-test\n${digest}  server-test\n`,
    `${digest}  ./server-test\n`,
    `${digest} *server-test\n`,
    `${"0".repeat(64)}  server-test\n`
  ]) { const data = await material(text); await failure(() => artifactInternals.verifyManifest(identity, data.key, data.sums, data.signature)); }
});

await test("rejects malformed and oversized OpenPGP packets before parsing", async () => {
  const good = await material(); await failure(() => artifactInternals.verifyManifest(identity, new Uint8Array(artifactInternals.limits.key + 1), good.sums, good.signature));
  await failure(() => artifactInternals.verifyManifest(identity, good.key, good.sums, encoder.encode("not a signature")));
  await failure(() => artifactInternals.verifyManifest(identity, good.key, good.sums, new Uint8Array(artifactInternals.limits.signature + 1)));
  await failure(() => artifactInternals.verifyManifest(identity, good.key, new Uint8Array(artifactInternals.limits.checksums + 1), good.signature));
});

await test("freezes HTTPS host, redirect and timeout policy", () => {
  assert.equal(artifactInternals.checkUrl("https://github.com/a").hostname, "github.com");
  for (const url of ["http://github.com/a", "https://example.com/a", "https://user@github.com/a"]) assert.throws(() => artifactInternals.checkUrl(url), ArtifactError);
  const from = new URL("https://github.com/a"); assert.equal(artifactInternals.redirectUrl(from, "https://release-assets.githubusercontent.com/b", 2).hostname, "release-assets.githubusercontent.com");
  assert.throws(() => artifactInternals.redirectUrl(from, "https://example.com/b", 0), ArtifactError); assert.throws(() => artifactInternals.redirectUrl(from, "/b", 3), ArtifactError);
  assert.deepEqual(artifactInternals.timeouts, { connect: 10_000, idle: 10_000, total: 60_000, redirects: 3, lock: 30_000 });
});
await test("deterministically enforces connect, idle, total, and redirect failures", async () => {
  for (const kind of ["connect", "idle", "total", "redirect", "escape"] as const) { const fake = fakeNetwork(kind); await failure(() => artifactInternals.fetchBytes("https://github.com/a", 10, undefined, 0, undefined, fake.hooks), "artifact-unavailable"); assert.ok(fake.cleared() > 0); if (kind === "connect" || kind === "total") assert.equal(fake.requests[0]?.destroyed, true); if (kind === "idle") assert.equal(fake.responses[0]?.destroyed, true); if (kind === "redirect") { assert.equal(fake.requests.length, 4); assert.ok(fake.responses.every((value) => value.resumed)); } if (kind === "escape") assert.equal(fake.requests.length, 1); }
});

await test("rejects exotic source schemas and accepts a null-prototype exact source", async (context) => {
  const root = await temp(); context.after(() => rm(root, { recursive: true, force: true })); const good = await fixture(root), getter = {}; Object.defineProperty(getter, "mode", { enumerable: true, get: () => { throw new Error("getter ran"); } }); const hidden = {}; Object.defineProperty(hidden, "mode", { value: "online", enumerable: false });
  const invalid: unknown[] = [Object.create({ mode: "online" }), hidden, { mode: "online", keyFile: good.keyFile }, { mode: "online", [Symbol("x")]: true }, getter];
  for (const [index, source] of invalid.entries()) { const cache = join(root, `invalid-${index}`); await failure(() => artifactInternals.acquire(identity, cache, source), "artifact-unavailable"); await assert.rejects(() => lstat(cache)); }
  const nullSource = Object.assign(Object.create(null) as OfflineSource, good), cache = await trusted(root, "null-source"); await artifactInternals.acquire(identity, cache, nullSource);
});

await test("enforces the euid-owned real-0700 trusted-root and ancestor policy", async (context) => {
  const root = await temp(); context.after(() => rm(root, { recursive: true, force: true })); const source = await fixture(root), good = await trusted(root, "good"); await artifactInternals.acquire(identity, good, source);
  const loose = await trusted(root, "loose"); await chmod(loose, 0o750); await failure(() => artifactInternals.acquire(identity, loose, source), "artifact-unavailable");
  const writableParent = join(root, "writable"); await mkdir(writableParent, { mode: 0o700 }); await chmod(writableParent, 0o777); const nested = await trusted(writableParent, "nested"); await failure(() => artifactInternals.acquire(identity, nested, source), "artifact-unavailable");
  const realParent = join(root, "real-parent"); await mkdir(realParent, { mode: 0o700 }); const realCache = await trusted(realParent, "nested"), alias = join(root, "alias"); await symlink(realParent, alias); await failure(() => artifactInternals.acquire(identity, join(alias, "nested"), source), "artifact-unavailable"); assert.equal((await lstat(realCache)).isDirectory(), true);
  const linkedRoot = join(root, "linked-root"); await symlink(good, linkedRoot); await failure(() => artifactInternals.acquire(identity, linkedRoot, source), "artifact-unavailable");
  const stickyBase = await mkdtemp(join(await realpath("/tmp"), "fsq-artifact-sticky-")); context.after(() => rm(stickyBase, { recursive: true, force: true })); await artifactInternals.acquire(identity, await trusted(stickyBase), source);
});

await test("maps path-bearing I/O safely and preserves first failure over cleanup", async (context) => {
  const root = await temp(); context.after(() => rm(root, { recursive: true, force: true })); const good = await fixture(root); await failure(() => artifactInternals.acquire(identity, "/dev/null/private/path", good), "artifact-unavailable");
  const badRoot = join(root, "bad"); await mkdir(badRoot); const bad = await fixture(badRoot, encoder.encode("tampered-server-byte")), cache = await trusted(root, "cleanup-cache"); await failure(() => artifactInternals.acquire(identity, cache, bad, { beforeRelease: async (_directory, failed) => { assert.equal(failed, true); throw new Error("cleanup path detail"); } }));
});

await test("admits offline material atomically into a private rehashable cache", async (context) => {
  const root = await temp(); context.after(() => rm(root, { recursive: true, force: true })); const source = await fixture(root), cache = await trusted(root);
  const artifact = await artifactInternals.acquire(identity, cache, source); assert.equal((await readFile(artifact.path)).toString(), Buffer.from(server).toString()); await rehashArtifact(artifact);
  assert.equal((await lstat(cache)).mode & 0o777, 0o700); assert.equal((await lstat(artifact.path)).mode & 0o777, 0o600); assert.equal((await lstat(join(artifact.path, "..", "metadata.json"))).mode & 0o777, 0o600);
  assert.equal(artifact.metadata.license, "Apache-2.0"); assert.match(artifact.metadata.openPgpBoundary, /LGPL-3\.0\+/); assert.deepEqual((await readdir(join(artifact.path, ".."))).filter((name) => name.includes(".tmp-")), []);
});
await test("normalizes private modes despite a restrictive process umask", async (context) => {
  const root = await temp(); context.after(() => rm(root, { recursive: true, force: true })); const source = await fixture(root), cache = await trusted(root); const previous = process.umask(0o777); let artifact: Awaited<ReturnType<typeof artifactInternals.acquire>> | undefined;
  try { artifact = await artifactInternals.acquire(identity, cache, source, { beforeRelease: async (directory) => { assert.equal((await lstat(directory)).mode & 0o777, 0o700); assert.equal((await lstat(join(directory, ".lock"))).mode & 0o777, 0o600); assert.equal((await lstat(join(directory, identity.assetName))).mode & 0o777, 0o600); assert.equal((await lstat(join(directory, "metadata.json"))).mode & 0o777, 0o600); } }); } finally { process.umask(previous); }
  assert.ok(artifact); assert.equal((await lstat(artifact.path)).mode & 0o777, 0o600);
});


await test("classifies offline absence as unavailable and stable symlinks as mismatch", async (context) => {
  const root = await temp(); context.after(() => rm(root, { recursive: true, force: true })); const cache = await trusted(root), short = await fixture(root, server.slice(1)); await failure(() => artifactInternals.acquire(identity, cache, short));
  await writeFile(short.serverFile, encoder.encode("tampered-server-byte")); await failure(() => artifactInternals.acquire(identity, cache, short));
  await writeFile(short.serverFile, server); await rm(short.keyFile); await failure(() => artifactInternals.acquire(identity, cache, short), "artifact-unavailable"); await symlink(join(root, "missing"), short.keyFile); await failure(() => artifactInternals.acquire(identity, cache, short));
  await failure(() => artifactInternals.acquire(identity, cache, { mode: "offline", keyFile: short.keyFile } as ArtifactSource), "artifact-unavailable");
});

await test("stable cache tamper fails its call, then a later acquire rebuilds", async (context) => {
  const root = await temp(); context.after(() => rm(root, { recursive: true, force: true })); const source = await fixture(root), cache = await trusted(root); const [first, second] = await Promise.all([artifactInternals.acquire(identity, cache, source), artifactInternals.acquire(identity, cache, source)]); assert.equal(first.path, second.path);
  await writeFile(first.path, encoder.encode("tampered-server-byte")); await failure(() => rehashArtifact(first)); await failure(() => artifactInternals.acquire(identity, cache, source)); let repaired = await artifactInternals.acquire(identity, cache, source); await rehashArtifact(repaired);
  const exact = await readFile(repaired.path); await rm(repaired.path); await writeFile(repaired.path, exact, { mode: 0o600 }); await chmod(repaired.path, 0o600); await failure(() => rehashArtifact(repaired)); await failure(() => artifactInternals.acquire(identity, cache, source)); repaired = await artifactInternals.acquire(identity, cache, source);
  const metadataPath = join(repaired.path, "..", "metadata.json"); for (const verifiedAt of [0, "2026-01-01T00:00:00Z", "2026-99-99T99:99:99.999Z", "invalid-json"]) { if (verifiedAt === "invalid-json") await writeFile(metadataPath, "{"); else { const changed = JSON.parse(await readFile(metadataPath, "utf8")) as { metadata: Record<string, unknown> }; changed.metadata.verifiedAt = verifiedAt; await writeFile(metadataPath, JSON.stringify(changed)); } await failure(() => artifactInternals.acquire(identity, cache, source)); repaired = await artifactInternals.acquire(identity, cache, source); }
  await rm(repaired.path); await mkdir(repaired.path); await failure(() => artifactInternals.acquire(identity, cache, source)); repaired = await artifactInternals.acquire(identity, cache, source);
  await rm(repaired.path); await symlink(source.serverFile, repaired.path); await failure(() => artifactInternals.acquire(identity, cache, source)); repaired = await artifactInternals.acquire(identity, cache, source); assert.equal((await lstat(repaired.path)).isSymbolicLink(), false);
  await rm(repaired.path); await failure(() => artifactInternals.acquire(identity, cache, source), "artifact-unavailable"); await rm(metadataPath); repaired = await artifactInternals.acquire(identity, cache, source); await rehashArtifact(repaired);
  const identityDir = join(repaired.path, ".."); await rm(identityDir, { recursive: true }); const attacker = join(root, "attacker"); await mkdir(attacker); await symlink(attacker, identityDir); await failure(() => artifactInternals.acquire(identity, cache, source)); repaired = await artifactInternals.acquire(identity, cache, source); await rehashArtifact(repaired);
  assert.deepEqual((await readdir(join(repaired.path, ".."))).filter((name) => name === ".lock" || name.includes(".tmp-")), []);
});

await test("cancels network requests and private-lock waits without residue", async (context) => {
  const network = fakeNetwork("idle"), networkAbort = new AbortController(), pendingFetch = artifactInternals.fetchBytes(identity.assetUrl, 64, undefined, 0, undefined, network.hooks, networkAbort.signal); await Promise.resolve(); networkAbort.abort(); await failure(() => pendingFetch, "artifact-unavailable"); assert.equal(network.requests[0]?.destroyed, true);
  const root = await temp(); context.after(() => rm(root, { recursive: true, force: true })); const source = await fixture(root), cache = await trusted(root); let unblock!: () => void, locked!: () => void; const held = new Promise<void>((done) => { unblock = done; }), acquired = new Promise<void>((done) => { locked = done; }), first = artifactInternals.acquire(identity, cache, source, { beforeRelease: async () => { locked(); await held; } }); await acquired; const lockAbort = new AbortController(), waiting = artifactInternals.acquire(identity, cache, source, undefined, lockAbort.signal); lockAbort.abort(); await failure(() => waiting, "artifact-unavailable"); unblock(); await first; assert.deepEqual((await readdir(join(cache, `${identity.protocol}-${identity.version}-${identity.sha256}`))).filter((name) => name === ".lock" || name.includes(".tmp-")), []);
});

await test("rolls back aborts immediately after lock creation and between cache publications", async (context) => {
  const root = await temp(); context.after(() => rm(root, { recursive: true, force: true })); const source = await fixture(root), cache = await trusted(root), directory = join(cache, `${identity.protocol}-${identity.version}-${identity.sha256}`), lockAbort = new AbortController(); await failure(() => artifactInternals.acquire(identity, cache, source, { afterLockCreate: () => lockAbort.abort() }, lockAbort.signal), "artifact-unavailable"); assert.deepEqual(await readdir(directory), []);
  const publishAbort = new AbortController(); await failure(() => artifactInternals.acquire(identity, cache, source, { afterArtifactPublish: () => publishAbort.abort() }, publishAbort.signal), "artifact-unavailable"); assert.deepEqual(await readdir(directory), []); const rebuilt = await artifactInternals.acquire(identity, cache, source); await rehashArtifact(rebuilt); let existingHook = false; const existing = await artifactInternals.acquire(identity, cache, source, { afterArtifactPublish: () => { existingHook = true; throw new Error("must not publish"); } }); assert.equal(existing.path, rebuilt.path); assert.equal(existingHook, false); assert.deepEqual((await readdir(directory)).sort(), ["metadata.json", identity.assetName].sort());
});
