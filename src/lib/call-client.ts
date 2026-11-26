import type { IncomingCall, OutgoingCall, PublicAccount } from "./chat-store";
import { buildIceServers, formatCallError } from "./call-peer";

type Kind = IncomingCall["callType"];
type FacingMode = "user" | "environment";

export type CallSignalMessage = {
  fromUserId?: string;
  targetId?: string;
  callId: string;
  action:
    | "accepted"
    | "declined"
    | "ended"
    | "busy"
    | "offer"
    | "answer"
    | "ice-candidate"
    | "media-state";
  sdp?: RTCSessionDescriptionInit | null;
  candidate?: RTCIceCandidateInit | null;
  cameraEnabled?: boolean;
  micMuted?: boolean;
  reason?: string;
};

export type CallClientOptions = {
  getIceServers?: () => Promise<RTCIceServer[]>;
  sendSignal?: (event: string, payload: Record<string, unknown>) => Promise<boolean>;
};

type Session = {
  callId: string;
  kind: Kind;
  targetId: string;
  target?: PublicAccount | undefined;
  isCaller: boolean;
  answering: boolean;
  remoteAccepted: boolean;
  preparingMedia: boolean;
  peer?: RTCPeerConnection | undefined;
  local?: MediaStream | undefined;
  remote?: MediaStream | undefined;
  pendingCandidates: RTCIceCandidateInit[];
  pendingOffer?: RTCSessionDescriptionInit | null | undefined;
  streamVersion: number;
  micMuted: boolean;
  cameraEnabled: boolean;
  remoteMicMuted: boolean;
  remoteCameraEnabled: boolean;
  facingMode: FacingMode;
  canSwitchCamera: boolean;
  status: OutgoingCall["status"];
  timer?: ReturnType<typeof setTimeout> | undefined;
  reconnectTimer?: ReturnType<typeof setTimeout> | undefined;
};

async function detectCanSwitchCamera(kind: Kind): Promise<boolean> {
  if (kind !== "video" || typeof navigator === "undefined") return false;
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices?.();
    const videoInputs = devices?.filter((d) => d.kind === "videoinput") ?? [];
    if (videoInputs.length > 1) return true;
  } catch {
    // Some mobile browsers hide camera count until active stream
  }
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent ?? "");
}

function createSilentAudioStream(): MediaStream {
  try {
    const AudioCtx =
      typeof window !== "undefined"
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      return dest.stream;
    }
  } catch {
    /* ignore audio synthesis error */
  }
  return new MediaStream();
}

function getErrorName(err: unknown): string {
  return err && typeof err === "object" && "name" in err
    ? String((err as { name: unknown }).name)
    : "";
}

function isPermissionOrSecurityError(name: string): boolean {
  return name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError";
}

async function acquireInitialMedia(
  kind: Kind,
  facingMode: FacingMode,
  notify: (msg: string) => void,
): Promise<MediaStream> {
  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  const videoConstraints: MediaTrackConstraints | false =
    kind === "video"
      ? {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        }
      : false;

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: videoConstraints,
    });
  } catch (err) {
    const name = getErrorName(err);
    // Never mask explicit permission denial or insecure-context errors!
    if (isPermissionOrSecurityError(name)) {
      throw err;
    }

    if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: kind === "video",
        });
      } catch (relaxedErr) {
        if (isPermissionOrSecurityError(getErrorName(relaxedErr))) {
          throw relaxedErr;
        }
      }
    }

    // If video camera hardware is missing or busy in another app, allow audio-only fallback with a clear notice
    if (
      kind === "video" &&
      (name === "NotFoundError" ||
        name === "DevicesNotFoundError" ||
        name === "NotReadableError" ||
        name === "TrackStartError" ||
        name === "OverconstrainedError" ||
        name === "ConstraintNotSatisfiedError")
    ) {
      try {
        const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        notify("Camera unavailable — continuing with audio only.");
        return audioOnly;
      } catch (audioErr) {
        if (isPermissionOrSecurityError(getErrorName(audioErr))) {
          throw audioErr;
        }
      }
    }

    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      if (kind === "video") {
        try {
          const videoOnly = await navigator.mediaDevices.getUserMedia({ video: true });
          const silent = createSilentAudioStream();
          silent.getAudioTracks().forEach((t) => videoOnly.addTrack(t));
          notify("No microphone detected — you can listen and share video.");
          return videoOnly;
        } catch (vidErr) {
          if (isPermissionOrSecurityError(getErrorName(vidErr))) {
            throw vidErr;
          }
        }
      }
      const silent = createSilentAudioStream();
      if (silent.getAudioTracks().length > 0) {
        notify("No microphone detected — listen-only mode enabled.");
        return silent;
      }
    }
    throw err;
  }
}

export function createCallClient(
  sendWs: (event: string, payload: Record<string, unknown>) => boolean,
  profile: (id: string) => Promise<PublicAccount>,
  render: (value: { incomingCall: IncomingCall | null; outgoingCall: OutgoingCall | null }) => void,
  notify: (message: string) => void,
  waitForConnection: () => Promise<boolean>,
  options: CallClientOptions = {},
) {
  let current: Session | undefined;

  function emitSignal(event: string, payload: Record<string, unknown>): Promise<boolean> {
    if (sendWs(event, payload)) {
      return Promise.resolve(true);
    }
    if (options.sendSignal) {
      return options.sendSignal(event, payload).catch(() => false);
    }
    return Promise.resolve(false);
  }

  function display(s: Session) {
    if (current !== s || !s.target) return;
    const common = { callId: s.callId, callType: s.kind };
    if (!s.isCaller && !s.answering) {
      render({ incomingCall: { ...common, from: s.target }, outgoingCall: null });
    } else {
      render({
        incomingCall: null,
        outgoingCall: {
          ...common,
          target: s.target,
          status: s.status,
          stream: s.remote ?? null,
          localStream: s.local ?? null,
          streamVersion: s.streamVersion,
          micMuted: s.micMuted,
          cameraEnabled: s.cameraEnabled,
          remoteMicMuted: s.remoteMicMuted,
          remoteCameraEnabled: s.remoteCameraEnabled,
          facingMode: s.facingMode,
          canSwitchCamera: s.canSwitchCamera,
        },
      });
    }
  }

  function finish(s: Session, notifyRemoteAction?: "declined" | "ended", message?: string) {
    if (current !== s) return;
    current = undefined;
    clearTimeout(s.timer);
    clearTimeout(s.reconnectTimer);
    if (notifyRemoteAction) {
      void emitSignal("call:signal", {
        targetId: s.targetId,
        callId: s.callId,
        action: notifyRemoteAction,
      });
    }
    if (s.peer) {
      s.peer.ontrack = null;
      s.peer.onicecandidate = null;
      s.peer.onicecandidateerror = null;
      s.peer.onconnectionstatechange = null;
      s.peer.oniceconnectionstatechange = null;
      s.peer.onicegatheringstatechange = null;
      try {
        s.peer.close();
      } catch {
        // Ignore already-closed peer connection
      }
    }
    s.local?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // Ignore stopped track error
      }
    });
    s.remote?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // Ignore stopped track error
      }
    });
    s.local = undefined;
    s.remote = undefined;
    render({ incomingCall: null, outgoingCall: null });
    if (message) notify(message);
  }

  function timeout(s: Session, ms: number, message: string) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => finish(s, "ended", message), ms);
  }

  function sendMediaState(s: Session) {
    void emitSignal("call:signal", {
      targetId: s.targetId,
      callId: s.callId,
      action: "media-state",
      cameraEnabled: s.kind === "video" ? s.cameraEnabled : false,
      micMuted: s.micMuted,
    });
  }

  async function flushPendingCandidates(s: Session, pc: RTCPeerConnection) {
    if (!pc.remoteDescription) return;
    while (s.pendingCandidates.length > 0) {
      const next = s.pendingCandidates.shift();
      if (!next) continue;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(next));
      } catch {
        // Ignore late or duplicate ICE candidate
      }
    }
  }

  async function prepare(s: Session): Promise<RTCPeerConnection> {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof RTCPeerConnection === "undefined"
    ) {
      throw new Error("Calls require a secure HTTPS browser with microphone access.");
    }

    s.preparingMedia = true;
    try {
      const [local, fetchedIceServers] = await Promise.all([
        acquireInitialMedia(s.kind, s.facingMode, notify),
        options.getIceServers
          ? options.getIceServers().catch(() => buildIceServers())
          : Promise.resolve(buildIceServers()),
      ]);
      if (current !== s) {
        local.getTracks().forEach((t) => t.stop());
        throw new Error("Call ended.");
      }

      if (s.kind === "video" && local.getVideoTracks().length === 0) {
        s.cameraEnabled = false;
      }

      local.getAudioTracks().forEach((t) => {
        t.enabled = !s.micMuted;
      });
      local.getVideoTracks().forEach((t) => {
        t.enabled = s.cameraEnabled;
      });

      s.local = local;
      s.canSwitchCamera =
        local.getVideoTracks().length > 0 ? await detectCanSwitchCamera(s.kind) : false;
      if (current !== s) {
        local.getTracks().forEach((t) => t.stop());
        throw new Error("Call ended.");
      }

      const iceServers = fetchedIceServers.length > 0 ? fetchedIceServers : buildIceServers();
      const pc = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 4,
      });
      s.peer = pc;

      local.getTracks().forEach((t) => pc.addTrack(t, local));

      pc.onicecandidate = (event) => {
        if (current !== s || !event.candidate) return;
        void emitSignal("call:signal", {
          targetId: s.targetId,
          callId: s.callId,
          action: "ice-candidate",
          candidate: event.candidate.toJSON(),
        });
      };

      pc.onicecandidateerror = () => {
        // Individual STUN/TURN server timeout is non-fatal when another server succeeds
      };

      pc.ontrack = (event) => {
        if (current !== s) return;
        const incomingTracks = [...(event.streams[0]?.getTracks() ?? [])];
        if (event.track && !incomingTracks.some((t) => t.id === event.track.id)) {
          incomingTracks.push(event.track);
        }

        const existingTracks = s.remote ? s.remote.getTracks() : [];
        const merged = existingTracks.filter((t) => t.readyState !== "ended");
        for (const track of incomingTracks) {
          if (!merged.some((existing) => existing.id === track.id)) {
            merged.push(track);
            const bump = () => {
              if (current !== s) return;
              s.streamVersion += 1;
              display(s);
            };
            track.addEventListener("unmute", bump);
            track.addEventListener("mute", bump);
            track.addEventListener("ended", bump);
          }
        }
        s.remote = new MediaStream(merged);
        s.streamVersion += 1;
        display(s);
      };

      const syncConnectionState = () => {
        if (current !== s) return;
        const conn = pc.connectionState;
        const ice = pc.iceConnectionState;

        if (conn === "connected" || ice === "connected" || ice === "completed") {
          clearTimeout(s.timer);
          clearTimeout(s.reconnectTimer);
          s.reconnectTimer = undefined;
          if (s.status !== "accepted") {
            s.status = "accepted";
            display(s);
          }
          return;
        }

        if (conn === "failed" || ice === "failed") {
          finish(
            s,
            "ended",
            "Call could not connect across networks. A TURN relay server may be required on restricted mobile or Wi-Fi networks.",
          );
          return;
        }

        if (conn === "disconnected" || ice === "disconnected") {
          if (s.status === "accepted" || s.status === "connecting") {
            s.status = "reconnecting";
            display(s);
            if (!s.reconnectTimer) {
              s.reconnectTimer = setTimeout(() => {
                if (current === s && s.isCaller && s.peer) {
                  void s.peer
                    .createOffer({ iceRestart: true })
                    .then((offer) => s.peer!.setLocalDescription(offer).then(() => offer))
                    .then((offer) => {
                      if (current !== s) return;
                      void emitSignal("call:signal", {
                        targetId: s.targetId,
                        callId: s.callId,
                        action: "offer",
                        sdp: s.peer?.localDescription ?? offer,
                      });
                    })
                    .catch(() => {});
                }
              }, 2000);
            }
            timeout(s, 18000, "Call disconnected. Connection was lost.");
          }
        }
      };

      pc.onconnectionstatechange = syncConnectionState;
      pc.oniceconnectionstatechange = syncConnectionState;
      display(s);
      return pc;
    } finally {
      s.preparingMedia = false;
    }
  }

  async function applyOfferAndAnswer(
    s: Session,
    pc: RTCPeerConnection,
    sdp: RTCSessionDescriptionInit,
  ) {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await flushPendingCandidates(s, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (current !== s) return;
    await emitSignal("call:signal", {
      targetId: s.targetId,
      callId: s.callId,
      action: "answer",
      sdp: pc.localDescription ?? answer,
    });
    sendMediaState(s);
  }

  function failed(s: Session, err: unknown) {
    finish(s, "ended", formatCallError(err, s.kind));
  }

  const leave = () => {
    if (current) finish(current, "ended");
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", leave);
  }

  return {
    handleIncoming(payload: { callId: string; callType: Kind; from: PublicAccount }) {
      if (!payload?.callId || !payload.from?.id) return;
      if (current) {
        if (current.callId === payload.callId) return;
        // If the user is genuinely engaged in an active answered conversation, signal busy
        if (
          current.status === "accepted" &&
          current.peer &&
          (current.peer.connectionState === "connected" ||
            current.peer.iceConnectionState === "connected")
        ) {
          void emitSignal("call:signal", {
            targetId: payload.from.id,
            callId: payload.callId,
            action: "busy",
          });
          return;
        }
        // Otherwise, previous session was abandoned or ringing out; finish it cleanly
        finish(current, "ended");
      }

      const s: Session = {
        callId: payload.callId,
        kind: payload.callType === "video" ? "video" : "audio",
        targetId: payload.from.id,
        target: payload.from,
        isCaller: false,
        answering: false,
        remoteAccepted: false,
        preparingMedia: false,
        pendingCandidates: [],
        streamVersion: 0,
        micMuted: false,
        cameraEnabled: payload.callType === "video",
        remoteMicMuted: false,
        remoteCameraEnabled: payload.callType === "video",
        facingMode: "user",
        canSwitchCamera: false,
        status: "ringing",
      };
      current = s;
      timeout(s, 45000, "Missed call.");
      display(s);
    },

    handleRinging(payload: {
      callId: string;
      targetId: string;
      callType: Kind;
      recipientOnline: boolean;
    }) {
      const s = current;
      if (!s || s.callId !== payload.callId) return;
      s.status = "ringing";
      if (!payload.recipientOnline) {
        timeout(
          s,
          30000,
          `${s.target?.fullName ?? "User"} is not answering or unreachable right now.`,
        );
      } else {
        timeout(s, 45000, "No answer.");
      }
      display(s);
    },

    handleCallError(payload: { error?: string }) {
      const s = current;
      if (s) {
        finish(s, undefined, payload.error || "Call failed.");
      } else if (payload.error) {
        notify(payload.error);
      }
    },

    async handleSignal(payload: CallSignalMessage) {
      const s = current;
      if (!s || payload.callId !== s.callId) return;

      if (payload.action === "declined") {
        finish(s, undefined, "Call declined.");
        return;
      }
      if (payload.action === "busy") {
        finish(s, undefined, `${s.target?.fullName ?? "User"} is in another call.`);
        return;
      }
      if (payload.action === "ended") {
        finish(s, undefined, "Call ended.");
        return;
      }

      if (payload.action === "media-state") {
        if (typeof payload.cameraEnabled === "boolean") {
          s.remoteCameraEnabled = payload.cameraEnabled;
        }
        if (typeof payload.micMuted === "boolean") {
          s.remoteMicMuted = payload.micMuted;
        }
        s.streamVersion += 1;
        display(s);
        return;
      }

      if (payload.action === "accepted") {
        if (!s.isCaller || s.remoteAccepted) return;
        s.remoteAccepted = true;
        s.status = "connecting";
        display(s);
        timeout(s, 30000, "Call could not connect.");
        try {
          let waitTries = 0;
          while (!s.peer && s.preparingMedia && waitTries < 50 && current === s) {
            await new Promise((r) => setTimeout(r, 100));
            waitTries += 1;
          }
          const pc = s.peer;
          if (!pc || current !== s) return;
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: s.kind === "video",
          });
          await pc.setLocalDescription(offer);
          if (current !== s) return;
          await emitSignal("call:signal", {
            targetId: s.targetId,
            callId: s.callId,
            action: "offer",
            sdp: pc.localDescription ?? offer,
          });
          sendMediaState(s);
        } catch (err) {
          failed(s, err);
        }
        return;
      }

      if (payload.action === "offer" && payload.sdp) {
        if (!s.answering) return;
        if (!s.peer) {
          s.pendingOffer = payload.sdp;
          return;
        }
        try {
          await applyOfferAndAnswer(s, s.peer, payload.sdp);
        } catch (err) {
          failed(s, err);
        }
        return;
      }

      if (payload.action === "answer" && payload.sdp) {
        if (!s.peer) return;
        try {
          await s.peer.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          await flushPendingCandidates(s, s.peer);
        } catch (err) {
          failed(s, err);
        }
        return;
      }

      if (payload.action === "ice-candidate" && payload.candidate) {
        if (s.peer && s.peer.remoteDescription) {
          try {
            await s.peer.addIceCandidate(new RTCIceCandidate(payload.candidate));
          } catch {
            /* ignore duplicate or stale ICE */
          }
        } else {
          s.pendingCandidates.push(payload.candidate);
        }
      }
    },

    async dial(target: PublicAccount, kind: Kind) {
      if (current) {
        if (current.status !== "accepted") {
          finish(current, "ended");
        } else {
          throw new Error("Finish the current call first.");
        }
      }
      const callId = `call_${crypto.randomUUID().replace(/-/g, "")}`;
      const s: Session = {
        callId,
        kind,
        targetId: target.id,
        target,
        isCaller: true,
        answering: true,
        remoteAccepted: false,
        preparingMedia: false,
        pendingCandidates: [],
        streamVersion: 0,
        micMuted: false,
        cameraEnabled: kind === "video",
        remoteMicMuted: false,
        remoteCameraEnabled: kind === "video",
        facingMode: "user",
        canSwitchCamera: false,
        status: "preparing",
      };
      current = s;
      display(s);
      timeout(s, 45000, "No answer.");

      try {
        // Trigger realtime reconnect in background if needed, without blocking HTTP signal fallback
        void waitForConnection();
        await prepare(s);
        if (current !== s) return;
        const sent = await emitSignal("call:initiate", {
          callId: s.callId,
          targetId: target.id,
          callType: kind,
        });
        if (!sent) {
          throw new Error(
            "Could not reach the call signaling server. Check your connection and retry.",
          );
        }
        s.status = "ringing";
        display(s);
      } catch (err) {
        failed(s, err);
      }
    },

    async respond(id: string, action: "accepted" | "declined" | "ended") {
      const s = current;
      if (!s || id !== s.callId) return;
      if (action === "declined") {
        finish(s, "declined");
        return;
      }
      if (action === "ended") {
        finish(s, "ended");
        return;
      }
      if (s.answering) return;
      s.answering = true;
      s.status = "connecting";
      if (!s.target) {
        s.target = await profile(s.targetId).catch(() => undefined);
      }
      display(s);
      timeout(s, 30000, "Call could not connect.");

      try {
        const pc = await prepare(s);
        if (current !== s) return;
        const sent = await emitSignal("call:signal", {
          targetId: s.targetId,
          callId: s.callId,
          action: "accepted",
        });
        if (!sent) {
          throw new Error("Could not send call acceptance. Check your connection and retry.");
        }
        sendMediaState(s);
        if (s.pendingOffer) {
          const offer = s.pendingOffer;
          s.pendingOffer = null;
          await applyOfferAndAnswer(s, pc, offer);
        }
      } catch (err) {
        failed(s, err);
      }
    },

    setMicMuted(muted: boolean) {
      const s = current;
      if (!s) return;
      s.micMuted = muted;
      s.local?.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      s.peer?.getSenders().forEach((sender) => {
        if (sender.track?.kind === "audio") {
          sender.track.enabled = !muted;
        }
      });
      sendMediaState(s);
      display(s);
    },

    setCameraEnabled(enabled: boolean) {
      const s = current;
      if (!s || s.kind !== "video") return;
      s.cameraEnabled = enabled;
      s.local?.getVideoTracks().forEach((track) => {
        track.enabled = enabled;
      });
      s.peer?.getSenders().forEach((sender) => {
        if (sender.track?.kind === "video") {
          sender.track.enabled = enabled;
        }
      });
      s.streamVersion += 1;
      sendMediaState(s);
      display(s);
    },

    async switchCamera() {
      const s = current;
      if (!s || s.kind !== "video" || !s.peer) return;
      const nextFacing: FacingMode = s.facingMode === "user" ? "environment" : "user";

      const oldVideoTrack = s.local?.getVideoTracks()[0];
      const currentDeviceId = oldVideoTrack?.getSettings?.().deviceId;

      let nextStream: MediaStream | null = null;
      try {
        nextStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { exact: nextFacing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
      } catch {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices?.();
          const videoInputs = devices?.filter((d) => d.kind === "videoinput") ?? [];
          const otherCamera = videoInputs.find((d) => d.deviceId && d.deviceId !== currentDeviceId);
          if (otherCamera) {
            nextStream = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: otherCamera.deviceId } },
            });
          } else {
            nextStream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: { ideal: nextFacing } },
            });
          }
        } catch (err) {
          notify(formatCallError(err, "video"));
          return;
        }
      }

      const newVideoTrack = nextStream?.getVideoTracks()[0];
      if (!newVideoTrack || current !== s) {
        nextStream?.getTracks().forEach((t) => t.stop());
        return;
      }

      newVideoTrack.enabled = s.cameraEnabled;

      const videoSender = s.peer.getSenders().find((sender) => sender.track?.kind === "video");
      if (videoSender) {
        await videoSender.replaceTrack(newVideoTrack);
      } else if (s.local) {
        s.peer.addTrack(newVideoTrack, s.local);
      }

      const audioTracks = s.local?.getAudioTracks() ?? [];
      s.local?.getVideoTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // Ignore track stop errors
        }
      });

      s.local = new MediaStream([...audioTracks, newVideoTrack]);
      s.facingMode = nextFacing;
      s.streamVersion += 1;
      sendMediaState(s);
      display(s);
    },

    dispose() {
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", leave);
      }
      leave();
    },
  };
}
