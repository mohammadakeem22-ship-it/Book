const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
      "stun:stun.cloudflare.com:3478",
    ],
  },
];

type EnvLike = Record<string, unknown>;

function readDefaultEnv(): EnvLike {
  if (typeof import.meta !== "undefined" && (import.meta as { env?: EnvLike }).env) {
    return (import.meta as { env?: EnvLike }).env ?? {};
  }
  return {};
}

export function mergeIceServers(
  base: readonly RTCIceServer[],
  extra: readonly RTCIceServer[],
): RTCIceServer[] {
  const result: RTCIceServer[] = base.map((s) => ({
    ...s,
    urls: Array.isArray(s.urls) ? [...s.urls] : s.urls,
  }));
  const seenKeys = new Set(result.map((s) => `${JSON.stringify(s.urls)}|${s.username ?? ""}`));
  for (const item of extra) {
    if (!item || !item.urls) continue;
    const key = `${JSON.stringify(item.urls)}|${item.username ?? ""}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    result.push({
      ...item,
      urls: Array.isArray(item.urls) ? [...item.urls] : item.urls,
    });
  }
  return result;
}

export function buildIceServers(
  env: EnvLike = readDefaultEnv(),
  serverIceServers: readonly RTCIceServer[] = [],
): RTCIceServer[] {
  let servers: RTCIceServer[] = DEFAULT_STUN_SERVERS.map((s) => ({
    urls: Array.isArray(s.urls) ? [...s.urls] : s.urls,
  }));

  if (serverIceServers.length > 0) {
    servers = mergeIceServers(servers, serverIceServers);
  }

  const rawJson =
    typeof env["VITE_ICE_SERVERS_JSON"] === "string" ? env["VITE_ICE_SERVERS_JSON"].trim() : "";
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (Array.isArray(parsed)) {
        const extra: RTCIceServer[] = [];
        for (const item of parsed) {
          if (item && typeof item === "object" && "urls" in item && (item as RTCIceServer).urls) {
            extra.push(item as RTCIceServer);
          }
        }
        servers = mergeIceServers(servers, extra);
      }
    } catch {
      // Ignore malformed JSON and continue with STUN / TURN entries
    }
  }

  const rawTurnUrls =
    (typeof env["VITE_TURN_URLS"] === "string" ? env["VITE_TURN_URLS"] : "") ||
    (typeof env["VITE_TURN_URL"] === "string" ? env["VITE_TURN_URL"] : "");
  const turnUrls = rawTurnUrls
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.startsWith("turn:") || u.startsWith("turns:"));

  if (turnUrls.length > 0) {
    const username =
      typeof env["VITE_TURN_USERNAME"] === "string" ? env["VITE_TURN_USERNAME"].trim() : "";
    const credential =
      typeof env["VITE_TURN_CREDENTIAL"] === "string" ? env["VITE_TURN_CREDENTIAL"].trim() : "";
    const turnServer: RTCIceServer = { urls: turnUrls };
    if (username) turnServer.username = username;
    if (credential) turnServer.credential = credential;
    servers = mergeIceServers(servers, [turnServer]);
  }

  return servers;
}

export function formatCallError(err: unknown, callType: "audio" | "video"): string {
  const name =
    err &&
    typeof err === "object" &&
    "name" in err &&
    typeof (err as { name: unknown }).name === "string"
      ? (err as { name: string }).name
      : "";
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return callType === "video"
      ? "Microphone or camera permission was denied. Allow both in your browser or site settings and retry."
      : "Microphone permission was denied. Allow microphone access in your browser or site settings and retry.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return callType === "video"
      ? "No working microphone or camera was found on this device."
      : "No working microphone was found on this device.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return callType === "video"
      ? "Your camera or microphone is currently in use by another app or tab."
      : "Your microphone is currently in use by another app or tab.";
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "Your camera does not support the requested video settings.";
  }
  if (name === "SecurityError") {
    return "Calls require a secure HTTPS connection with microphone access.";
  }
  if (message) return message;
  return "Call failed. Please check your permissions and network connection.";
}

export async function gatherDescription(
  peer: RTCPeerConnection,
  type: "offer" | "answer",
  options: {
    hardTimeoutMs?: number;
    publicIdleMs?: number;
    hostIdleMs?: number;
  } = {},
) {
  const hardTimeoutMs = options.hardTimeoutMs ?? 2200;
  const publicIdleMs = options.publicIdleMs ?? 350;
  const hostIdleMs = options.hostIdleMs ?? 1200;

  await peer.setLocalDescription(
    type === "offer" ? await peer.createOffer() : await peer.createAnswer(),
  );
  // Send complete SDP quickly without waiting 4.5s on unresponsive STUN servers.
  if (peer.iceGatheringState !== "complete") {
    await new Promise<void>((resolve) => {
      let settled = false;
      let hasPublicCandidate = false;
      let hasHostCandidate = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        clearTimeout(idleTimer);
        peer.removeEventListener("icegatheringstatechange", changed);
        peer.removeEventListener("icecandidate", onCandidate);
        resolve();
      };

      const changed = () => {
        if (peer.iceGatheringState === "complete") finish();
      };

      const onCandidate = (event: RTCPeerConnectionIceEvent) => {
        const cand = event.candidate?.candidate ?? "";
        if (!cand) {
          finish();
          return;
        }
        if (/\btyp\s+(srflx|relay)\b/.test(cand)) {
          hasPublicCandidate = true;
          clearTimeout(idleTimer);
          idleTimer = setTimeout(finish, publicIdleMs);
          return;
        }
        if (!hasPublicCandidate && !hasHostCandidate) {
          hasHostCandidate = true;
          clearTimeout(idleTimer);
          idleTimer = setTimeout(finish, hostIdleMs);
        }
      };

      const hardTimer = setTimeout(finish, hardTimeoutMs);
      peer.addEventListener("icegatheringstatechange", changed);
      peer.addEventListener("icecandidate", onCandidate);
    });
  }
  const description = peer.localDescription?.sdp;
  if (!description || !description.includes("a=candidate:")) {
    throw new Error("No network route for this call. Check your connection or TURN configuration.");
  }
  return description;
}
