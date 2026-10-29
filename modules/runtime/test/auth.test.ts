import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { revealViewerToken } from "../src/auth.js";
import { ensured, sessionFixture } from "./support/runtime-fixtures.js";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function claimed() {
  const fixture = await ensured();
  const navigation = await fixture.auth.navigate(fixture.snapshot.streamId);
  assert.ok(navigation.ok);
  if (!navigation.ok || !navigation.value.claimToken || !navigation.value.finish || !navigation.value.rollback) throw new Error("claim");
  const claim=revealViewerToken(navigation.value.claimToken);
  await navigation.value.finish();
  return { ...fixture, claim };
}

test("ensure arms one exact 30000ms permit and repeat does not slide", async () => {
  const fixture = await ensured();
  const first = fixture.descriptor;
  assert.equal(first.expiresAt, fixture.clock.wall() + 30_000);
  fixture.clock.tick(29_999);
  const repeated = await fixture.auth.ensureStandaloneViewer({ deviceRef: fixture.snapshot.deviceRef, idempotencyKey: "AAAAAAAAAAAAAAAAAAAAAA" });
  assert.ok(repeated.ok);
  if (repeated.ok) assert.equal(repeated.value.descriptor.expiresAt, first.expiresAt);
  const claim = await fixture.auth.navigate(fixture.snapshot.streamId);
  assert.ok(claim.ok);
});

test("deadline minus one delivery commits while exact deadline expires", async () => {
  const before = await ensured();
  const accepted = await before.auth.navigate(before.snapshot.streamId);
  assert.ok(accepted.ok);
  if (!accepted.ok || !accepted.value.finish) return;
  before.clock.advanceWithoutTimers(29_999);
  await accepted.value.finish();
  assert.ok((await before.auth.navigate(before.snapshot.streamId, accepted.value.claimToken&&revealViewerToken(accepted.value.claimToken))).ok);

  const exact = await ensured();
  const expired = await exact.auth.navigate(exact.snapshot.streamId);
  assert.ok(expired.ok);
  if (!expired.ok || !expired.value.finish) return;
  exact.clock.advanceWithoutTimers(30_000);
  await expired.value.finish();
  assert.equal((await exact.auth.createSession(exact.snapshot.streamId, revealViewerToken(expired.value.claimToken!))).ok, false);
});

test("first claimant wins and same claimant reload is idempotent", async () => {
  const fixture = await ensured();
  const first = await fixture.auth.navigate(fixture.snapshot.streamId);
  const second = await fixture.auth.navigate(fixture.snapshot.streamId);
  assert.ok(first.ok);
  assert.equal(second.ok ? "" : second.kind, "conflict");
  if (!first.ok || !first.value.finish || !first.value.claimToken) return;
  await first.value.finish();
  const reload = await fixture.auth.navigate(fixture.snapshot.streamId, revealViewerToken(first.value.claimToken));
  assert.ok(reload.ok);
  if (reload.ok) assert.equal(reload.value.claimToken, undefined);
});

test("claim delivery rollback restores armed permit and fences late finish", async () => {
  const fixture = await ensured();
  const first = await fixture.auth.navigate(fixture.snapshot.streamId);
  assert.ok(first.ok);
  if (!first.ok || !first.value.rollback || !first.value.finish) return;
  await first.value.rollback();
  const replacement = await fixture.auth.navigate(fixture.snapshot.streamId, first.value.claimToken&&revealViewerToken(first.value.claimToken));
  assert.ok(replacement.ok);
  await first.value.finish();
  assert.equal((await fixture.auth.createSession(fixture.snapshot.streamId, revealViewerToken(first.value.claimToken!))).ok, false);
});

test("session delivery rollback invalidates provisional media and permits claimant retry", async () => {
  const fixture = await claimed();
  const first = await fixture.auth.createSession(fixture.snapshot.streamId, fixture.claim);
  assert.ok(first.ok);
  if (!first.ok) return;
  const provisional=revealViewerToken(first.value.mediaToken);
  await first.value.rollback();
  assert.equal((await fixture.auth.validateUpgrade(provisional)).ok, false);
  const retry = await fixture.auth.createSession(fixture.snapshot.streamId, fixture.claim, provisional);
  assert.ok(retry.ok);
});

test("committed response loss retries same session identity without second viewer", async () => {
  const fixture = await claimed();
  const first = await fixture.auth.createSession(fixture.snapshot.streamId, fixture.claim);
  assert.ok(first.ok);
  if (!first.ok) return;
  const media=revealViewerToken(first.value.mediaToken);
  await first.value.finish();
  const retry = await fixture.auth.createSession(fixture.snapshot.streamId, fixture.claim, media);
  assert.ok(retry.ok);
  if (!retry.ok) return;
  assert.equal(revealViewerToken(retry.value.mediaToken), media);
  const upgrade = await fixture.auth.validateUpgrade(media);
  assert.ok(upgrade.ok);
  if (!upgrade.ok) return;
  assert.ok((await fixture.auth.connect(upgrade.value)).ok);
  assert.equal((await fixture.auth.validateUpgrade(media)).ok ? "" : "limit", "limit");
});

test("first WebSocket consumes claim while media reload remains authorized", async () => {
  const fixture = await sessionFixture();
  const upgrade = await fixture.auth.validateUpgrade(fixture.token);
  assert.ok(upgrade.ok);
  if (!upgrade.ok) return;
  assert.ok((await fixture.auth.connect(upgrade.value)).ok);
  assert.equal((await fixture.auth.navigate(fixture.snapshot.streamId, fixture.claimToken)).ok, false);
  const reload = await fixture.auth.navigate(fixture.snapshot.streamId, fixture.claimToken, fixture.token);
  assert.ok(reload.ok);
  if (reload.ok) assert.equal(reload.value.clearClaim, true);
});

test("refresh rotates media proof without visible demand renewal", async () => {
  const fixture = await sessionFixture();
  const rotated = await fixture.auth.refresh(fixture.token);
  assert.ok(rotated.ok);
  assert.equal((await fixture.auth.refresh(fixture.token)).ok, false);
  assert.equal(fixture.auth.hasVisibleDemand(fixture.snapshot.streamId), false);
  fixture.clock.jumpWall(86_400_000);
  if (rotated.ok) assert.ok((await fixture.auth.refresh(revealViewerToken(rotated.value))).ok);
});

test("disconnect enters grace, same session reconnects, and exact grace expiry terminalizes", async () => {
  const fixture = await sessionFixture();
  const upgrade = await fixture.auth.validateUpgrade(fixture.token);
  assert.ok(upgrade.ok);
  if (!upgrade.ok) return;
  assert.ok((await fixture.auth.connect(upgrade.value)).ok);
  await fixture.auth.disconnect();
  const reconnect = await fixture.auth.validateUpgrade(fixture.token);
  assert.ok(reconnect.ok);
  fixture.clock.tick(4_999);
  await flush();
  const grace = fixture.auth.inspect({ streamId: fixture.snapshot.streamId });
  assert.ok(grace.ok && grace.value.snapshot.phase === "grace");
  fixture.clock.tick(1);
  await flush();
  const terminal = fixture.auth.inspect({ streamId: fixture.snapshot.streamId });
  assert.ok(terminal.ok && terminal.value.snapshot.reason === "lease-expired");
});

test("DELETE before connect vacates without grace; after connect enters grace", async () => {
  const before = await sessionFixture();
  assert.ok((await before.auth.deleteSession(before.claimToken, before.token)).ok);
  const snapshot = before.auth.inspect({ streamId: before.snapshot.streamId });
  assert.ok(snapshot.ok && snapshot.value.snapshot.phase === "demand-pending");
  const rearmed = await before.auth.ensureStandaloneViewer({ deviceRef: before.snapshot.deviceRef, idempotencyKey: "AAAAAAAAAAAAAAAAAAAAAA" });
  assert.ok(rearmed.ok);

  const after = await sessionFixture();
  const upgrade = await after.auth.validateUpgrade(after.token);
  assert.ok(upgrade.ok);
  if (!upgrade.ok) return;
  assert.ok((await after.auth.connect(upgrade.value)).ok);
  assert.ok((await after.auth.deleteSession(after.claimToken, after.token)).ok);
  const grace = after.auth.inspect({ streamId: after.snapshot.streamId });
  assert.ok(grace.ok && grace.value.snapshot.phase === "grace");
  assert.equal((await after.auth.validateUpgrade(after.token)).ok, false);
  assert.equal((await after.auth.resumeVisible(upgrade.value.sessionId)).ok, false);
});

test("terminal revokes every claim/session proof and late callbacks are inert", async () => {
  const fixture = await claimed();
  const pending = await fixture.auth.createSession(fixture.snapshot.streamId, fixture.claim);
  assert.ok(pending.ok);
  if (!pending.ok) return;
  assert.ok((await fixture.auth.stop({ streamId: fixture.snapshot.streamId, reason: "explicit-stop" })).ok);
  await pending.value.finish();
  assert.equal((await fixture.auth.validateUpgrade(revealViewerToken(pending.value.mediaToken))).ok, false);
  assert.equal((await fixture.auth.navigate(fixture.snapshot.streamId, fixture.claim)).ok, false);
});

test("stale generation descriptors cannot connect after session rotation", async () => {
  const fixture = await sessionFixture();
  const stale = await fixture.auth.validateUpgrade(fixture.token);
  assert.ok(stale.ok);
  if (!stale.ok) return;
  const rotated = await fixture.auth.refresh(fixture.token);
  assert.ok(rotated.ok);
  assert.equal((await fixture.auth.connect(stale.value)).ok, false);
});

test("cookie handoff wrappers redact every ordinary reflection path",async()=>{
  const f=await ensured(),navigation=await f.auth.navigate(f.snapshot.streamId);assert.ok(navigation.ok);if(!navigation.ok||!navigation.value.claimToken||!navigation.value.finish)return;
  const claim=revealViewerToken(navigation.value.claimToken);assert.deepEqual(Object.keys(navigation.value.claimToken),[]);assert.deepEqual(Reflect.ownKeys(navigation.value.claimToken),[]);assert.equal(JSON.stringify(navigation.value).includes(claim),false);assert.equal(String(navigation.value.claimToken),"[REDACTED]");assert.equal(inspect(navigation.value.claimToken),"[REDACTED]");
  await navigation.value.finish();const session=await f.auth.createSession(f.snapshot.streamId,claim);assert.ok(session.ok);if(!session.ok)return;const media=revealViewerToken(session.value.mediaToken);assert.deepEqual(Object.keys(session.value.mediaToken),[]);assert.deepEqual(Reflect.ownKeys(session.value.mediaToken),[]);assert.equal(JSON.stringify(session.value).includes(media),false);assert.equal(String(session.value.mediaToken),"[REDACTED]");assert.equal(inspect(session.value.mediaToken),"[REDACTED]");
});

test("committed valid-media retry survives permit expiry but retry delivery cannot cross it",async()=>{
  const committed=await sessionFixture();committed.clock.advanceWithoutTimers(30_000);const idempotent=await committed.auth.createSession(committed.snapshot.streamId,committed.claimToken,committed.token);assert.ok(idempotent.ok);if(idempotent.ok)assert.equal(revealViewerToken(idempotent.value.mediaToken),committed.token);
  const before=await sessionFixture();before.clock.advanceWithoutTimers(29_999);const delivery=await before.auth.createSession(before.snapshot.streamId,before.claimToken,"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");assert.ok(delivery.ok);if(!delivery.ok)return;await delivery.value.finish();assert.ok((await before.auth.validateUpgrade(revealViewerToken(delivery.value.mediaToken))).ok);
  const exact=await sessionFixture();exact.clock.advanceWithoutTimers(29_999);const late=await exact.auth.createSession(exact.snapshot.streamId,exact.claimToken,"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");assert.ok(late.ok);if(!late.ok)return;exact.clock.advanceWithoutTimers(1);await late.value.finish();assert.equal((await exact.auth.validateUpgrade(revealViewerToken(late.value.mediaToken))).ok,false);await late.value.rollback();assert.equal((await exact.auth.validateUpgrade(exact.token)).ok,false);
});
