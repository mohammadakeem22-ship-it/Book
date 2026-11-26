import assert from "node:assert/strict";
import test from "node:test";

import { createCallClient } from "./call-client";
import type { PublicAccount } from "./chat-store";

class FakeTrack {
  kind: "audio" | "video";
  enabled = true;
  stopped = false;
  constructor(kind: "audio" | "video") {
    this.kind = kind;
  }
  stop() {
    this.stopped = true;
  }
  getSettings() {
    return {};
  }
}

class FakeMediaStream {
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  config: RTCConfiguration;
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  addedCandidates: RTCIceCandidateInit[] = [];
  closed = false;

  ontrack: ((ev: { streams?: FakeMediaStream[]; track?: FakeTrack }) => void) | null = null;
  onicecandidate: ((ev: { candidate: RTCIceCandidateInit | null }) => void) | null = null;
  onicecandidateerror: ((ev: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  private senders: Array<{ track: FakeTrack }> = [];

  constructor(config: RTCConfiguration) {
    this.config = config;
    FakeRTCPeerConnection.instances.push(this);
  }

  addTrack(track: FakeTrack) {
    this.senders.push({ track });
  }
  getSenders() {
    return this.senders;
  }
  async createOffer() {
    return { type: "offer" as const, sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" };
  }
  async createAnswer() {
    return { type: "answer" as const, sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" };
  }
  async setLocalDescription(desc: RTCSessionDescriptionInit) {
    this.localDescription = desc;
  }
  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    this.remoteDescription = desc;
  }
  async addIceCandidate(c: RTCIceCandidateInit) {
    this.addedCandidates.push(c);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.closed = true;
  }
}

function installWebRtcGlobals(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<FakeMediaStream>,
) {
  const g = globalThis as Record<string, unknown>;
  const prev = {
    RTCPeerConnection: g["RTCPeerConnection"],
    RTCSessionDescription: g["RTCSessionDescription"],
    RTCIceCandidate: g["RTCIceCandidate"],
    MediaStream: g["MediaStream"],
    navigator: g["navigator"],
  };

  FakeRTCPeerConnection.instances = [];
  g["RTCPeerConnection"] = FakeRTCPeerConnection;
  g["RTCSessionDescription"] = class {
    type: RTCSdpType;
    sdp: string;
    constructor(init: RTCSessionDescriptionInit) {
      this.type = init.type!;
      this.sdp = init.sdp ?? "";
    }
  };
  g["RTCIceCandidate"] = class {
    candidate: string;
    constructor(init: RTCIceCandidateInit) {
      this.candidate = init.candidate ?? "";
    }
  };
  g["MediaStream"] = FakeMediaStream;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "node-test",
      mediaDevices: {
        getUserMedia,
        enumerateDevices: async () => [],
      },
    },
  });

  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete g[k];
      else Object.defineProperty(globalThis, k, { configurable: true, value: v });
    }
  };
}

const samplePeer: PublicAccount = {
  id: "user_peer_1",
  fullName: "Peer Reader",
  displayHandle: "@peer_reader",
  bio: "",
  avatarUrl: null,
  theme: "instagram",
  phoneVerified: true,
  lastActiveAt: new Date().toISOString(),
  online: true,
};

test("call-client fetches TURN/ICE config, dials via HTTP fallback when WS closed, completes offer/answer/ICE, and connects", async () => {
  const restore = installWebRtcGlobals(async (constraints) => {
    const tracks = [new FakeTrack("audio")];
    if (constraints.video) tracks.push(new FakeTrack("video"));
    return new FakeMediaStream(tracks);
  });

  try {
    const sentHttp: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const states: Array<{
      incomingCall: unknown;
      outgoingCall: { status?: string; cameraEnabled?: boolean } | null;
    }> = [];
    const notices: string[] = [];

    const client = createCallClient(
      () => false,
      async () => samplePeer,
      (v) => states.push(v as (typeof states)[number]),
      (msg) => notices.push(msg),
      async () => false,
      {
        getIceServers: async () => [
          { urls: "turn:turn.example.com:3478", username: "temp", credential: "hmac" },
        ],
        sendSignal: async (event, payload) => {
          sentHttp.push({ event, payload });
          return true;
        },
      },
    );

    await client.dial(samplePeer, "video");
    const callInit = sentHttp.find((s) => s.event === "call:initiate");
    assert.ok(callInit, "expected call:initiate via HTTP fallback when WS unavailable");
    const callId = String(callInit.payload["callId"]);
    assert.equal(FakeRTCPeerConnection.instances.length, 1);
    const pc = FakeRTCPeerConnection.instances[0]!;
    assert.ok(
      pc.config.iceServers?.some((s) => s.urls === "turn:turn.example.com:3478"),
      "expected TURN server configured on RTCPeerConnection",
    );

    client.handleRinging({
      callId,
      targetId: samplePeer.id,
      callType: "video",
      recipientOnline: true,
    });

    // Buffered ICE before remote answer should wait until remoteDescription arrives
    await client.handleSignal({
      callId,
      action: "ice-candidate",
      candidate: { candidate: "candidate:relay 1 udp 16777215 198.51.100.2 54321 typ relay" },
    });
    assert.equal(pc.addedCandidates.length, 0);

    await client.handleSignal({ callId, action: "accepted" });
    const offerSignal = sentHttp.find(
      (s) => s.event === "call:signal" && s.payload["action"] === "offer",
    );
    assert.ok(offerSignal, "expected SDP offer emitted after callee accepted");

    await client.handleSignal({
      callId,
      action: "answer",
      sdp: { type: "answer", sdp: "v=0" },
    });
    assert.equal(
      pc.addedCandidates.length,
      1,
      "expected pre-answer ICE candidate flushed after answer",
    );

    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    assert.equal(states[states.length - 1]?.outgoingCall?.status, "accepted");

    await client.respond(callId, "ended");
    assert.equal(pc.closed, true);
    assert.equal(notices.length, 0);
  } finally {
    restore();
  }
});

test("call-client preserves NotAllowedError permission failure and never hides it behind audio fallback", async () => {
  const restore = installWebRtcGlobals(async () => {
    throw Object.assign(new Error("Permission dismissed"), { name: "NotAllowedError" });
  });

  try {
    const notices: string[] = [];
    const sent: string[] = [];
    const client = createCallClient(
      (ev) => {
        sent.push(ev);
        return true;
      },
      async () => samplePeer,
      () => {},
      (msg) => notices.push(msg),
      async () => true,
    );

    await client.dial(samplePeer, "video");
    assert.equal(sent.includes("call:initiate"), false);
    assert.match(notices[0] ?? "", /Microphone or camera permission was denied/i);
  } finally {
    restore();
  }
});

test("call-client updates cameraEnabled=false when video hardware is missing and audio fallback succeeds", async () => {
  const restore = installWebRtcGlobals(async (constraints) => {
    if (constraints.video) {
      throw Object.assign(new Error("Camera not found"), { name: "NotFoundError" });
    }
    return new FakeMediaStream([new FakeTrack("audio")]);
  });

  try {
    const notices: string[] = [];
    const states: Array<{ outgoingCall: { cameraEnabled?: boolean; status?: string } | null }> = [];
    const client = createCallClient(
      () => true,
      async () => samplePeer,
      (v) => states.push(v as (typeof states)[number]),
      (msg) => notices.push(msg),
      async () => true,
    );

    await client.dial(samplePeer, "video");
    assert.match(notices[0] ?? "", /audio only/i);
    assert.equal(states[states.length - 1]?.outgoingCall?.cameraEnabled, false);
    assert.equal(states[states.length - 1]?.outgoingCall?.status, "ringing");
    client.dispose();
  } finally {
    restore();
  }
});

test("call-client terminates cleanly with clear message when ICE connection fails", async () => {
  const restore = installWebRtcGlobals(async () => new FakeMediaStream([new FakeTrack("audio")]));

  try {
    const notices: string[] = [];
    const states: Array<{ outgoingCall: unknown }> = [];
    const client = createCallClient(
      () => true,
      async () => samplePeer,
      (v) => states.push(v as { outgoingCall: unknown }),
      (msg) => notices.push(msg),
      async () => true,
      { getIceServers: async () => [{ urls: "stun:stun.l.google.com:19302" }] },
    );

    await client.dial(samplePeer, "audio");
    const pc = FakeRTCPeerConnection.instances[0]!;
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();

    assert.equal(pc.closed, true);
    assert.equal(states[states.length - 1]?.outgoingCall, null);
    assert.match(
      notices[notices.length - 1] ?? "",
      /could not connect across networks|TURN relay server/i,
    );
  } finally {
    restore();
  }
});
