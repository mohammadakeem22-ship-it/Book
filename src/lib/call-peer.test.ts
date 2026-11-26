import assert from "node:assert/strict";
import test from "node:test";

import { buildIceServers, formatCallError, gatherDescription, mergeIceServers } from "./call-peer";

test("buildIceServers always includes default fast STUN servers", () => {
  const servers = buildIceServers({});
  assert.ok(servers.length >= 1);
  const firstUrls = Array.isArray(servers[0]?.urls) ? servers[0].urls : [servers[0]?.urls];
  assert.ok(firstUrls.some((u) => String(u).includes("stun:stun.l.google.com:19302")));
});

test("buildIceServers merges server-fetched ephemeral TURN servers and avoids duplicates", () => {
  const serverTurn: RTCIceServer[] = [
    {
      urls: [
        "turn:turn.example.com:3478?transport=udp",
        "turns:turn.example.com:5349?transport=tcp",
      ],
      username: "1799999999:user_1",
      credential: "ephemeral-hmac-token",
    },
  ];
  const merged = buildIceServers({}, serverTurn);
  const turnEntry = merged.find((s) => s.username === "1799999999:user_1");
  assert.ok(turnEntry);
  assert.equal(turnEntry.credential, "ephemeral-hmac-token");

  const deduped = mergeIceServers(merged, serverTurn);
  assert.equal(deduped.filter((s) => s.username === "1799999999:user_1").length, 1);
});

test("buildIceServers appends configured TURN servers and ignores malformed JSON", () => {
  const servers = buildIceServers({
    VITE_TURN_URLS: "turn:turn.example.com:3478, turns:turn.example.com:5349 ",
    VITE_TURN_USERNAME: "rc-user",
    VITE_TURN_CREDENTIAL: "rc-pass",
    VITE_ICE_SERVERS_JSON: "{bad-json",
  });
  const turn = servers.find((s) =>
    (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => String(u).startsWith("turn:")),
  );
  assert.ok(turn);
  assert.deepEqual(turn.urls, ["turn:turn.example.com:3478", "turns:turn.example.com:5349"]);
  assert.equal(turn.username, "rc-user");
  assert.equal(turn.credential, "rc-pass");
});

test("buildIceServers parses valid VITE_ICE_SERVERS_JSON entries", () => {
  const servers = buildIceServers({
    VITE_ICE_SERVERS_JSON: JSON.stringify([
      { urls: "turns:relay.example.org:443", username: "a", credential: "b" },
    ]),
  });
  assert.ok(servers.some((s) => s.urls === "turns:relay.example.org:443"));
});

test("gatherDescription settles quickly when server-reflexive/relay ICE candidate arrives instead of waiting 4.5s", async () => {
  let gatherHandler: ((ev: { candidate: { candidate: string } | null }) => void) | null = null;
  let stateHandler: (() => void) | null = null;
  const fakePeer = {
    iceGatheringState: "gathering" as RTCIceGatheringState,
    localDescription: { type: "offer", sdp: "v=0" } as RTCSessionDescription,
    async createOffer() {
      return { type: "offer" as const, sdp: "v=0" };
    },
    async createAnswer() {
      return { type: "answer" as const, sdp: "v=0" };
    },
    async setLocalDescription(desc: RTCSessionDescriptionInit) {
      this.localDescription = desc as RTCSessionDescription;
    },
    addEventListener(event: string, fn: (...args: unknown[]) => void) {
      if (event === "icecandidate") gatherHandler = fn as typeof gatherHandler;
      if (event === "icegatheringstatechange") stateHandler = fn as typeof stateHandler;
    },
    removeEventListener() {},
  } as unknown as RTCPeerConnection;

  const start = Date.now();
  setTimeout(() => {
    fakePeer.localDescription = {
      type: "offer",
      sdp: "v=0\r\na=candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host\r\n",
    } as RTCSessionDescription;
    gatherHandler?.({
      candidate: { candidate: "candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host" },
    });
    gatherHandler?.({
      candidate: { candidate: "candidate:2 1 udp 1686052607 203.0.113.5 50001 typ srflx" },
    });
  }, 20);

  const desc = await gatherDescription(fakePeer, "offer", {
    hardTimeoutMs: 2200,
    publicIdleMs: 80,
    hostIdleMs: 500,
  });
  const elapsed = Date.now() - start;
  assert.match(desc, /a=candidate:/);
  assert.ok(elapsed < 600, `Expected gatherDescription to settle <600ms, got ${elapsed}ms`);
  void stateHandler;
});

test("formatCallError returns actionable user messages for media DOMExceptions", () => {
  const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
  assert.match(formatCallError(denied, "audio"), /Microphone permission was denied/i);
  assert.match(formatCallError(denied, "video"), /Microphone or camera permission was denied/i);

  const busy = Object.assign(new Error("Could not start video source"), {
    name: "NotReadableError",
  });
  assert.match(formatCallError(busy, "video"), /currently in use/i);

  const missing = Object.assign(new Error("Requested device not found"), { name: "NotFoundError" });
  assert.match(formatCallError(missing, "audio"), /No working microphone/i);

  const sec = Object.assign(new Error("Insecure origin"), { name: "SecurityError" });
  assert.match(formatCallError(sec, "audio"), /secure HTTPS/i);

  const overconstrained = Object.assign(new Error("Constraint failed"), {
    name: "OverconstrainedError",
  });
  assert.match(formatCallError(overconstrained, "video"), /requested video settings/i);
});
