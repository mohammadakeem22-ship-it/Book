import crypto from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Response } from "express";
import { WebSocket, WebSocketServer } from "ws";

import {
  createNfcTokenForUser,
  db,
  getAdminEmailSet,
  isBlockedBetween,
  normalizeEmail,
  sha256,
  threadKeyFor,
  toPublicUser,
  verifyCookieToken,
  type DbUser,
} from "./db";
import { getFirebaseAdminAuth } from "./firebase-admin";

type ClientSocket = WebSocket & {
  userId?: string;
  isAlive?: boolean;
  activePeerId?: string | null;
};

type SseClient = {
  res: Response;
  userId: string;
  activePeerId: string | null;
  heartbeatTimer: ReturnType<typeof setInterval>;
};

type ActiveCall = {
  callId: string;
  peerId: string;
  createdAt: number;
  answered?: boolean;
};

type PendingCallOffer = {
  callId: string;
  callType: "audio" | "video";
  caller: DbUser;
  targetId: string;
  createdAt: number;
};

type BufferedSignal = {
  payload: Record<string, unknown>;
  createdAt: number;
};

const CALL_TTL_MS = 45_000;
const ANSWERED_CALL_TTL_MS = 4 * 60 * 60 * 1000;
const SIGNAL_BUFFER_TTL_MS = 60_000;
const DISCONNECT_GRACE_MS = 12_000;

const userSockets = new Map<string, Set<ClientSocket>>();
const userSseClients = new Map<string, Set<SseClient>>();
const activeCallPeers = new Map<string, ActiveCall>();
const pendingCallOffers = new Map<string, PendingCallOffer>();
const pendingSignalsByUser = new Map<string, BufferedSignal[]>();
const disconnectCallTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function pruneStaleCalls() {
  const now = Date.now();
  for (const [key, call] of activeCallPeers.entries()) {
    const maxAge = call.answered ? ANSWERED_CALL_TTL_MS : CALL_TTL_MS;
    if (now - call.createdAt > maxAge) {
      activeCallPeers.delete(key);
    }
  }
  for (const [key, pending] of pendingCallOffers.entries()) {
    if (now - pending.createdAt > CALL_TTL_MS) {
      pendingCallOffers.delete(key);
    }
  }
  for (const [key, list] of pendingSignalsByUser.entries()) {
    const fresh = list.filter((item) => now - item.createdAt <= SIGNAL_BUFFER_TTL_MS);
    if (fresh.length === 0) {
      pendingSignalsByUser.delete(key);
    } else if (fresh.length !== list.length) {
      pendingSignalsByUser.set(key, fresh);
    }
  }
}

export function getUserAliases(userId: string): string[] {
  if (!userId) return [];
  const list = [userId];
  if (userId.startsWith("fb_")) {
    const raw = userId.slice(3);
    if (raw && !list.includes(raw)) list.push(raw);
  } else {
    const fbKey = `fb_${userId}`;
    if (!list.includes(fbKey)) list.push(fbKey);
  }
  return list;
}

export function isUserConnected(userId: string): boolean {
  for (const alias of getUserAliases(userId)) {
    const set = userSockets.get(alias);
    if (set) {
      for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) return true;
      }
    }
    const sseSet = userSseClients.get(alias);
    if (sseSet && sseSet.size > 0) {
      return true;
    }
  }
  return false;
}

export function isUserViewingThread(userId: string, peerId: string): boolean {
  const peerAliases = new Set(getUserAliases(peerId));
  for (const alias of getUserAliases(userId)) {
    const set = userSockets.get(alias);
    if (set) {
      for (const ws of set) {
        if (
          ws.readyState === WebSocket.OPEN &&
          ws.activePeerId &&
          peerAliases.has(ws.activePeerId)
        ) {
          return true;
        }
      }
    }
    const sseSet = userSseClients.get(alias);
    if (sseSet) {
      for (const client of sseSet) {
        if (client.activePeerId && peerAliases.has(client.activePeerId)) {
          return true;
        }
      }
    }
  }
  return false;
}

export function setSseActiveThread(userId: string, peerId: string | null) {
  for (const alias of getUserAliases(userId)) {
    const sseSet = userSseClients.get(alias);
    if (!sseSet) continue;
    for (const client of sseSet) {
      client.activePeerId = peerId;
    }
  }
}

export function sendToUser(userId: string, event: string, payload: unknown): boolean {
  const serialized = JSON.stringify({ event, payload });
  let delivered = false;

  const sentSockets = new Set<ClientSocket>();
  for (const alias of getUserAliases(userId)) {
    const set = userSockets.get(alias);
    if (!set) continue;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN && !sentSockets.has(ws)) {
        sentSockets.add(ws);
        ws.send(serialized);
        delivered = true;
      }
    }
  }

  const sentSse = new Set<SseClient>();
  const sseFrame = `event: message\ndata: ${serialized}\n\n`;
  for (const alias of getUserAliases(userId)) {
    const sseSet = userSseClients.get(alias);
    if (!sseSet) continue;
    for (const client of sseSet) {
      if (!sentSse.has(client) && !client.res.writableEnded) {
        sentSse.add(client);
        try {
          client.res.write(sseFrame);
          delivered = true;
        } catch {
          // Ignore broken pipe; close handler cleans it up
        }
      }
    }
  }

  return delivered;
}

export function broadcastEvent(event: string, payload: unknown, excludeUserId?: string) {
  const excludedAliases = excludeUserId ? new Set(getUserAliases(excludeUserId)) : null;
  const serialized = JSON.stringify({ event, payload });

  const sentSockets = new Set<ClientSocket>();
  for (const [connectedUserId, set] of userSockets.entries()) {
    if (excludedAliases?.has(connectedUserId)) continue;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN && !sentSockets.has(ws)) {
        sentSockets.add(ws);
        ws.send(serialized);
      }
    }
  }

  const sseFrame = `event: message\ndata: ${serialized}\n\n`;
  const sentSse = new Set<SseClient>();
  for (const [connectedUserId, sseSet] of userSseClients.entries()) {
    if (excludedAliases?.has(connectedUserId)) continue;
    for (const client of sseSet) {
      if (!sentSse.has(client) && !client.res.writableEnded) {
        sentSse.add(client);
        try {
          client.res.write(sseFrame);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function parseCookieValue(req: IncomingMessage, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      const val = decodeURIComponent(rest.join("=")).trim();
      if (val) return val;
    }
  }
  return null;
}

function parseAuthTokensFromRequest(req: IncomingMessage): {
  sessionToken: string | null;
  firebaseToken: string | null;
  fbCookie: string | null;
} {
  const url = new URL(req.url ?? "/", "http://localhost");
  const queryToken = url.searchParams.get("token")?.trim() || null;
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  const sessionToken =
    (queryToken && queryToken.startsWith("rc_sess_") ? queryToken : null) ||
    (bearerToken && bearerToken.startsWith("rc_sess_") ? bearerToken : null) ||
    parseCookieValue(req, "rc_session");

  const firebaseToken =
    (bearerToken && !bearerToken.startsWith("rc_sess_") ? bearerToken : null) ||
    (queryToken && !queryToken.startsWith("rc_sess_") ? queryToken : null);

  const fbCookie = parseCookieValue(req, "rc_fb_session");
  return { sessionToken, firebaseToken, fbCookie };
}

export async function resolveUserFromRequest(req: IncomingMessage): Promise<DbUser | null> {
  const { sessionToken, firebaseToken, fbCookie } = parseAuthTokensFromRequest(req);
  const now = new Date().toISOString();

  if (sessionToken) {
    const row = (await db
      .prepare(
        `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?
         LIMIT 1`,
      )
      .get(sha256(sessionToken), now)) as DbUser | undefined;
    if (row) return row;
  }

  if (fbCookie) {
    const verified = verifyCookieToken(fbCookie);
    if (verified?.uid) {
      const fbRow = (await db
        .prepare("SELECT * FROM users WHERE id = ? OR id = ? LIMIT 1")
        .get(`fb_${verified.uid}`, verified.uid)) as DbUser | undefined;
      if (fbRow) return fbRow;
    }
  }

  if (firebaseToken) {
    try {
      const decoded = await getFirebaseAdminAuth().verifyIdToken(firebaseToken);
      if (decoded?.uid) {
        const fbRow = (await db
          .prepare("SELECT * FROM users WHERE id = ? OR id = ? LIMIT 1")
          .get(`fb_${decoded.uid}`, decoded.uid)) as DbUser | undefined;
        if (fbRow) return fbRow;

        const cleanEmail = decoded.email ? normalizeEmail(decoded.email) : null;
        if (decoded.email_verified && cleanEmail) {
          const emailRow = (await db
            .prepare(
              "SELECT * FROM users WHERE email_verified = 1 AND LOWER(email) = LOWER(?) LIMIT 1",
            )
            .get(cleanEmail)) as DbUser | undefined;
          if (emailRow) return emailRow;
        }

        // Auto-provision user if verified Firebase token connects before initial sync
        const fbUserId = `fb_${decoded.uid}`;
        const rawName = String(
          (decoded as { name?: string }).name ||
            (cleanEmail ? cleanEmail.split("@")[0] : "") ||
            "Reader",
        )
          .trim()
          .slice(0, 60);
        const fullName = rawName.length >= 2 ? rawName : `${rawName} Reader`.slice(0, 60);
        const slug = fullName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "")
          .slice(0, 14);
        const displayHandle = `@${slug || "reader"}.${crypto.randomBytes(2).toString("hex")}`;
        const role =
          decoded.email_verified && cleanEmail && getAdminEmailSet().has(cleanEmail)
            ? "admin"
            : "user";
        const externalAvatar =
          typeof decoded.picture === "string" && decoded.picture.startsWith("https://")
            ? decoded.picture.slice(0, 1024)
            : null;

        await db
          .prepare(
            `INSERT INTO users (id, email, email_verified, phone_e164, phone_verified, role, full_name, display_handle, bio, avatar_media_id, avatar_external_url, password_hash, theme, created_at, last_active_at)
             VALUES (?, ?, ?, NULL, 0, ?, ?, ?, '', NULL, ?, ?, 'instagram', ?, ?)
             ON CONFLICT DO NOTHING`,
          )
          .run(
            fbUserId,
            cleanEmail,
            decoded.email_verified ? 1 : 0,
            role,
            fullName,
            displayHandle,
            externalAvatar,
            sha256(crypto.randomBytes(24).toString("hex")),
            now,
            now,
          );
        await createNfcTokenForUser(fbUserId);
        const createdUser = (await db
          .prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
          .get(fbUserId)) as DbUser | undefined;
        if (createdUser) return createdUser;
      }
    } catch {
      /* invalid firebase token */
    }
  }

  return null;
}

export async function broadcastPresence(userId: string, online: boolean) {
  const now = new Date().toISOString();
  await db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(now, userId);

  const connectedKeys = new Set<string>([...userSockets.keys(), ...userSseClients.keys()]);
  for (const connectedUserId of connectedKeys) {
    if (connectedUserId !== userId && !(await isBlockedBetween(userId, connectedUserId))) {
      sendToUser(connectedUserId, "presence:update", { userId, online, lastActiveAt: now });
    }
  }
}

export async function markPendingDeliveredForUser(userId: string) {
  const now = new Date().toISOString();
  const pendingSenders = (await db
    .prepare(
      "SELECT DISTINCT sender_id FROM messages WHERE recipient_id = ? AND delivered_at IS NULL",
    )
    .all(userId)) as { sender_id: string }[];

  if (pendingSenders.length === 0) return;

  await db
    .prepare("UPDATE messages SET delivered_at = ? WHERE recipient_id = ? AND delivered_at IS NULL")
    .run(now, userId);

  for (const { sender_id } of pendingSenders) {
    if (!(await isBlockedBetween(userId, sender_id))) {
      sendToUser(sender_id, "messages:delivered", {
        byUserId: userId,
        peerId: userId,
        deliveredAt: now,
      });
    }
  }
}

function bufferSignalForUser(userId: string, payload: Record<string, unknown>) {
  const now = Date.now();
  for (const alias of getUserAliases(userId)) {
    const existing = pendingSignalsByUser.get(alias) ?? [];
    const next = existing.filter((item) => now - item.createdAt <= SIGNAL_BUFFER_TTL_MS);
    next.push({ payload, createdAt: now });
    if (next.length > 60) {
      next.splice(0, next.length - 60);
    }
    pendingSignalsByUser.set(alias, next);
  }
}

function clearBufferedSignalsForUser(userId: string) {
  for (const alias of getUserAliases(userId)) {
    pendingSignalsByUser.delete(alias);
  }
}

function cancelDisconnectGraceTimers(userId: string) {
  for (const alias of getUserAliases(userId)) {
    const timer = disconnectCallTimers.get(alias);
    if (timer) {
      clearTimeout(timer);
      disconnectCallTimers.delete(alias);
    }
  }
}

function scheduleDisconnectCleanup(userId: string) {
  const aliases = getUserAliases(userId);
  cancelDisconnectGraceTimers(userId);

  const timer = setTimeout(() => {
    for (const alias of aliases) {
      disconnectCallTimers.delete(alias);
    }
    if (isUserConnected(userId)) return;

    for (const alias of aliases) {
      const activeCall = activeCallPeers.get(alias);
      if (activeCall) {
        activeCallPeers.delete(alias);
        const peerAliases = getUserAliases(activeCall.peerId);
        for (const pAlias of peerAliases) {
          const peerActive = activeCallPeers.get(pAlias);
          if (
            peerActive &&
            (peerActive.callId === activeCall.callId ||
              peerActive.peerId === userId ||
              aliases.includes(peerActive.peerId))
          ) {
            activeCallPeers.delete(pAlias);
          }
        }
        sendToUser(activeCall.peerId, "call:signal", {
          fromUserId: userId,
          callId: activeCall.callId,
          action: "ended",
          sdp: null,
          candidate: null,
        });
      }
      pendingCallOffers.delete(alias);
    }
    void broadcastPresence(userId, false);
  }, DISCONNECT_GRACE_MS);

  timer.unref();
  for (const alias of aliases) {
    disconnectCallTimers.set(alias, timer);
  }
}

function deliverPendingForUser(userId: string) {
  pruneStaleCalls();
  cancelDisconnectGraceTimers(userId);
  const aliases = getUserAliases(userId);

  for (const alias of aliases) {
    const pending = pendingCallOffers.get(alias);
    if (pending && Date.now() - pending.createdAt < CALL_TTL_MS) {
      pendingCallOffers.delete(alias);
      void toPublicUser(pending.caller, true, alias).then((fromPub) => {
        sendToUser(alias, "call:incoming", {
          callId: pending.callId,
          callType: pending.callType,
          from: fromPub,
        });
        sendToUser(pending.caller.id, "call:ringing", {
          callId: pending.callId,
          targetId: alias,
          callType: pending.callType,
          recipientOnline: true,
        });
      });
    }
  }

  // Replay buffered call signals (e.g. accepted/offer/answer/ice) if peer missed them during a brief reconnect
  const replayed = new Set<string>();
  for (const alias of aliases) {
    const buffered = pendingSignalsByUser.get(alias);
    if (!buffered || buffered.length === 0) continue;
    pendingSignalsByUser.delete(alias);
    for (const item of buffered) {
      const key = `${String(item.payload["callId"] ?? "")}:${String(item.payload["action"] ?? "")}:${JSON.stringify(item.payload["candidate"] ?? item.payload["sdp"] ?? "")}`;
      if (replayed.has(key)) continue;
      replayed.add(key);
      sendToUser(userId, "call:signal", item.payload);
    }
  }
}

export async function initiateCallSession(input: {
  callerId: string;
  targetId: string;
  callId?: string;
  callType?: "audio" | "video";
}): Promise<
  | {
      ok: true;
      callId: string;
      targetId: string;
      callType: "audio" | "video";
      recipientOnline: boolean;
      busy?: boolean;
    }
  | { ok: false; status: number; error: string }
> {
  pruneStaleCalls();
  const rawTarget = input.targetId.trim();
  const callType = input.callType === "video" ? "video" : "audio";
  if (!rawTarget) {
    return { ok: false, status: 400, error: "Valid recipient required." };
  }

  const targetAliases = getUserAliases(rawTarget);
  const callerAliases = getUserAliases(input.callerId);
  if (targetAliases.some((t) => callerAliases.includes(t))) {
    return { ok: false, status: 400, error: "Cannot call yourself." };
  }

  const callerPlaceholders = callerAliases.map(() => "?").join(",");
  const targetPlaceholders = targetAliases.map(() => "?").join(",");

  const caller = (await db
    .prepare(`SELECT * FROM users WHERE id IN (${callerPlaceholders}) LIMIT 1`)
    .get(...callerAliases)) as DbUser | undefined;
  let target = (await db
    .prepare(`SELECT * FROM users WHERE id IN (${targetPlaceholders}) LIMIT 1`)
    .get(...targetAliases)) as DbUser | undefined;

  if (!target) {
    target = (await db
      .prepare(
        `SELECT * FROM users WHERE LOWER(display_handle) = LOWER(?) OR LOWER(email) = LOWER(?) LIMIT 1`,
      )
      .get(rawTarget, rawTarget)) as DbUser | undefined;
  }

  if (!caller || !target) {
    return { ok: false, status: 404, error: "Recipient account not found." };
  }

  if (await isBlockedBetween(caller.id, target.id)) {
    return { ok: false, status: 403, error: "Cannot initiate call. This user is blocked." };
  }

  const rawCallId = (input.callId ?? "").trim();
  const callId =
    rawCallId && /^[a-zA-Z0-9_-]{4,64}$/.test(rawCallId)
      ? rawCallId
      : `call_${crypto.randomUUID().replace(/-/g, "")}`;

  const canonicalCallerId = caller.id;
  const canonicalTargetId = target.id;
  const recipientOnline = isUserConnected(canonicalTargetId);

  let existingTargetCall: ActiveCall | undefined;
  for (const tAlias of getUserAliases(canonicalTargetId)) {
    const hit = activeCallPeers.get(tAlias);
    if (hit) {
      if (Date.now() - hit.createdAt > (hit.answered ? ANSWERED_CALL_TTL_MS : CALL_TTL_MS)) {
        activeCallPeers.delete(tAlias);
      } else {
        existingTargetCall = hit;
        break;
      }
    }
  }

  const isSameCaller =
    existingTargetCall &&
    (existingTargetCall.peerId === canonicalCallerId ||
      getUserAliases(canonicalCallerId).includes(existingTargetCall.peerId));

  if (
    existingTargetCall &&
    existingTargetCall.callId !== callId &&
    !isSameCaller &&
    existingTargetCall.answered
  ) {
    sendToUser(canonicalCallerId, "call:signal", {
      fromUserId: canonicalTargetId,
      callId,
      action: "busy",
      sdp: null,
      candidate: null,
    });
    return {
      ok: true,
      callId,
      targetId: canonicalTargetId,
      callType,
      recipientOnline,
      busy: true,
    };
  }

  const nowTs = Date.now();
  clearBufferedSignalsForUser(canonicalTargetId);
  for (const cAlias of getUserAliases(canonicalCallerId)) {
    activeCallPeers.set(cAlias, {
      callId,
      peerId: canonicalTargetId,
      createdAt: nowTs,
      answered: false,
    });
  }
  for (const tAlias of getUserAliases(canonicalTargetId)) {
    activeCallPeers.set(tAlias, {
      callId,
      peerId: canonicalCallerId,
      createdAt: nowTs,
      answered: false,
    });
    pendingCallOffers.set(tAlias, {
      callId,
      callType,
      caller,
      targetId: canonicalTargetId,
      createdAt: nowTs,
    });
  }

  const callPayload = {
    callId,
    callType,
    from: await toPublicUser(caller, true, canonicalTargetId),
  };

  const deliveredIncoming = sendToUser(canonicalTargetId, "call:incoming", callPayload);
  if (deliveredIncoming) {
    for (const tAlias of getUserAliases(canonicalTargetId)) {
      pendingCallOffers.delete(tAlias);
    }
  }

  sendToUser(canonicalCallerId, "call:ringing", {
    callId,
    targetId: canonicalTargetId,
    callType,
    recipientOnline,
  });

  return {
    ok: true,
    callId,
    targetId: canonicalTargetId,
    callType,
    recipientOnline,
  };
}

export async function forwardCallSignal(input: {
  userId: string;
  targetId: string;
  callId: string;
  action: string;
  sdp?: unknown;
  candidate?: unknown;
  cameraEnabled?: boolean;
  micMuted?: boolean;
  reason?: string;
}): Promise<{ ok: boolean; delivered: boolean; status?: number; error?: string }> {
  pruneStaleCalls();
  const targetId = input.targetId.trim();
  const callId = input.callId.trim();
  const action = input.action.trim();
  if (!targetId || !action || !callId) {
    return {
      ok: false,
      delivered: false,
      status: 400,
      error: "Valid call signal fields required.",
    };
  }
  if (await isBlockedBetween(input.userId, targetId)) {
    return { ok: false, delivered: false, status: 403, error: "Blocked user." };
  }

  const userAliases = getUserAliases(input.userId);
  const targetAliases = getUserAliases(targetId);

  if (action === "accepted") {
    const acceptedTs = Date.now();
    for (const uAlias of userAliases) {
      activeCallPeers.set(uAlias, {
        callId,
        peerId: targetId,
        createdAt: acceptedTs,
        answered: true,
      });
      pendingCallOffers.delete(uAlias);
    }
    for (const tAlias of targetAliases) {
      activeCallPeers.set(tAlias, {
        callId,
        peerId: input.userId,
        createdAt: acceptedTs,
        answered: true,
      });
      pendingCallOffers.delete(tAlias);
    }
  } else if (action === "declined" || action === "ended" || action === "busy") {
    for (const uAlias of userAliases) {
      activeCallPeers.delete(uAlias);
      pendingCallOffers.delete(uAlias);
    }
    for (const tAlias of targetAliases) {
      const theirs = activeCallPeers.get(tAlias);
      if (
        !theirs ||
        theirs.callId === callId ||
        theirs.peerId === input.userId ||
        userAliases.includes(theirs.peerId)
      ) {
        activeCallPeers.delete(tAlias);
      }
      pendingCallOffers.delete(tAlias);
    }
  }

  const signalPayload: Record<string, unknown> = {
    fromUserId: input.userId,
    callId,
    action,
    sdp: input.sdp ?? null,
    candidate: input.candidate ?? null,
    cameraEnabled: typeof input.cameraEnabled === "boolean" ? input.cameraEnabled : undefined,
    micMuted: typeof input.micMuted === "boolean" ? input.micMuted : undefined,
    reason: typeof input.reason === "string" ? input.reason : undefined,
  };

  const delivered = sendToUser(targetId, "call:signal", signalPayload);
  if (
    !delivered &&
    (action === "accepted" ||
      action === "offer" ||
      action === "answer" ||
      action === "ice-candidate" ||
      action === "media-state")
  ) {
    bufferSignalForUser(targetId, signalPayload);
  }
  return { ok: true, delivered };
}

export function registerSseClient(userId: string, res: Response): () => void {
  const aliases = getUserAliases(userId);
  const heartbeatTimer = setInterval(() => {
    if (!res.writableEnded) {
      try {
        res.write(": ping\n\n");
      } catch {
        /* closed */
      }
    }
  }, 20_000);
  heartbeatTimer.unref();

  const client: SseClient = {
    res,
    userId,
    activePeerId: null,
    heartbeatTimer,
  };

  for (const alias of aliases) {
    let set = userSseClients.get(alias);
    if (!set) {
      set = new Set();
      userSseClients.set(alias, set);
    }
    set.add(client);
  }

  void broadcastPresence(userId, true);
  void markPendingDeliveredForUser(userId);
  res.write(
    `event: message\ndata: ${JSON.stringify({ event: "connected", payload: { userId } })}\n\n`,
  );
  deliverPendingForUser(userId);

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeatTimer);
    let wasLast = false;
    for (const alias of aliases) {
      const current = userSseClients.get(alias);
      if (current) {
        current.delete(client);
        if (current.size === 0) {
          userSseClients.delete(alias);
          wasLast = true;
        }
      }
    }
    if (wasLast && !isUserConnected(userId)) {
      scheduleDisconnectCleanup(userId);
    }
  };
}

export function attachWebSocketServer(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (req, socket, head) => {
    const reqUrl = req.url ?? "";
    const pathname = reqUrl.split("?")[0];
    if (pathname !== "/ws") {
      return;
    }

    const user = await resolveUserFromRequest(req);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = ws as ClientSocket;
      client.userId = user.id;
      client.isAlive = true;
      wss.emit("connection", client, req);
    });
  });

  wss.on("connection", (ws: ClientSocket) => {
    const userId = ws.userId;
    if (!userId) {
      ws.close(1008, "Unauthorized");
      return;
    }

    const aliases = getUserAliases(userId);
    for (const alias of aliases) {
      let set = userSockets.get(alias);
      if (!set) {
        set = new Set();
        userSockets.set(alias, set);
      }
      set.add(ws);
    }

    void broadcastPresence(userId, true);
    void markPendingDeliveredForUser(userId);

    ws.send(JSON.stringify({ event: "connected", payload: { userId } }));
    deliverPendingForUser(userId);

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", async (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as {
          event?: string;
          payload?: Record<string, unknown>;
        };
        const event = data.event;
        const payload = data.payload ?? {};

        if (event === "ping") {
          await db
            .prepare("UPDATE users SET last_active_at = ? WHERE id = ?")
            .run(new Date().toISOString(), userId);
          ws.send(JSON.stringify({ event: "pong", payload: { ts: Date.now() } }));
          return;
        }

        if (event === "thread:active") {
          const peerId = typeof payload["peerId"] === "string" ? payload["peerId"].trim() : "";
          ws.activePeerId = peerId || null;
          setSseActiveThread(userId, peerId || null);
          return;
        }

        if (event === "typing") {
          const peerId = typeof payload["peerId"] === "string" ? payload["peerId"] : "";
          const active = Boolean(payload["active"]);
          if (!peerId || (await isBlockedBetween(userId, peerId))) return;
          sendToUser(peerId, "typing", { fromUserId: userId, active });
          return;
        }

        if (event === "messages:seen") {
          const peerId = typeof payload["peerId"] === "string" ? payload["peerId"] : "";
          if (!peerId || (await isBlockedBetween(userId, peerId))) return;
          const key = threadKeyFor(userId, peerId);
          const seenAt = new Date().toISOString();
          const result = await db
            .prepare(
              "UPDATE messages SET seen_at = ? WHERE thread_key = ? AND sender_id = ? AND recipient_id = ? AND seen_at IS NULL",
            )
            .run(seenAt, key, peerId, userId);

          if (result.changes > 0) {
            sendToUser(peerId, "messages:seen", { byUserId: userId, peerId: userId, seenAt });
            sendToUser(userId, "messages:seen", { byUserId: userId, peerId, seenAt });
          }
          return;
        }

        if (event === "call:initiate") {
          const rawTarget =
            typeof payload["targetId"] === "string" ? payload["targetId"].trim() : "";
          const callType = payload["callType"] === "video" ? "video" : "audio";
          const rawCallId = typeof payload["callId"] === "string" ? payload["callId"].trim() : "";
          const result = await initiateCallSession({
            callerId: userId,
            targetId: rawTarget,
            callId: rawCallId || undefined,
            callType,
          });
          if (!result.ok) {
            ws.send(
              JSON.stringify({
                event: "call:error",
                payload: { error: result.error },
              }),
            );
          }
          return;
        }

        if (event === "call:signal") {
          const targetId =
            typeof payload["targetId"] === "string" ? payload["targetId"].trim() : "";
          const callId = typeof payload["callId"] === "string" ? payload["callId"].trim() : "";
          const action = typeof payload["action"] === "string" ? payload["action"].trim() : "";
          await forwardCallSignal({
            userId,
            targetId,
            callId,
            action,
            sdp: payload["sdp"] ?? null,
            candidate: payload["candidate"] ?? null,
            cameraEnabled:
              typeof payload["cameraEnabled"] === "boolean" ? payload["cameraEnabled"] : undefined,
            micMuted: typeof payload["micMuted"] === "boolean" ? payload["micMuted"] : undefined,
            reason: typeof payload["reason"] === "string" ? payload["reason"] : undefined,
          });
        }
      } catch {
        /* ignore malformed ws frame */
      }
    });

    ws.on("close", () => {
      const aliases = getUserAliases(userId);
      let wasLast = false;
      for (const alias of aliases) {
        const current = userSockets.get(alias);
        if (current) {
          current.delete(ws);
          if (current.size === 0) {
            userSockets.delete(alias);
            wasLast = true;
          }
        }
      }

      if (wasLast && !isUserConnected(userId)) {
        scheduleDisconnectCleanup(userId);
      }
    });
  });

  const interval = setInterval(() => {
    pruneStaleCalls();
    for (const ws of wss.clients) {
      const client = ws as ClientSocket;
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 20_000);
  interval.unref();

  httpServer.once("close", () => {
    wss.close();
  });
  wss.on("close", () => clearInterval(interval));
  return wss;
}
