import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { WebSocket } from "ws";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-api-test-"));
process.env["DATA_DIR"] = testDataDir;

const { createApiRouter } = await import("./api");
const { db } = await import("./db");
const { attachWebSocketServer } = await import("./ws");

let server: http.Server;
let baseUrl = "";
let wsBaseUrl = "";

test.before(async () => {
  const app = express();
  app.use("/api", createApiRouter());
  server = http.createServer(app);
  attachWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
  wsBaseUrl = `ws://127.0.0.1:${addr.port}/ws`;
});

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function api<T>(
  pathname: string,
  opts: { method?: string; body?: unknown; token?: string | null } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(`${baseUrl}${pathname}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  return { status: resp.status, data };
}

test("Account registration, duplicate prevention, session persistence, discovery privacy, follow & Instagram DM lifecycle", async () => {
  // 1. Register User A
  const regA = await api<{ token: string; user: Record<string, unknown> }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Alice Reader",
      username: "alice_reader",
      email: "Alice@Example.com",
      password: "Password123!",
      bio: "Sci-fi and poetry enthusiast",
    },
  });
  assert.equal(regA.status, 201);
  assert.ok(regA.data.token);
  assert.equal(regA.data.user["email"], "alice@example.com");
  assert.equal(regA.data.user["displayHandle"], "@alice_reader");
  assert.equal(regA.data.user["password_hash"], undefined);

  // 2. Duplicate email must fail (case-insensitive)
  const dupEmail = await api("/auth/register", {
    method: "POST",
    body: {
      fullName: "Another Alice",
      username: "alice_two",
      email: "ALICE@example.com",
      password: "Password123!",
    },
  });
  assert.equal(dupEmail.status, 409);

  // 3. Session restore via /auth/me works
  const meA = await api<{ user: Record<string, unknown> }>("/auth/me", {
    token: regA.data.token,
  });
  assert.equal(meA.status, 200);
  assert.equal(meA.data.user["id"], regA.data.user["id"]);

  // 4. Logout & re-login via email and via username
  await api("/auth/logout", { method: "POST", token: regA.data.token });
  const afterLogout = await api("/auth/me", { token: regA.data.token });
  assert.equal(afterLogout.status, 401);

  const loginEmail = await api<{ token: string; user: Record<string, unknown> }>("/auth/login", {
    method: "POST",
    body: { identifier: "alice@example.com", password: "Password123!" },
  });
  assert.equal(loginEmail.status, 200);
  const tokenA = loginEmail.data.token;

  const loginUsername = await api<{ token: string }>("/auth/login", {
    method: "POST",
    body: { identifier: "@alice_reader", password: "Password123!" },
  });
  assert.equal(loginUsername.status, 200);

  // 5. Register User B
  const regB = await api<{ token: string; user: Record<string, unknown> }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Bob Writer",
      username: "bob_writer",
      email: "bob.private@example.com",
      password: "BobPassword123!",
      phone: "9876543210",
      countryCode: "+91",
    },
  });
  assert.equal(regB.status, 201);
  const tokenB = regB.data.token;
  const userBId = String(regB.data.user["id"]);
  const userAId = String(regA.data.user["id"]);

  // 6. User Discovery returns User B WITHOUT leaking private info
  const discoverRes = await api<{ users: Record<string, unknown>[] }>("/users?q=bob", {
    token: tokenA,
  });
  assert.equal(discoverRes.status, 200);
  assert.equal(discoverRes.data.users.length, 1);
  const publicBob = discoverRes.data.users[0]!;
  assert.equal(publicBob["id"], userBId);
  assert.equal(publicBob["displayHandle"], "@bob_writer");
  assert.equal(publicBob["email"], undefined);
  assert.equal(publicBob["phoneE164"], undefined);
  assert.equal(publicBob["phoneMasked"], undefined);
  assert.equal(publicBob["password_hash"], undefined);

  // 7. Follow / Unfollow updates followerCount & followingCount
  const followRes = await api<{
    isFollowing: boolean;
    followerCount: number;
    myFollowingCount: number;
  }>(`/users/${userBId}/follow`, { method: "POST", token: tokenA });
  assert.equal(followRes.status, 200);
  assert.equal(followRes.data.isFollowing, true);
  assert.equal(followRes.data.followerCount, 1);
  assert.equal(followRes.data.myFollowingCount, 1);

  const bobProfile = await api<{ user: Record<string, unknown> }>(`/users/${userBId}`, {
    token: tokenA,
  });
  assert.equal(bobProfile.data.user["followerCount"], 1);
  assert.equal(bobProfile.data.user["isFollowing"], true);

  // 8. Messaging: Send, Reply, React, Edit, Search, Pin/Mute, Delete, Report & Block
  const send1 = await api<{ message: { id: string; text: string } }>("/messages", {
    method: "POST",
    token: tokenA,
    body: { peerId: userBId, text: "Hello Bob! Excited to read Dune." },
  });
  assert.equal(send1.status, 201);
  const msg1Id = send1.data.message.id;

  const reply2 = await api<{
    message: { id: string; replyTo: { id: string; text: string } | null };
  }>("/messages", {
    method: "POST",
    token: tokenB,
    body: { peerId: userAId, text: "Hi Alice! Great choice.", replyToId: msg1Id },
  });
  assert.equal(reply2.status, 201);
  assert.equal(reply2.data.message.replyTo?.id, msg1Id);
  const msg2Id = reply2.data.message.id;

  // React to Bob's message
  const reactRes = await api<{ reactions: { emoji: string; count: number }[] }>(
    `/messages/${msg2Id}/reactions`,
    {
      method: "POST",
      token: tokenA,
      body: { emoji: "❤️" },
    },
  );
  assert.equal(reactRes.status, 200);
  assert.equal(reactRes.data.reactions[0]?.emoji, "❤️");
  assert.equal(reactRes.data.reactions[0]?.count, 1);

  // Edit own message
  const editRes = await api<{ message: { text: string; editedAt: string | null } }>(
    `/messages/${msg1Id}`,
    {
      method: "PATCH",
      token: tokenA,
      body: { text: "Hello Bob! Excited to read Dune Part 1." },
    },
  );
  assert.equal(editRes.status, 200);
  assert.ok(editRes.data.message.editedAt);

  // In-thread search
  const searchMsgRes = await api<{ messages: { id: string }[] }>(`/messages/${userBId}?q=Dune`, {
    token: tokenA,
  });
  assert.equal(searchMsgRes.status, 200);
  assert.equal(searchMsgRes.data.messages.length, 1);

  // Pin & Mute conversation
  const pinRes = await api<{ pinned: boolean; muted: boolean }>(`/conversations/${userBId}`, {
    method: "PATCH",
    token: tokenA,
    body: { pinned: true, muted: true },
  });
  assert.equal(pinRes.status, 200);
  assert.equal(pinRes.data.pinned, true);
  assert.equal(pinRes.data.muted, true);

  // Delete own message
  const delRes = await api<{ ok: boolean; message: { deletedAt: string | null } }>(
    `/messages/${msg1Id}`,
    { method: "DELETE", token: tokenA },
  );
  assert.equal(delRes.status, 200);
  assert.ok(delRes.data.message.deletedAt);

  // Report user
  const reportRes = await api<{ ok: boolean; reportId: string }>("/reports", {
    method: "POST",
    token: tokenA,
    body: { reportedUserId: userBId, reason: "Spam", details: "Test report" },
  });
  assert.equal(reportRes.status, 201);
  assert.ok(reportRes.data.reportId);

  // Block prevents sending messages
  await api("/blocks", {
    method: "POST",
    token: tokenA,
    body: { targetUserId: userBId },
  });
  const blockedSend = await api("/messages", {
    method: "POST",
    token: tokenB,
    body: { peerId: userAId, text: "Should fail" },
  });
  assert.equal(blockedSend.status, 403);
});

test("Gallery real image upload, binary retrieval, and owner-only delete", async () => {
  const regOwner = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Gallery Owner",
      username: "gallery_owner",
      email: "gallery.owner@example.com",
      password: "Password123!",
    },
  });
  assert.equal(regOwner.status, 201);
  const ownerToken = regOwner.data.token;

  const regOther = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Gallery Other",
      username: "gallery_other",
      email: "gallery.other@example.com",
      password: "Password123!",
    },
  });
  assert.equal(regOther.status, 201);
  const otherToken = regOther.data.token;

  // Minimal valid 1x1 PNG binary
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const form = new FormData();
  form.append("file", new Blob([pngBytes], { type: "image/png" }), "cover-photo.png");

  const uploadResp = await fetch(`${baseUrl}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}` },
    body: form,
  });
  assert.equal(uploadResp.status, 201);
  const uploaded = (await uploadResp.json()) as {
    id: string;
    kind: string;
    mimeType: string;
    originalName: string;
    sizeBytes: number;
    url: string;
    mine: boolean;
  };
  assert.equal(uploaded.kind, "image");
  assert.equal(uploaded.mimeType, "image/png");
  assert.equal(uploaded.originalName, "cover-photo.png");
  assert.equal(uploaded.sizeBytes, pngBytes.length);
  assert.equal(uploaded.mine, true);

  // Listed in /api/gallery
  const galleryRes = await api<{ items: { id: string; url: string; mine: boolean }[] }>(
    "/gallery",
    { token: ownerToken },
  );
  assert.equal(galleryRes.status, 200);
  assert.equal(galleryRes.data.items.length, 1);
  assert.equal(galleryRes.data.items[0]?.id, uploaded.id);
  assert.equal(galleryRes.data.items[0]?.mine, true);

  // Real binary image served with image/png content-type
  const mediaResp = await fetch(`${baseUrl}/media/${uploaded.id}`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(mediaResp.status, 200);
  assert.equal(mediaResp.headers.get("content-type"), "image/png");
  const downloadedBytes = Buffer.from(await mediaResp.arrayBuffer());
  assert.deepEqual(downloadedBytes, pngBytes);

  // Another user cannot delete it
  const forbiddenDel = await api(`/media/${uploaded.id}`, {
    method: "DELETE",
    token: otherToken,
  });
  assert.equal(forbiddenDel.status, 403);

  // Owner can delete it
  const ownerDel = await api<{ ok: boolean; id: string }>(`/media/${uploaded.id}`, {
    method: "DELETE",
    token: ownerToken,
  });
  assert.equal(ownerDel.status, 200);
  assert.equal(ownerDel.data.ok, true);
  assert.equal(ownerDel.data.id, uploaded.id);

  // No longer in gallery or accessible on disk
  const afterGallery = await api<{ items: unknown[] }>("/gallery", { token: ownerToken });
  assert.equal(afterGallery.status, 200);
  assert.equal(afterGallery.data.items.length, 0);

  const afterMedia = await fetch(`${baseUrl}/media/${uploaded.id}`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(afterMedia.status, 404);
});

test("Personal NFC link generation, verification, regeneration, revocation, and /auth/session restore", async () => {
  const regA = await api<{ token: string; user: { id: string; fullName: string } }>(
    "/auth/register",
    {
      method: "POST",
      body: {
        fullName: "Nadia Reader",
        username: "nadia_reads",
        email: "nadia@example.com",
        password: "NadiaPassword123!",
      },
    },
  );
  assert.equal(regA.status, 201);
  const tokenA = regA.data.token;

  const regB = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Sam Reader",
      username: "sam_reads",
      email: "sam@example.com",
      password: "SamPassword123!",
    },
  });
  assert.equal(regB.status, 201);
  const tokenB = regB.data.token;

  // Session check returns authenticated user for valid bearer token and null user without token
  const anonSess = await api<{ user: unknown }>("/auth/session");
  assert.equal(anonSess.status, 200);
  assert.equal(anonSess.data.user, null);

  const authSess = await api<{ user: { id: string; email: string } }>("/auth/session", {
    token: tokenA,
  });
  assert.equal(authSess.status, 200);
  assert.equal(authSess.data.user.id, regA.data.user.id);
  assert.equal(authSess.data.user.email, "nadia@example.com");

  // Fetch initial NFC personal link for User A
  const nfc1 = await api<{ token: string; path: string; version: number; revoked: boolean }>(
    "/nfc",
    { token: tokenA },
  );
  assert.equal(nfc1.status, 200);
  assert.equal(nfc1.data.revoked, false);
  assert.equal(nfc1.data.version, 1);
  assert.ok(nfc1.data.token);
  assert.equal(nfc1.data.path, `/nfc/${nfc1.data.token}`);

  // Owner session resolves as authorized; anonymous / different user gets login_required
  const resolveSelf = await api<{ status: string; owner?: { id: string } }>(
    `/nfc/resolve?token=${encodeURIComponent(nfc1.data.token)}`,
    { token: tokenA },
  );
  assert.equal(resolveSelf.status, 200);
  assert.equal(resolveSelf.data.status, "authorized");
  assert.equal(resolveSelf.data.owner?.id, regA.data.user.id);

  const resolveOther = await api<{
    status: string;
    signedInAsDifferentAccount?: boolean;
  }>(`/nfc/resolve?token=${encodeURIComponent(nfc1.data.token)}`, { token: tokenB });
  assert.equal(resolveOther.status, 200);
  assert.equal(resolveOther.data.status, "login_required");
  assert.equal(resolveOther.data.signedInAsDifferentAccount, true);

  // Regenerating link invalidates old token and increments version
  const regen = await api<{ token: string; path: string; version: number; revoked: boolean }>(
    "/nfc/regenerate",
    { method: "POST", token: tokenA },
  );
  assert.equal(regen.status, 200);
  assert.equal(regen.data.version, 2);
  assert.notEqual(regen.data.token, nfc1.data.token);

  const oldResolve = await api(`/nfc/resolve?token=${encodeURIComponent(nfc1.data.token)}`, {
    token: tokenA,
  });
  assert.equal(oldResolve.status, 404);

  const newResolve = await api<{ status: string }>(
    `/nfc/resolve?token=${encodeURIComponent(regen.data.token)}`,
    { token: tokenA },
  );
  assert.equal(newResolve.status, 200);
  assert.equal(newResolve.data.status, "authorized");

  // Direct instant login via valid Personal Link (/nfc/login) without credentials
  const instantLogin = await api<{
    status: string;
    token: string;
    user: { id: string; displayHandle: string };
  }>("/nfc/login", {
    method: "POST",
    body: { token: regen.data.token },
  });
  assert.equal(instantLogin.status, 200);
  assert.equal(instantLogin.data.status, "authorized");
  assert.equal(instantLogin.data.user.id, regA.data.user.id);
  assert.ok(instantLogin.data.token.startsWith("rc_sess_"));

  // Instant session from personal link works on authenticated endpoints immediately
  const nfcMeCheck = await api<{ user: { id: string } }>("/auth/me", {
    token: instantLogin.data.token,
  });
  assert.equal(nfcMeCheck.status, 200);
  assert.equal(nfcMeCheck.data.user.id, regA.data.user.id);

  // Revoking disables both /nfc/resolve and /nfc/login
  const revoke = await api<{ revoked: boolean; token: string | null }>("/nfc/revoke", {
    method: "POST",
    token: tokenA,
  });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.data.revoked, true);
  assert.equal(revoke.data.token, null);

  const revokedLogin = await api("/nfc/login", {
    method: "POST",
    body: { token: regen.data.token },
  });
  assert.equal(revokedLogin.status, 404);

  const revokedResolve = await api(`/nfc/resolve?token=${encodeURIComponent(regen.data.token)}`, {
    token: tokenA,
  });
  assert.equal(revokedResolve.status, 404);
});

function connectWs(token: string): Promise<{
  ws: WebSocket;
  waitForEvent: (name: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBaseUrl}?token=${encodeURIComponent(token)}`);
    const queue: { event: string; payload: Record<string, unknown> }[] = [];
    const waiters: {
      event: string;
      done: (payload: Record<string, unknown>) => void;
    }[] = [];

    ws.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString()) as {
        event?: string;
        payload?: Record<string, unknown>;
      };
      if (!parsed.event) return;
      const idx = waiters.findIndex((w) => w.event === parsed.event);
      if (idx >= 0) {
        const [w] = waiters.splice(idx, 1);
        w?.done(parsed.payload ?? {});
      } else {
        queue.push({ event: parsed.event, payload: parsed.payload ?? {} });
      }
    });

    const waitForEvent = (name: string, timeoutMs = 4000) => {
      const existingIdx = queue.findIndex((item) => item.event === name);
      if (existingIdx >= 0) {
        const [item] = queue.splice(existingIdx, 1);
        return Promise.resolve(item!.payload);
      }
      return new Promise<Record<string, unknown>>((res, rej) => {
        const timer = setTimeout(() => {
          rej(new Error(`Timed out waiting for WS event '${name}'`));
        }, timeoutMs);
        waiters.push({
          event: name,
          done: (payload) => {
            clearTimeout(timer);
            res(payload);
          },
        });
      });
    };

    ws.on("open", () => resolve({ ws, waitForEvent }));
    ws.on("error", reject);
  });
}

test("Real-time user registration broadcast, live chat delivery, WebRTC call SDP/ICE relay, and firebase-session guard", async () => {
  const regA = await api<{ token: string; user: { id: string; fullName: string } }>(
    "/auth/register",
    {
      method: "POST",
      body: {
        fullName: "Live Caller",
        username: "live_caller",
        email: "caller@example.com",
        password: "Password123!",
      },
    },
  );
  assert.equal(regA.status, 201);

  const regB = await api<{ token: string; user: { id: string; fullName: string } }>(
    "/auth/register",
    {
      method: "POST",
      body: {
        fullName: "Live Callee",
        username: "live_callee",
        email: "callee@example.com",
        password: "Password123!",
      },
    },
  );
  assert.equal(regB.status, 201);

  const clientA = await connectWs(regA.data.token);
  const clientB = await connectWs(regB.data.token);
  await Promise.all([clientA.waitForEvent("connected"), clientB.waitForEvent("connected")]);

  try {
    // 1. Registering User C broadcasts live user:registered to all connected clients without leaking email
    const broadcastA = clientA.waitForEvent("user:registered");
    const broadcastB = clientB.waitForEvent("user:registered");
    const regC = await api<{ token: string; user: { id: string; fullName: string } }>(
      "/auth/register",
      {
        method: "POST",
        body: {
          fullName: "Newcomer Reader",
          username: "newcomer_reader",
          email: "newcomer@example.com",
          password: "Password123!",
        },
      },
    );
    assert.equal(regC.status, 201);
    const [evtA, evtB] = await Promise.all([broadcastA, broadcastB]);
    const userOnA = evtA["user"] as Record<string, unknown>;
    const userOnB = evtB["user"] as Record<string, unknown>;
    assert.equal(userOnA["id"], regC.data.user.id);
    assert.equal(userOnB["fullName"], "Newcomer Reader");
    assert.equal(userOnA["email"], undefined);

    // 2. Live chat message reaches recipient over WebSocket
    const dmIncoming = clientB.waitForEvent("message:new");
    const sendRes = await api<{ message: { id: string; text: string } }>("/messages", {
      method: "POST",
      token: regA.data.token,
      body: { peerId: regB.data.user.id, text: "Realtime WS message check" },
    });
    assert.equal(sendRes.status, 201);
    const dmPayload = await dmIncoming;
    assert.equal((dmPayload["message"] as { text?: string })?.text, "Realtime WS message check");

    // 3. Live WebRTC audio/video call signaling preserves callId, SDP offer/answer, and ICE candidates
    const callIncomingB = clientB.waitForEvent("call:incoming");
    const callRingingA = clientA.waitForEvent("call:ringing");
    clientA.ws.send(
      JSON.stringify({
        event: "call:initiate",
        payload: {
          callId: "call_test_1234",
          targetId: regB.data.user.id,
          callType: "video",
        },
      }),
    );
    const [incomingData, ringingData] = await Promise.all([callIncomingB, callRingingA]);
    assert.equal(incomingData["callId"], "call_test_1234");
    assert.equal(incomingData["callType"], "video");
    assert.equal((incomingData["from"] as { id?: string })?.id, regA.data.user.id);
    assert.equal(ringingData["recipientOnline"], true);

    const acceptedA = clientA.waitForEvent("call:signal");
    clientB.ws.send(
      JSON.stringify({
        event: "call:signal",
        payload: { targetId: regA.data.user.id, callId: "call_test_1234", action: "accepted" },
      }),
    );
    assert.equal((await acceptedA)["action"], "accepted");

    const offerB = clientB.waitForEvent("call:signal");
    clientA.ws.send(
      JSON.stringify({
        event: "call:signal",
        payload: {
          targetId: regB.data.user.id,
          callId: "call_test_1234",
          action: "offer",
          sdp: { type: "offer", sdp: "v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\n" },
        },
      }),
    );
    const receivedOffer = await offerB;
    assert.equal(receivedOffer["action"], "offer");
    assert.equal((receivedOffer["sdp"] as { type?: string })?.type, "offer");

    const answerA = clientA.waitForEvent("call:signal");
    clientB.ws.send(
      JSON.stringify({
        event: "call:signal",
        payload: {
          targetId: regA.data.user.id,
          callId: "call_test_1234",
          action: "answer",
          sdp: { type: "answer", sdp: "v=0\r\no=- 456 2 IN IP4 127.0.0.1\r\n" },
        },
      }),
    );
    const receivedAnswer = await answerA;
    assert.equal(receivedAnswer["action"], "answer");
    assert.equal((receivedAnswer["sdp"] as { type?: string })?.type, "answer");

    const iceA = clientA.waitForEvent("call:signal");
    clientB.ws.send(
      JSON.stringify({
        event: "call:signal",
        payload: {
          targetId: regA.data.user.id,
          callId: "call_test_1234",
          action: "ice-candidate",
          candidate: { candidate: "candidate:1 1 udp 2122260223 127.0.0.1 50000 typ host" },
        },
      }),
    );
    const receivedIce = await iceA;
    assert.equal(receivedIce["action"], "ice-candidate");
    assert.ok((receivedIce["candidate"] as { candidate?: string })?.candidate?.includes("host"));

    const endedB = clientB.waitForEvent("call:signal");
    clientA.ws.send(
      JSON.stringify({
        event: "call:signal",
        payload: { targetId: regB.data.user.id, callId: "call_test_1234", action: "ended" },
      }),
    );
    assert.equal((await endedB)["action"], "ended");

    // 4. firebase-session endpoint validates ID token presence & signature
    const missingFb = await api("/auth/firebase-session", { method: "POST", body: {} });
    assert.equal(missingFb.status, 400);
    const badFb = await api("/auth/firebase-session", {
      method: "POST",
      body: { idToken: "not-a-valid-jwt" },
    });
    assert.equal(badFb.status, 401);

    // 5. Account deletion validates password + securityKey, removes user & broadcasts user:deleted live
    const badKeyDel = await api("/auth/account", {
      method: "DELETE",
      token: regC.data.token,
      body: { password: "Password123!", securityKey: "wrong-key" },
    });
    assert.equal(badKeyDel.status, 403);

    const badPwdDel = await api("/auth/account", {
      method: "DELETE",
      token: regC.data.token,
      body: {
        password: "WrongPassword!",
        securityKey: process.env["ACCOUNT_DELETE_KEY"] || "2233",
      },
    });
    assert.equal(badPwdDel.status, 401);

    const deletedEventPromise = clientA.waitForEvent("user:deleted");
    const delC = await api<{ ok: boolean; deletedUserId: string }>("/auth/account", {
      method: "DELETE",
      token: regC.data.token,
      body: {
        password: "Password123!",
        securityKey: process.env["ACCOUNT_DELETE_KEY"] || "2233",
      },
    });
    assert.equal(delC.status, 200);
    assert.equal(delC.data.ok, true);
    assert.equal(delC.data.deletedUserId, regC.data.user.id);
    const deletedEv = await deletedEventPromise;
    assert.equal(deletedEv["userId"], regC.data.user.id);

    const listAfterDel = await api<{ users: Array<{ id: string }> }>("/users", {
      token: regA.data.token,
    });
    assert.equal(listAfterDel.status, 200);
    assert.equal(
      listAfterDel.data.users.some((u) => u.id === regC.data.user.id),
      false,
    );
  } finally {
    clientA.ws.close();
    clientB.ws.close();
  }
});

test("Multi-account linking (max 3 per verified Gmail/phone), 3 login modes, single-account delete isolation & admin CONTROL search", async () => {
  // 1. Register primary verified-contact test account (non-admin)
  const primary = await api<{ token: string; user: { id: string; displayHandle: string } }>(
    "/auth/register",
    {
      method: "POST",
      body: {
        fullName: "Zoya Primary",
        username: "zoya_one",
        email: "zoya.multi@example.com",
        phone: "9988776655",
        countryCode: "+91",
        password: "SharedPassword1!",
      },
    },
  );
  assert.equal(primary.status, 201);

  // Mark email & phone verified (simulating verified Firebase email + SMS OTP proof)
  db.prepare("UPDATE users SET email_verified = 1, phone_verified = 1 WHERE id = ?").run(
    primary.data.user.id,
  );

  // Save reading state for Account 1
  await api("/reading-state", {
    method: "PUT",
    token: primary.data.token,
    body: { state: { completed: ["the-alchemist"], streak: 4 } },
  });

  // 2. Create Account 2 and Account 3 linked to same verified Gmail & phone
  const acc2 = await api<{ token: string; user: { id: string; displayHandle: string } }>(
    "/auth/linked-accounts/create",
    {
      method: "POST",
      token: primary.data.token,
      body: {
        fullName: "Zoya Study",
        username: "zoya_two",
        password: "SharedPassword1!",
        linkBy: "both",
        switchToNew: true,
      },
    },
  );
  assert.equal(acc2.status, 201);
  assert.equal(acc2.data.user.displayHandle, "@zoya_two");

  // Account 2 must have empty/isolated reading state
  const state2 = await api<{ state: Record<string, unknown> | null }>("/reading-state", {
    token: acc2.data.token,
  });
  assert.equal(state2.data.state, null);

  const acc3 = await api<{ token: string; user: { id: string; displayHandle: string } }>(
    "/auth/linked-accounts/create",
    {
      method: "POST",
      token: acc2.data.token,
      body: {
        fullName: "Zoya Poetry",
        username: "zoya_three",
        password: "UniqueThirdPass1!",
        linkBy: "both",
        switchToNew: false,
      },
    },
  );
  assert.equal(acc3.status, 201);

  // 4th account under same Gmail or phone must be rejected with 409
  const acc4 = await api("/auth/linked-accounts/create", {
    method: "POST",
    token: primary.data.token,
    body: {
      fullName: "Zoya Fourth",
      username: "zoya_four",
      password: "Password123!",
      linkBy: "both",
    },
  });
  assert.equal(acc4.status, 409);

  // Linked accounts endpoint lists all 3 siblings with cap 3/3
  const linkedList = await api<{
    maxAccounts: number;
    emailAccountCount: number;
    phoneAccountCount: number;
    accounts: Array<{ id: string }>;
  }>("/auth/linked-accounts", { token: primary.data.token });
  assert.equal(linkedList.status, 200);
  assert.equal(linkedList.data.maxAccounts, 3);
  assert.equal(linkedList.data.emailAccountCount, 3);
  assert.equal(linkedList.data.phoneAccountCount, 3);
  assert.equal(linkedList.data.accounts.length, 3);

  // 3. Explicit login modes: gmail, phone, username
  // Gmail + SharedPassword1! matches 2 linked accounts -> requiresAccountChoice: true
  const gmailChoice = await api<{
    requiresAccountChoice?: boolean;
    accounts?: Array<{ id: string; displayHandle: string }>;
  }>("/auth/login", {
    method: "POST",
    body: { mode: "gmail", email: "zoya.multi@example.com", password: "SharedPassword1!" },
  });
  assert.equal(gmailChoice.status, 200);
  assert.equal(gmailChoice.data.requiresAccountChoice, true);
  assert.equal(gmailChoice.data.accounts?.length, 2);

  // Targeting specific sibling resolves directly
  const gmailTargeted = await api<{ token: string; user: { id: string } }>("/auth/login", {
    method: "POST",
    body: {
      mode: "gmail",
      email: "zoya.multi@example.com",
      password: "SharedPassword1!",
      targetUserId: acc2.data.user.id,
    },
  });
  assert.equal(gmailTargeted.status, 200);
  assert.equal(gmailTargeted.data.user.id, acc2.data.user.id);

  // Phone + UniqueThirdPass1! logs directly into Account 3
  const phoneLogin = await api<{ token: string; user: { id: string; displayHandle: string } }>(
    "/auth/login",
    {
      method: "POST",
      body: {
        mode: "phone",
        phone: "9988776655",
        countryCode: "+91",
        password: "UniqueThirdPass1!",
      },
    },
  );
  assert.equal(phoneLogin.status, 200);
  assert.equal(phoneLogin.data.user.id, acc3.data.user.id);

  // Username + Password logs into exact handle
  const usernameLogin = await api<{ token: string; user: { id: string } }>("/auth/login", {
    method: "POST",
    body: { mode: "username", username: "@zoya_one", password: "SharedPassword1!" },
  });
  assert.equal(usernameLogin.status, 200);
  assert.equal(usernameLogin.data.user.id, primary.data.user.id);

  // 4. Switch account between siblings
  const switched = await api<{ token: string; user: { id: string } }>("/auth/switch-account", {
    method: "POST",
    token: primary.data.token,
    body: { targetUserId: acc3.data.user.id },
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.data.user.id, acc3.data.user.id);

  // 5. Delete Account 2 only -> Account 1 & Account 3 must survive
  const delAcc2 = await api<{ ok: boolean; deletedUserId: string }>("/auth/account", {
    method: "DELETE",
    token: acc2.data.token,
    body: {
      password: "SharedPassword1!",
      securityKey: process.env["ACCOUNT_DELETE_KEY"] || "2233",
    },
  });
  assert.equal(delAcc2.status, 200);
  assert.equal(delAcc2.data.deletedUserId, acc2.data.user.id);

  const checkAcc1StillAlive = await api<{ user: { id: string } }>("/auth/me", {
    token: usernameLogin.data.token,
  });
  assert.equal(checkAcc1StillAlive.status, 200);
  assert.equal(checkAcc1StillAlive.data.user.id, primary.data.user.id);

  // Reading state on Account 1 remained intact
  const state1After = await api<{ state: { completed?: string[] } }>("/reading-state", {
    token: usernameLogin.data.token,
  });
  assert.deepEqual(state1After.data.state?.completed, ["the-alchemist"]);

  // 6. Rate-limit lock after repeated wrong security keys on delete
  for (let i = 0; i < 4; i += 1) {
    const attempt = await api("/auth/account", {
      method: "DELETE",
      token: phoneLogin.data.token,
      body: { password: "UniqueThirdPass1!", securityKey: "0000" },
    });
    assert.equal(attempt.status, 403);
  }
  const lockedAttempt = await api("/auth/account", {
    method: "DELETE",
    token: phoneLogin.data.token,
    body: { password: "UniqueThirdPass1!", securityKey: "0000" },
  });
  assert.equal(lockedAttempt.status, 429);

  // 7. CONTROL User Directory & Removal — requires login, exposes public ID/handle/DP/personalLink only,
  //    and DELETE /api/control/users/:userId verifies removal code on server with rate-limiting
  const anonControl = await api("/control/users?q=zoya");
  assert.equal(anonControl.status, 401);

  const signedControl = await api<{ users: Array<Record<string, unknown>> }>(
    "/control/users?q=zoya_one",
    { token: usernameLogin.data.token },
  );
  assert.equal(signedControl.status, 200);
  const foundZoya = signedControl.data.users.find((u) => u["id"] === primary.data.user.id);
  assert.ok(foundZoya);
  assert.equal(foundZoya["displayHandle"], "@zoya_one");
  assert.match(String(foundZoya["personalLink"]), /^\/nfc\//);
  // Zero sensitive PII returned by CONTROL search
  assert.equal(foundZoya["email"], undefined);
  assert.equal(foundZoya["phone_e164"], undefined);
  assert.equal(foundZoya["phoneE164"], undefined);
  assert.equal(foundZoya["password_hash"], undefined);

  // Create a disposable target account to test removal from CONTROL
  const disposable = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Disposable Target",
      username: "disp_target",
      email: "disp_target@example.com",
      password: "DispPassword123!",
    },
  });
  assert.equal(disposable.status, 201);

  const anonDelete = await api(`/control/users/${encodeURIComponent(disposable.data.user.id)}`, {
    method: "DELETE",
    body: { code: process.env["CONTROL_REMOVE_CODE"] || "2233" },
  });
  assert.equal(anonDelete.status, 401);

  const wrongCodeDelete = await api(
    `/control/users/${encodeURIComponent(disposable.data.user.id)}`,
    {
      method: "DELETE",
      token: usernameLogin.data.token,
      body: { code: "0000" },
    },
  );
  assert.equal(wrongCodeDelete.status, 403);

  const validCodeDelete = await api<{ ok: boolean; deletedUserId: string }>(
    `/control/users/${encodeURIComponent(disposable.data.user.id)}`,
    {
      method: "DELETE",
      token: usernameLogin.data.token,
      body: { code: process.env["CONTROL_REMOVE_CODE"] || "2233" },
    },
  );
  assert.equal(validCodeDelete.status, 200);
  assert.equal(validCodeDelete.data.deletedUserId, disposable.data.user.id);

  // Target is permanently gone; Zoya Account 1 & 3 remain intact
  const checkDispGone = await api("/auth/me", { token: disposable.data.token });
  assert.equal(checkDispGone.status, 401);
  const checkZoyaStillAlive = await api("/auth/me", { token: usernameLogin.data.token });
  assert.equal(checkZoyaStillAlive.status, 200);
});

test("Account registration with profile photo upload saves avatar without foreign key failure", async () => {
  const avatarDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const reg = await api<{ token: string; user: { id: string; avatarUrl: string | null } }>(
    "/auth/register",
    {
      method: "POST",
      body: {
        fullName: "Photo Reader",
        username: "photo_reader",
        email: "photo.reader@example.com",
        password: "Password123!",
        avatarDataUrl,
      },
    },
  );
  assert.equal(reg.status, 201);
  assert.ok(reg.data.user.avatarUrl?.startsWith("/api/media/"));

  const avatarRes = await fetch(`${baseUrl.replace(/\/api$/, "")}${reg.data.user.avatarUrl}`, {
    headers: { Authorization: `Bearer ${reg.data.token}` },
  });
  assert.equal(avatarRes.status, 200);
  assert.equal(avatarRes.headers.get("content-type"), "image/png");
});

test("Directory, search, conversations, and linked-accounts return strictly unique user IDs", async () => {
  const reg = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Unique Directory Checker",
      username: "unique_dir_check",
      email: "unique.dir@example.com",
      password: "Password123!",
    },
  });
  assert.equal(reg.status, 201);
  const token = reg.data.token;
  const userId = reg.data.user.id;

  const [controlRes, usersRes, searchRes, convRes, linkedRes] = await Promise.all([
    api<{ users: Array<{ id: string }> }>("/control/users", { token }),
    api<{ users: Array<{ id: string }> }>("/users", { token }),
    api<{ users: Array<{ id: string }> }>("/users/search?q=reader", { token }),
    api<{ conversations: Array<{ peer: { id: string } }> }>("/conversations", { token }),
    api<{ accounts: Array<{ id: string }> }>("/auth/linked-accounts", { token }),
  ]);

  assert.equal(controlRes.status, 200);
  const controlIds = controlRes.data.users.map((u) => u.id);
  assert.equal(new Set(controlIds).size, controlIds.length);
  assert.ok(controlIds.includes(userId));

  assert.equal(usersRes.status, 200);
  const userIds = usersRes.data.users.map((u) => u.id);
  assert.equal(new Set(userIds).size, userIds.length);
  assert.equal(userIds.includes(userId), false);

  assert.equal(searchRes.status, 200);
  const searchIds = searchRes.data.users.map((u) => u.id);
  assert.equal(new Set(searchIds).size, searchIds.length);
  assert.equal(searchIds.includes(userId), false);

  assert.equal(convRes.status, 200);
  const convPeerIds = convRes.data.conversations.map((c) => c.peer.id);
  assert.equal(new Set(convPeerIds).size, convPeerIds.length);

  assert.equal(linkedRes.status, 200);
  const linkedIds = linkedRes.data.accounts.map((a) => a.id);
  assert.equal(new Set(linkedIds).size, linkedIds.length);
});

test("POST account removal routes succeed without DELETE body dependency", async () => {
  const actor = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Post Remove Actor",
      username: "post_remove_actor",
      email: "post.remove.actor@example.com",
      password: "Password123!",
    },
  });
  assert.equal(actor.status, 201);
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(actor.data.user.id);

  const victim = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Post Remove Target",
      username: "post_remove_target",
      email: "post.remove.target@example.com",
      password: "Password123!",
    },
  });
  assert.equal(victim.status, 201);

  const emptyCodeRes = await api(
    `/control/users/${encodeURIComponent(victim.data.user.id)}/remove`,
    {
      method: "POST",
      token: actor.data.token,
      body: { code: "" },
    },
  );
  assert.equal(emptyCodeRes.status, 400);

  const wrongCodeRes = await api(
    `/control/users/${encodeURIComponent(victim.data.user.id)}/remove`,
    {
      method: "POST",
      token: actor.data.token,
      body: { code: "9999" },
    },
  );
  assert.equal(wrongCodeRes.status, 403);

  const postRemoveRes = await api<{ ok: boolean; deletedUserId: string }>(
    `/control/users/${encodeURIComponent(victim.data.user.id)}/remove`,
    {
      method: "POST",
      token: actor.data.token,
      body: { code: "2233" },
    },
  );
  assert.equal(postRemoveRes.status, 200);
  assert.equal(postRemoveRes.data.ok, true);
  assert.equal(postRemoveRes.data.deletedUserId, victim.data.user.id);

  const victimAfter = await api("/auth/me", { token: victim.data.token });
  assert.equal(victimAfter.status, 401);

  // Victim 2 removed using admin's account password instead of 2233
  const victim2 = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Post Remove Target Two",
      username: "post_remove_target_2",
      email: "post.remove.target2@example.com",
      password: "Password123!",
    },
  });
  assert.equal(victim2.status, 201);

  const adminPassRemoveRes = await api<{ ok: boolean; deletedUserId: string }>(
    `/control/users/${encodeURIComponent(victim2.data.user.id)}/remove`,
    {
      method: "POST",
      token: actor.data.token,
      body: { code: "Password123!" },
    },
  );
  assert.equal(adminPassRemoveRes.status, 200);
  assert.equal(adminPassRemoveRes.data.deletedUserId, victim2.data.user.id);

  const selfDeleteRes = await api<{ ok: boolean; deletedUserId: string }>("/auth/account/delete", {
    method: "POST",
    token: actor.data.token,
    body: {
      password: "Password123!",
      securityKey: "2233",
    },
  });
  assert.equal(selfDeleteRes.status, 200);
  assert.equal(selfDeleteRes.data.deletedUserId, actor.data.user.id);
});

test("Media upload ticket falls back cleanly and multipart image/video uploads succeed", async () => {
  const sender = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Media Sender",
      username: "media_sender",
      email: "media.sender@example.com",
      password: "Password123!",
    },
  });
  assert.equal(sender.status, 201);

  const recipient = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Media Recipient",
      username: "media_recipient",
      email: "media.recipient@example.com",
      password: "Password123!",
    },
  });
  assert.equal(recipient.status, 201);

  // 1. Upload ticket returns undefined supabaseUrl when Supabase is unconfigured
  const ticketRes = await api<{
    id: string;
    supabaseUrl?: string;
    anonKey?: string;
    url: string;
  }>("/media/upload-ticket", {
    method: "POST",
    token: sender.data.token,
    body: {
      kind: "image",
      mimeType: "image/jpeg",
      originalName: "photo.jpg",
      sizeBytes: 1024,
      recipientId: recipient.data.user.id,
    },
  });
  assert.equal(ticketRes.status, 200);
  assert.equal(ticketRes.data.supabaseUrl, undefined);
  assert.equal(ticketRes.data.anonKey, undefined);

  // 2. Direct multipart upload via /media works for image
  const imgBytes = Buffer.from("fake-jpg-content-for-testing");
  const imgForm = new FormData();
  imgForm.append("file", new Blob([imgBytes], { type: "image/jpeg" }), "vacation.jpg");
  imgForm.append("recipientId", recipient.data.user.id);

  const uploadImgRes = await fetch(`${baseUrl}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sender.data.token}` },
    body: imgForm,
  });
  assert.equal(uploadImgRes.status, 201);
  const uploadedImg = (await uploadImgRes.json()) as {
    id: string;
    kind: string;
    mimeType: string;
    originalName: string;
    url: string;
    mine: boolean;
  };
  assert.equal(uploadedImg.kind, "image");
  assert.equal(uploadedImg.mimeType, "image/jpeg");
  assert.equal(uploadedImg.originalName, "vacation.jpg");

  // 3. Sender can download the image
  const senderGet = await fetch(`${baseUrl}/media/${uploadedImg.id}`, {
    headers: { Authorization: `Bearer ${sender.data.token}` },
  });
  assert.equal(senderGet.status, 200);
  assert.equal(senderGet.headers.get("content-type"), "image/jpeg");
  const senderBytes = Buffer.from(await senderGet.arrayBuffer());
  assert.deepEqual(senderBytes, imgBytes);

  // 4. Recipient can download the image because recipientId was specified
  const recipientGet = await fetch(`${baseUrl}/media/${uploadedImg.id}`, {
    headers: { Authorization: `Bearer ${recipient.data.token}` },
  });
  assert.equal(recipientGet.status, 200);
  assert.equal(recipientGet.headers.get("content-type"), "image/jpeg");

  // 5. Direct multipart upload works for video
  const vidBytes = Buffer.from("fake-mp4-video-stream-data");
  const vidForm = new FormData();
  vidForm.append("file", new Blob([vidBytes], { type: "video/mp4" }), "clip.mp4");
  vidForm.append("recipientId", recipient.data.user.id);

  const uploadVidRes = await fetch(`${baseUrl}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sender.data.token}` },
    body: vidForm,
  });
  assert.equal(uploadVidRes.status, 201);
  const uploadedVid = (await uploadVidRes.json()) as {
    id: string;
    kind: string;
    mimeType: string;
    originalName: string;
  };
  assert.equal(uploadedVid.kind, "video");
  assert.equal(uploadedVid.mimeType, "video/mp4");

  // 6. Both image and video appear in sender gallery
  const galleryRes = await api<{ items: { id: string; kind: string }[] }>("/gallery", {
    token: sender.data.token,
  });
  assert.equal(galleryRes.status, 200);
  const galleryIds = galleryRes.data.items.map((i) => i.id);
  assert.ok(galleryIds.includes(uploadedImg.id));
  assert.ok(galleryIds.includes(uploadedVid.id));

  // 7. Owner can delete media
  const delRes = await api<{ ok: boolean; id: string }>(`/media/${uploadedImg.id}`, {
    method: "DELETE",
    token: sender.data.token,
  });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.data.ok, true);
});

test("Cookie+Bearer auth fallback, newest-first pagination, Secret/Normal gallery, notifications isolation, and WS typing", async () => {
  // 1. Register User A & User B via raw fetch so we can capture Set-Cookie
  const rawRegA = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fullName: "Cookie Auth A",
      username: "cookie_auth_a",
      email: "cookie.a@example.com",
      password: "Password123!",
    }),
  });
  assert.equal(rawRegA.status, 201);
  const regABody = (await rawRegA.json()) as { token: string; user: { id: string } };
  const setCookies =
    typeof rawRegA.headers.getSetCookie === "function"
      ? rawRegA.headers.getSetCookie()
      : [rawRegA.headers.get("set-cookie") ?? ""];
  const rawCookieMatch = setCookies.join("; ").match(/rc_session=[^;,\s]+/);
  const rawCookieA = rawCookieMatch?.[0] ?? "";
  assert.ok(rawCookieA.startsWith("rc_session="), "expected rc_session cookie");

  const regB = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Pagination Peer B",
      username: "page_peer_b",
      email: "page.b@example.com",
      password: "Password123!",
    },
  });
  assert.equal(regB.status, 201);

  // 2. Sending rc_session cookie alongside an unrelated non-rc_sess_ Bearer token must NOT 401
  const sessWithCookieAndOtherBearer = await fetch(`${baseUrl}/auth/session`, {
    headers: {
      Cookie: rawCookieA,
      Authorization: "Bearer unrelated_firebase_jwt_placeholder",
    },
  });
  assert.equal(sessWithCookieAndOtherBearer.status, 200);
  const sessJson = (await sessWithCookieAndOtherBearer.json()) as {
    authenticated: boolean;
    token?: string;
    user?: { id: string };
  };
  assert.equal(sessJson.authenticated, true);
  assert.equal(sessJson.user?.id, regABody.user.id);
  assert.ok(sessJson.token?.startsWith("rc_sess_"));

  const msgPostWithCookieAndOtherBearer = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: rawCookieA,
      Authorization: "Bearer unrelated_firebase_jwt_placeholder",
    },
    body: JSON.stringify({ peerId: regB.data.user.id, text: "Msg 1 via cookie" }),
  });
  assert.equal(msgPostWithCookieAndOtherBearer.status, 201);

  // 3. Newest-first cursor pagination: send 4 more messages (total 5)
  for (let i = 2; i <= 5; i += 1) {
    const r = await api<{ message: { id: string } }>("/messages", {
      method: "POST",
      token: regABody.token,
      body: { peerId: regB.data.user.id, text: `Msg ${i}` },
    });
    assert.equal(r.status, 201);
  }

  const page1 = await api<{
    messages: { id: string; text: string }[];
    hasMore: boolean;
    nextCursor: { before: string; beforeId: string } | null;
  }>(`/messages/${regB.data.user.id}?limit=2`, { token: regABody.token });
  assert.equal(page1.status, 200);
  assert.equal(page1.data.messages.length, 2);
  assert.equal(page1.data.hasMore, true);
  assert.deepEqual(
    page1.data.messages.map((m) => m.text),
    ["Msg 4", "Msg 5"],
  );
  assert.ok(page1.data.nextCursor);

  const page2 = await api<{
    messages: { id: string; text: string }[];
    hasMore: boolean;
    nextCursor: { before: string; beforeId: string } | null;
  }>(
    `/messages/${regB.data.user.id}?limit=2&before=${encodeURIComponent(page1.data.nextCursor!.before)}&beforeId=${encodeURIComponent(page1.data.nextCursor!.beforeId)}`,
    { token: regABody.token },
  );
  assert.equal(page2.status, 200);
  assert.equal(page2.data.hasMore, true);
  assert.deepEqual(
    page2.data.messages.map((m) => m.text),
    ["Msg 2", "Msg 3"],
  );

  const page3 = await api<{
    messages: { id: string; text: string }[];
    hasMore: boolean;
  }>(
    `/messages/${regB.data.user.id}?limit=2&before=${encodeURIComponent(page2.data.nextCursor!.before)}&beforeId=${encodeURIComponent(page2.data.nextCursor!.beforeId)}`,
    { token: regABody.token },
  );
  assert.equal(page3.status, 200);
  assert.equal(page3.data.hasMore, false);
  assert.deepEqual(
    page3.data.messages.map((m) => m.text),
    ["Msg 1 via cookie"],
  );

  // 4. Secret vs Normal gallery upload and scope filtering
  const secretForm = new FormData();
  secretForm.append(
    "file",
    new Blob([Buffer.from("secret-img")], { type: "image/png" }),
    "secret.png",
  );
  secretForm.append("recipientId", regB.data.user.id);
  secretForm.append("galleryScope", "secret");
  const upSecret = await fetch(`${baseUrl}/media`, {
    method: "POST",
    headers: { Cookie: rawCookieA },
    body: secretForm,
  });
  assert.equal(upSecret.status, 201);
  const secretMedia = (await upSecret.json()) as { id: string; galleryScope: string };
  assert.equal(secretMedia.galleryScope, "secret");

  const normalForm = new FormData();
  normalForm.append(
    "file",
    new Blob([Buffer.from("normal-img")], { type: "image/png" }),
    "normal.png",
  );
  normalForm.append("galleryScope", "normal");
  const upNormal = await fetch(`${baseUrl}/media`, {
    method: "POST",
    headers: { Cookie: rawCookieA },
    body: normalForm,
  });
  assert.equal(upNormal.status, 201);

  const secretOnly = await api<{ items: { id: string; galleryScope: string }[] }>(
    "/gallery?scope=secret",
    { token: regABody.token },
  );
  assert.equal(secretOnly.status, 200);
  assert.equal(secretOnly.data.items.length, 1);
  assert.equal(secretOnly.data.items[0]?.id, secretMedia.id);

  // Recipient B saves secretMedia to their Normal gallery
  const saveOnB = await api<{ ok: boolean; galleryScope: string }>(
    `/media/${secretMedia.id}/save`,
    { method: "POST", token: regB.data.token, body: { galleryScope: "normal" } },
  );
  assert.equal(saveOnB.status, 201);
  assert.equal(saveOnB.data.galleryScope, "normal");

  // 5. Notification tokens & preferences isolation
  const regTok = await api<{ ok: boolean; platform: string }>("/notifications/token", {
    method: "POST",
    token: regABody.token,
    body: { token: "fcm_token_user_a_sample_1234567890", platform: "android" },
  });
  assert.equal(regTok.status, 201);
  assert.equal(regTok.data.ok, true);
  assert.equal(regTok.data.platform, "android");

  const statusA = await api<{ registeredDevices: number }>("/notifications/status", {
    token: regABody.token,
  });
  assert.equal(statusA.status, 200);
  assert.equal(statusA.data.registeredDevices, 1);

  const prefUpdate = await api<{
    pushEnabled: boolean;
    messagePreview: boolean;
    quietHoursEnabled: boolean;
  }>("/notifications/preferences", {
    method: "PATCH",
    token: regABody.token,
    body: { messagePreview: false, quietHoursEnabled: true },
  });
  assert.equal(prefUpdate.status, 200);
  assert.equal(prefUpdate.data.messagePreview, false);
  assert.equal(prefUpdate.data.quietHoursEnabled, true);

  // User B should see only their own default preferences and zero tokens
  const statusB = await api<{ registeredDevices: number }>("/notifications/status", {
    token: regB.data.token,
  });
  assert.equal(statusB.status, 200);
  assert.equal(statusB.data.registeredDevices, 0);

  // /api/users must never expose notification tokens
  const usersList = await api<{ users: Record<string, unknown>[] }>("/users", {
    token: regB.data.token,
  });
  assert.equal(usersList.status, 200);
  for (const u of usersList.data.users) {
    assert.equal(u["notificationTokens"], undefined);
  }

  // 6. WebSocket connects with rc_session cookie header and delivers typing event
  const wsCookieA = await new Promise<{
    ws: WebSocket;
    waitForEvent: (name: string) => Promise<Record<string, unknown>>;
  }>((resolve, reject) => {
    const ws = new WebSocket(wsBaseUrl, { headers: { Cookie: rawCookieA } });
    const waiters: { event: string; done: (p: Record<string, unknown>) => void }[] = [];
    const queue: { event: string; payload: Record<string, unknown> }[] = [];
    ws.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString()) as {
        event?: string;
        payload?: Record<string, unknown>;
      };
      if (!parsed.event) return;
      const idx = waiters.findIndex((w) => w.event === parsed.event);
      if (idx >= 0) {
        waiters.splice(idx, 1)[0]?.done(parsed.payload ?? {});
      } else {
        queue.push({ event: parsed.event, payload: parsed.payload ?? {} });
      }
    });
    const waitForEvent = (name: string) => {
      const idx = queue.findIndex((q) => q.event === name);
      if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]!.payload);
      return new Promise<Record<string, unknown>>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`Timeout waiting for ${name}`)), 3000);
        waiters.push({
          event: name,
          done: (p) => {
            clearTimeout(t);
            res(p);
          },
        });
      });
    };
    ws.on("open", () => resolve({ ws, waitForEvent }));
    ws.on("error", reject);
  });

  const wsB = await connectWs(regB.data.token);
  await Promise.all([wsCookieA.waitForEvent("connected"), wsB.waitForEvent("connected")]);

  try {
    const typingOnB = wsB.waitForEvent("typing");
    wsCookieA.ws.send(
      JSON.stringify({ event: "typing", payload: { peerId: regB.data.user.id, active: true } }),
    );
    const typingEvt = await typingOnB;
    assert.equal(typingEvt["fromUserId"], regABody.user.id);
    assert.equal(typingEvt["active"], true);

    const seenOnA = wsCookieA.waitForEvent("messages:seen");
    const markSeen = await api<{ ok: boolean }>(`/messages/${regABody.user.id}/seen`, {
      method: "POST",
      token: regB.data.token,
    });
    assert.equal(markSeen.status, 200);
    const seenEvt = await seenOnA;
    assert.equal(seenEvt["byUserId"], regB.data.user.id);
  } finally {
    wsCookieA.ws.close();
    wsB.ws.close();
  }
});

async function connectSse(token: string) {
  const controller = new AbortController();
  const resp = await fetch(`${baseUrl}/events`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
    },
    signal: controller.signal,
  });
  assert.equal(resp.status, 200);
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queue: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const waiters: Array<{
    event: string;
    done: (payload: Record<string, unknown>) => void;
  }> = [];

  void (async () => {
    try {
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const dataLines = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());
          if (dataLines.length === 0) continue;
          const parsed = JSON.parse(dataLines.join("\n")) as {
            event?: string;
            payload?: Record<string, unknown>;
          };
          if (!parsed.event) continue;
          const idx = waiters.findIndex((w) => w.event === parsed.event);
          if (idx >= 0) {
            waiters.splice(idx, 1)[0]?.done(parsed.payload ?? {});
          } else {
            queue.push({ event: parsed.event, payload: parsed.payload ?? {} });
          }
        }
      }
    } catch {
      /* aborted on test cleanup */
    }
  })();

  const waitForEvent = (name: string, timeoutMs = 2000) => {
    const idx = queue.findIndex((item) => item.event === name);
    if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]!.payload);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`Timed out waiting for SSE '${name}'`)),
        timeoutMs,
      );
      waiters.push({
        event: name,
        done: (payload) => {
          clearTimeout(t);
          resolve(payload);
        },
      });
    });
  };

  return {
    waitForEvent,
    close: () => controller.abort(),
  };
}

test("SSE realtime fallback delivers messages instantaneously and generates ephemeral TURN ICE credentials", async () => {
  const regA = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "SSE Sender",
      username: "sse_sender",
      email: "sse.sender@example.com",
      password: "Password123!",
    },
  });
  const regB = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "SSE Receiver",
      username: "sse_receiver",
      email: "sse.receiver@example.com",
      password: "Password123!",
    },
  });
  assert.equal(regA.status, 201);
  assert.equal(regB.status, 201);

  const sseB = await connectSse(regB.data.token);
  try {
    await sseB.waitForEvent("connected");
    const activeRes = await api<{ ok: boolean }>("/thread/active", {
      method: "POST",
      token: regB.data.token,
      body: { peerId: regA.data.user.id },
    });
    assert.equal(activeRes.status, 200);

    const startedAt = Date.now();
    const incomingPromise = sseB.waitForEvent("message:new", 1500);
    const sendRes = await api<{
      message: { id: string; text: string; deliveredAt: string | null };
    }>("/messages", {
      method: "POST",
      token: regA.data.token,
      body: { peerId: regB.data.user.id, text: "Instant SSE delivery test" },
    });
    assert.equal(sendRes.status, 201);
    assert.ok(sendRes.data.message.deliveredAt, "expected immediate deliveredAt over SSE");

    const evt = await incomingPromise;
    const elapsedMs = Date.now() - startedAt;
    assert.equal((evt["message"] as { text?: string })?.text, "Instant SSE delivery test");
    assert.ok(elapsedMs < 1000, `Expected <1000ms SSE delivery, took ${elapsedMs}ms`);
  } finally {
    sseB.close();
  }

  // ICE servers endpoint requires authentication and issues HMAC ephemeral TURN creds without leaking secret
  const unauthIce = await api("/calls/ice-servers");
  assert.equal(unauthIce.status, 401);

  const prevUrls = process.env["TURN_URLS"];
  const prevSecret = process.env["TURN_SECRET"];
  process.env["TURN_URLS"] =
    "turn:turn.readingcorner.example:3478?transport=udp,turns:turn.readingcorner.example:5349?transport=tcp";
  process.env["TURN_SECRET"] = "super_secret_coturn_key_do_not_expose";
  try {
    const iceRes = await api<{
      iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
      turnConfigured: boolean;
      ttlSeconds: number;
    }>("/calls/ice-servers", { token: regA.data.token });
    assert.equal(iceRes.status, 200);
    assert.equal(iceRes.data.turnConfigured, true);
    assert.ok(iceRes.data.ttlSeconds >= 60);
    const turnEntry = iceRes.data.iceServers.find((s) =>
      (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => String(u).startsWith("turn:")),
    );
    assert.ok(turnEntry);
    assert.match(turnEntry.username ?? "", /^\d+:[a-f0-9]{12}$/);
    assert.equal(turnEntry.username?.includes(regA.data.user.id), false);
    assert.ok(
      turnEntry.credential && turnEntry.credential !== "super_secret_coturn_key_do_not_expose",
    );
    assert.equal(
      JSON.stringify(iceRes.data).includes("super_secret_coturn_key_do_not_expose"),
      false,
    );
  } finally {
    if (prevUrls === undefined) delete process.env["TURN_URLS"];
    else process.env["TURN_URLS"] = prevUrls;
    if (prevSecret === undefined) delete process.env["TURN_SECRET"];
    else process.env["TURN_SECRET"] = prevSecret;
  }
});

test("HTTP call signaling fallback and WS disconnect grace-period preserve calls and replay buffered signals", async () => {
  const regCaller = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Grace Caller",
      username: "grace_caller",
      email: "grace.caller@example.com",
      password: "Password123!",
    },
  });
  const regCallee = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Grace Callee",
      username: "grace_callee",
      email: "grace.callee@example.com",
      password: "Password123!",
    },
  });
  assert.equal(regCaller.status, 201);
  assert.equal(regCallee.status, 201);

  const calleeSse = await connectSse(regCallee.data.token);
  const callerWs1 = await connectWs(regCaller.data.token);
  await Promise.all([calleeSse.waitForEvent("connected"), callerWs1.waitForEvent("connected")]);

  try {
    // 1. Initiate call via HTTP API; callee receives call:incoming over SSE
    const callId = "call_http_grace_1";
    const incomingPromise = calleeSse.waitForEvent("call:incoming", 2000);
    const initRes = await api<{ ok: boolean; callId: string; recipientOnline: boolean }>(
      "/calls/initiate",
      {
        method: "POST",
        token: regCaller.data.token,
        body: { callId, targetId: regCallee.data.user.id, callType: "video" },
      },
    );
    assert.equal(initRes.status, 200);
    assert.equal(initRes.data.recipientOnline, true);
    const incomingEvt = await incomingPromise;
    assert.equal(incomingEvt["callId"], callId);

    // 2. Caller WS drops briefly (e.g. mobile permission modal / network switch); callee must NOT receive ended
    callerWs1.ws.close();
    await new Promise((r) => setTimeout(r, 80));

    // Callee accepts via HTTP /calls/signal while caller socket is offline -> server buffers accepted
    const acceptRes = await api<{ ok: boolean }>("/calls/signal", {
      method: "POST",
      token: regCallee.data.token,
      body: { targetId: regCaller.data.user.id, callId, action: "accepted" },
    });
    assert.equal(acceptRes.status, 200);

    // 3. Caller reconnects within grace window and receives buffered accepted signal
    const callerWs2 = await connectWs(regCaller.data.token);
    try {
      await callerWs2.waitForEvent("connected");
      const replayedAccept = await callerWs2.waitForEvent("call:signal", 2000);
      assert.equal(replayedAccept["callId"], callId);
      assert.equal(replayedAccept["action"], "accepted");

      // Cleanly end call
      const endPromise = calleeSse.waitForEvent("call:signal", 2000);
      await api("/calls/signal", {
        method: "POST",
        token: regCaller.data.token,
        body: { targetId: regCallee.data.user.id, callId, action: "ended" },
      });
      const endEvt = await endPromise;
      assert.equal(endEvt["action"], "ended");
    } finally {
      callerWs2.ws.close();
    }

    // 4. Call initiation respects missing user (404) & blocks (403)
    const missingRes = await api("/calls/initiate", {
      method: "POST",
      token: regCaller.data.token,
      body: { targetId: "nonexistent_user_id", callType: "audio" },
    });
    assert.equal(missingRes.status, 404);
  } finally {
    calleeSse.close();
    callerWs1.ws.close();
  }
});

test("Pending incoming calls persist across missed/stale sockets, deliver on /calls/pending and reconnect, and clear on decline", async () => {
  const regA = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Persistent Caller",
      username: "persist_caller",
      email: "persist.caller@example.com",
      password: "Password123!",
    },
  });
  const regB = await api<{ token: string; user: { id: string } }>("/auth/register", {
    method: "POST",
    body: {
      fullName: "Persistent Callee",
      username: "persist_callee",
      email: "persist.callee@example.com",
      password: "Password123!",
    },
  });
  assert.equal(regA.status, 201);
  assert.equal(regB.status, 201);

  // Connect B briefly, initiate call while B has an open WS, then simulate B reconnecting or polling via HTTP
  const calleeWs1 = await connectWs(regB.data.token);
  await calleeWs1.waitForEvent("connected");

  const callId = "call_persist_ring_1";
  try {
    const incomingPromise = calleeWs1.waitForEvent("call:incoming", 2000);
    const initRes = await api<{ ok: boolean; callId: string }>("/calls/initiate", {
      method: "POST",
      token: regA.data.token,
      body: { callId, targetId: regB.data.user.id, callType: "audio" },
    });
    assert.equal(initRes.status, 200);
    await incomingPromise;

    // Even after push to calleeWs1, the ringing offer must remain queryable via GET /calls/pending until answered/declined/ended
    const pendingHttp = await api<{
      calls: Array<{ callId: string; callType: string; from: { id: string; fullName: string } }>;
    }>("/calls/pending", { token: regB.data.token });
    assert.equal(pendingHttp.status, 200);
    assert.equal(pendingHttp.data.calls.length, 1);
    assert.equal(pendingHttp.data.calls[0]?.callId, callId);
    assert.equal(pendingHttp.data.calls[0]?.from.id, regA.data.user.id);
    assert.equal(pendingHttp.data.calls[0]?.from.fullName, "Persistent Caller");
  } finally {
    calleeWs1.ws.close();
  }

  // Simulate callee reconnecting on a fresh WebSocket -> still receives call:incoming because offer wasn't deleted prematurely
  const calleeWs2 = await connectWs(regB.data.token);
  try {
    await calleeWs2.waitForEvent("connected");
    const replayedIncoming = await calleeWs2.waitForEvent("call:incoming", 2000);
    assert.equal(replayedIncoming["callId"], callId);

    // Callee declines via /calls/signal -> removed from /calls/pending and activeCallStatus reports declined
    const declineRes = await api<{ ok: boolean }>("/calls/signal", {
      method: "POST",
      token: regB.data.token,
      body: { targetId: regA.data.user.id, callId, action: "declined" },
    });
    assert.equal(declineRes.status, 200);

    const afterDecline = await api<{
      calls: Array<{ callId: string }>;
      activeCallStatus?: string;
    }>(`/calls/pending?activeCallId=${encodeURIComponent(callId)}`, { token: regA.data.token });
    assert.equal(afterDecline.status, 200);
    assert.equal(afterDecline.data.activeCallStatus, "declined");

    const calleePendingAfter = await api<{ calls: Array<{ callId: string }> }>("/calls/pending", {
      token: regB.data.token,
    });
    assert.equal(calleePendingAfter.status, 200);
    assert.equal(calleePendingAfter.data.calls.length, 0);
  } finally {
    calleeWs2.ws.close();
  }
});
