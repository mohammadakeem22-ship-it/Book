import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User as FirebaseUser,
} from "firebase/auth";
import { createClient } from "@supabase/supabase-js";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import {
  buildIncomingMessageAlertPayload,
  showSystemNotification,
  triggerVibration,
} from "./alerts";
import { warmUpCallAudio } from "@/components/CallMedia";
import { createCallClient, type CallSignalMessage } from "./call-client";
import { buildIceServers } from "./call-peer";
import { isActiveElementTextInput } from "./chat-viewport";
import { compressAvatarDataUrl, getFirebaseAuth, googleProvider } from "@/lib/firebase";
import type { SecretThemeId } from "@/lib/secret-themes";
import {
  dedupeByKey,
  dedupeConversationsByPeerId,
  dedupeMessagesById,
  dedupeUsersById,
  filterAndSortUsers,
  mergePaginatedMessages,
  normalizeEmail,
  parseGalleryScope,
  threadKeyFor,
  type GalleryScope,
} from "@/lib/social-logic";

export type MediaKind = "image" | "video" | "audio";
export type LoginMode = "gmail" | "phone" | "username" | "auto";

export type MessageReactionGroup = {
  emoji: string;
  count: number;
  reactedByMe: boolean;
  userIds: string[];
};

export type ReplyPreview = {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  mediaKind: MediaKind | null;
  deleted: boolean;
};

export type PublicAccount = {
  id: string;
  fullName: string;
  displayHandle: string;
  bio: string;
  avatarUrl: string | null;
  theme: SecretThemeId;
  phoneVerified: boolean;
  emailVerified?: boolean;
  isAdmin?: boolean;
  lastActiveAt: string;
  online: boolean;
  email?: string | null | undefined;
  phoneMasked?: string;
  phoneE164?: string | null;
  blockedByMe?: boolean;
  blockedMe?: boolean;
  followerCount?: number;
  followingCount?: number;
  isFollowing?: boolean;
  followsMe?: boolean;
};

export type AccountChoiceOption = {
  id: string;
  fullName: string;
  displayHandle: string;
  avatarUrl: string | null;
};

export class AccountChoiceRequiredError extends Error {
  accounts: AccountChoiceOption[];
  constructor(accounts: AccountChoiceOption[]) {
    super("Multiple linked accounts matched. Choose which profile to open.");
    this.name = "AccountChoiceRequiredError";
    this.accounts = accounts;
  }
}

export type LinkedAccountItem = {
  id: string;
  fullName: string;
  displayHandle: string;
  avatarUrl: string | null;
  isCurrent: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
};

export type LinkedAccountsInfo = {
  maxAccounts: number;
  email: string | null;
  emailVerified: boolean;
  phoneMasked?: string;
  phoneVerified: boolean;
  emailAccountCount: number;
  phoneAccountCount: number;
  canCreateByEmail: boolean;
  canCreateByPhone: boolean;
  accounts: LinkedAccountItem[];
};

export type ControlUserRecord = {
  id: string;
  fullName: string;
  displayHandle: string;
  bio: string;
  avatarUrl: string | null;
  personalLink: string | null;
  online: boolean;
  lastActiveAt: string;
  createdAt: string;
};

export type ChatMessage = {
  id: string;
  threadKey: string;
  from: string;
  to: string;
  text: string;
  mediaUrl: string | null;
  mediaId: string | null;
  mediaKind: MediaKind | null;
  mediaName: string | null;
  replyToId: string | null;
  replyTo: ReplyPreview | null;
  reactions: MessageReactionGroup[];
  editedAt: string | null;
  deletedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  seenAt: string | null;
  localStatus?: "sending" | "sent" | "failed";
  sendError?: string;
  pendingRetry?: {
    text: string;
    mediaId: string | null;
    replyToId: string | null;
  };
};

export type ConversationItem = {
  peer: PublicAccount;
  blockedByMe: boolean;
  blockedMe: boolean;
  pinned: boolean;
  muted: boolean;
  lastMessage: ChatMessage | null;
  unreadCount: number;
};

export type NfcLinkState = {
  revoked: boolean;
  version: number;
  updatedAt: string;
  token: string | null;
  path: string | null;
};

export type GalleryItem = {
  id: string;
  kind: "image" | "video";
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  galleryScope?: GalleryScope;
  createdAt: string;
  url: string;
  mine: boolean;
};

export type BlockedUserItem = PublicAccount & {
  blockedAt: string;
};

export type LegacyAccountHint = {
  id: string;
  username: string;
  bio?: string;
  dp?: string;
};

export type IncomingCall = {
  callId: string;
  callType: "audio" | "video";
  from: PublicAccount;
};

export type OutgoingCall = {
  callId: string;
  callType: "audio" | "video";
  target: PublicAccount;
  status: "preparing" | "connecting" | "ringing" | "accepted" | "reconnecting";
  stream?: MediaStream | null;
  localStream?: MediaStream | null;
  streamVersion?: number;
  micMuted?: boolean;
  cameraEnabled?: boolean;
  remoteMicMuted?: boolean;
  remoteCameraEnabled?: boolean;
  facingMode?: "user" | "environment";
  canSwitchCamera?: boolean;
};

export type IncomingMessageAlert = {
  id: string;
  peer: PublicAccount;
  preview: string;
  createdAt: string;
};

type ChatClientState = {
  ready: boolean;
  me: PublicAccount | null;
  sessionToken: string | null;
  otpConfigured: boolean;
  emailOtpConfigured: boolean;
  conversations: ConversationItem[];
  discoveredUsers: PublicAccount[];
  activePeerId: string | null;
  threads: Record<string, ChatMessage[]>;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  typingByPeer: Record<string, boolean>;
  blockedUsers: BlockedUserItem[];
  nfc: NfcLinkState | null;
  gallery: GalleryItem[];
  soundEnabled: boolean;
  incomingCall: IncomingCall | null;
  outgoingCall: OutgoingCall | null;
  incomingMessageAlert: IncomingMessageAlert | null;
  legacyAccounts: LegacyAccountHint[];
  wsConnected: boolean;
};

const SOUND_STORAGE_KEY = "reading-corner.chat-sound.v3";

const INITIAL: ChatClientState = {
  ready: false,
  me: null,
  sessionToken: null,
  otpConfigured: false,
  emailOtpConfigured: false,
  conversations: [],
  discoveredUsers: [],
  activePeerId: null,
  threads: {},
  hasOlderMessages: false,
  loadingOlderMessages: false,
  typingByPeer: {},
  blockedUsers: [],
  nfc: null,
  gallery: [],
  soundEnabled: true,
  incomingCall: null,
  outgoingCall: null,
  incomingMessageAlert: null,
  legacyAccounts: [],
  wsConnected: false,
};

let state: ChatClientState = INITIAL;
const listeners = new Set<() => void>();
let initialized = false;
let suppressFirebaseSyncDepth = 0;

function isFirebaseSyncSuppressed(): boolean {
  return suppressFirebaseSyncDepth > 0;
}

async function withFirebaseSyncSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  suppressFirebaseSyncDepth += 1;
  try {
    return await fn();
  } finally {
    suppressFirebaseSyncDepth = Math.max(0, suppressFirebaseSyncDepth - 1);
  }
}

let ws: WebSocket | null = null;
let wsReconnectTimer: number | null = null;
let wsPingTimer: number | null = null;
let wsReconnectAttempt = 0;
let wsConnectTimer: number | null = null;
let wsConnectPromise: Promise<void> | null = null;
let sseAbortController: AbortController | null = null;
let sseReconnectTimer: number | null = null;
let sseFallbackDelayTimer: number | null = null;
let sseConnected = false;
let pendingCallsPollTimer: number | null = null;
let pendingCallsSyncInFlight = false;
let callClient: ReturnType<typeof createCallClient> | undefined;
let cachedIceServers: { servers: RTCIceServer[]; expiresAt: number } | null = null;

const uploadedMediaMeta = new Map<string, { url: string; kind: MediaKind; name: string }>();
const mediaBlobUrlCache = new Map<string, string>();
const inFlightMediaFetches = new Map<string, Promise<string>>();
const typingTimers = new Map<string, number>();
const cursorByPeer = new Map<string, { before: string; beforeId: string } | null>();
const hasOlderByPeer = new Map<string, boolean>();
let sessionRefreshPromise: Promise<string | null> | null = null;

function emit() {
  listeners.forEach((l) => l());
}

function setState(patch: Partial<ChatClientState>) {
  state = { ...state, ...patch };
  emit();
}

export function primeMediaObjectUrl(url: string, blob: Blob): string {
  if (!url || typeof window === "undefined") return url;
  const existing = mediaBlobUrlCache.get(url);
  if (existing && existing.startsWith("blob:")) {
    URL.revokeObjectURL(existing);
  }
  const objUrl = URL.createObjectURL(blob);
  mediaBlobUrlCache.set(url, objUrl);
  return objUrl;
}

export function evictMediaObjectUrl(url: string) {
  const existing = mediaBlobUrlCache.get(url);
  if (existing && existing.startsWith("blob:")) {
    URL.revokeObjectURL(existing);
  }
  mediaBlobUrlCache.delete(url);
}

function clearMediaBlobCache() {
  for (const objUrl of mediaBlobUrlCache.values()) {
    if (objUrl.startsWith("blob:")) {
      URL.revokeObjectURL(objUrl);
    }
  }
  mediaBlobUrlCache.clear();
  inFlightMediaFetches.clear();
}

export function getCachedMediaObjectUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.startsWith("/api/media/")) return url;
  return mediaBlobUrlCache.get(url) ?? null;
}

export const AUTH_TOKEN_KEY = "rc_auth_token_v1";

export async function getEffectiveAuthToken(): Promise<string | null> {
  if (state.sessionToken && state.sessionToken.startsWith("rc_sess_")) {
    return state.sessionToken;
  }
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem(AUTH_TOKEN_KEY);
    if (stored && stored.startsWith("rc_sess_")) {
      return stored;
    }
    const fbUser = getFirebaseAuth().currentUser;
    if (fbUser) {
      const idToken = await fbUser.getIdToken().catch(() => null);
      if (idToken) return idToken;
    }
  }
  return null;
}

export async function getBearerHeaders(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const token = await getEffectiveAuthToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function tryRefreshAuthSession(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (sessionRefreshPromise) return sessionRefreshPromise;

  sessionRefreshPromise = (async () => {
    try {
      const storedToken = window.localStorage.getItem(AUTH_TOKEN_KEY);
      const sessRes = await fetch("/api/auth/session", {
        credentials: "include",
        headers:
          storedToken && storedToken.startsWith("rc_sess_")
            ? { Authorization: `Bearer ${storedToken}` }
            : {},
      });
      if (sessRes.ok) {
        const sess = (await sessRes.json().catch(() => ({}))) as {
          authenticated?: boolean;
          token?: string | null;
          user?: PublicAccount | null;
        };
        if (sess.authenticated && sess.user) {
          const nextToken = sess.token ?? state.sessionToken ?? storedToken ?? "__cookie__";
          if (nextToken && nextToken.startsWith("rc_sess_")) {
            window.localStorage.setItem(AUTH_TOKEN_KEY, nextToken);
          }
          setState({ me: sess.user, sessionToken: nextToken });
          return nextToken;
        }
      }

      const fbUser = getFirebaseAuth().currentUser;
      if (fbUser) {
        const freshIdToken = await fbUser.getIdToken(true).catch(() => null);
        if (freshIdToken) {
          const fbRes = await fetch("/api/auth/firebase-session", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken: freshIdToken }),
          });
          if (fbRes.ok) {
            const data = (await fbRes.json().catch(() => ({}))) as {
              token?: string;
              user?: PublicAccount;
            };
            if (data.token && data.user) {
              if (data.token.startsWith("rc_sess_")) {
                window.localStorage.setItem(AUTH_TOKEN_KEY, data.token);
              }
              setState({ me: data.user, sessionToken: data.token });
              return data.token;
            }
          }
        }
      }
    } catch {
      /* ignore transient refresh error */
    }
    return null;
  })().finally(() => {
    sessionRefreshPromise = null;
  });

  return sessionRefreshPromise;
}

async function apiJson<T>(
  url: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const buildInit = async (): Promise<RequestInit> => {
    const headers = await getBearerHeaders(options.headers);
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    return {
      method: options.method ?? "GET",
      headers,
      credentials: "include",
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    };
  };

  let resp = await fetch(url, await buildInit());
  if (resp.status === 401 && !url.startsWith("/api/auth/")) {
    const refreshed = await tryRefreshAuthSession();
    if (refreshed) {
      resp = await fetch(url, await buildInit());
    }
  }
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) {
    throw new Error(data.error || `Request failed (${resp.status})`);
  }
  return data;
}

export async function resolveAuthorizedMediaUrl(url: string): Promise<string> {
  if (!url || !url.startsWith("/api/media/")) return url;
  const cached = mediaBlobUrlCache.get(url);
  if (cached) return cached;

  const inflight = inFlightMediaFetches.get(url);
  if (inflight) return inflight;

  const promise = (async () => {
    const headers = await getBearerHeaders();
    let resp = await fetch(url, { headers, credentials: "include" });
    if (resp.status === 401) {
      const fbUser = getFirebaseAuth().currentUser;
      if (fbUser) {
        const freshToken = await fbUser.getIdToken(true);
        resp = await fetch(url, {
          headers: { Authorization: `Bearer ${freshToken}` },
          credentials: "include",
        });
      }
    }
    if (!resp.ok) {
      throw new Error(`Could not load media (${resp.status})`);
    }
    const blob = await resp.blob();
    return primeMediaObjectUrl(url, blob);
  })().finally(() => {
    inFlightMediaFetches.delete(url);
  });

  inFlightMediaFetches.set(url, promise);
  return promise;
}

export async function downloadProtectedMedia(url: string, filename: string) {
  const resolved = await resolveAuthorizedMediaUrl(url);
  const a = document.createElement("a");
  a.href = resolved;
  a.download = filename || "media";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function playNotificationTone() {
  if (!state.soundEnabled || typeof window === "undefined") return;
  void import("./water-sound")
    .then(({ playWaterSound }) => {
      playWaterSound("ripple", state.soundEnabled);
    })
    .catch(() => {});
}

function sendWs(event: string, payload: Record<string, unknown>): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ event, payload }));
  return true;
}

function isRealtimeOpen(): boolean {
  return Boolean((ws && ws.readyState === WebSocket.OPEN) || sseConnected);
}

function stopSseFallback() {
  if (sseReconnectTimer) {
    window.clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  if (sseFallbackDelayTimer) {
    window.clearTimeout(sseFallbackDelayTimer);
    sseFallbackDelayTimer = null;
  }
  if (sseAbortController) {
    sseAbortController.abort();
    sseAbortController = null;
  }
  sseConnected = false;
}

function stopPendingCallsPolling() {
  if (pendingCallsPollTimer) {
    window.clearInterval(pendingCallsPollTimer);
    pendingCallsPollTimer = null;
  }
}

function startPendingCallsPolling() {
  if (typeof window === "undefined" || pendingCallsPollTimer) return;
  pendingCallsPollTimer = window.setInterval(() => {
    if (!state.me || document.visibilityState === "hidden") return;
    void syncPendingIncomingCalls();
  }, 2000);
}

function disconnectRealtime() {
  stopPendingCallsPolling();
  if (wsReconnectTimer) {
    window.clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (wsPingTimer) {
    window.clearInterval(wsPingTimer);
    wsPingTimer = null;
  }
  if (wsConnectTimer) {
    window.clearTimeout(wsConnectTimer);
    wsConnectTimer = null;
  }
  stopSseFallback();
  wsConnectPromise = null;
  cachedIceServers = null;
  callClient?.dispose();
  callClient = undefined;
  if (ws) {
    try {
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
    } catch {
      /* ignore close errors */
    }
    ws = null;
  }
  setState({ wsConnected: false });
}

async function waitForRealtimeConnection(timeoutMs = 10_000): Promise<boolean> {
  if (isRealtimeOpen()) return true;
  void connectRealtimeAsync();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isRealtimeOpen()) return true;
    if (!state.me) return false;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return false;
}

async function fetchCallIceServers(): Promise<RTCIceServer[]> {
  if (cachedIceServers && Date.now() < cachedIceServers.expiresAt) {
    return cachedIceServers.servers;
  }
  try {
    const data = await apiJson<{ iceServers?: RTCIceServer[]; ttlSeconds?: number }>(
      "/api/calls/ice-servers",
    );
    const merged = buildIceServers(undefined, data.iceServers ?? []);
    const ttlMs = Math.max(60_000, Math.min(3_600_000, Number(data.ttlSeconds ?? 300) * 800));
    cachedIceServers = { servers: merged, expiresAt: Date.now() + ttlMs };
    return merged;
  } catch {
    return buildIceServers();
  }
}

async function syncPendingIncomingCalls(): Promise<void> {
  if (typeof window === "undefined" || !state.me || pendingCallsSyncInFlight) return;
  pendingCallsSyncInFlight = true;
  try {
    const active = callClient?.getActiveCallSnapshot() ?? null;
    const params = new URLSearchParams();
    if (active?.callId) {
      params.set("activeCallId", active.callId);
      if (!isRealtimeOpen()) {
        params.set("drainSignals", "1");
      }
    }
    const qs = params.toString();
    const data = await apiJson<{
      calls?: IncomingCall[];
      activeCallStatus?: string;
      signals?: CallSignalMessage[];
    }>(qs ? `/api/calls/pending?${qs}` : "/api/calls/pending");

    if (!state.me) return;
    const client = ensureCallClient();
    if (Array.isArray(data.calls)) {
      for (const incoming of data.calls) {
        if (incoming?.callId && incoming.from?.id) {
          client.handleIncoming(incoming);
        }
      }
    }
    if (Array.isArray(data.signals)) {
      for (const sig of data.signals) {
        if (sig?.callId && sig.action) {
          void client.handleSignal(sig);
        }
      }
    }
    if (
      active?.callId &&
      (data.activeCallStatus === "ended" ||
        data.activeCallStatus === "declined" ||
        data.activeCallStatus === "busy")
    ) {
      void client.handleSignal({ callId: active.callId, action: data.activeCallStatus });
    }
  } catch {
    /* ignore transient polling failures */
  } finally {
    pendingCallsSyncInFlight = false;
  }
}

async function sendCallSignalHttp(
  event: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (!state.me) return false;
  if (event === "call:initiate") {
    const res = await apiJson<{
      ok: boolean;
      callId: string;
      targetId: string;
      callType: "audio" | "video";
      recipientOnline: boolean;
      busy?: boolean;
    }>("/api/calls/initiate", { method: "POST", body: payload });
    if (res.busy) {
      void ensureCallClient().handleSignal({ callId: res.callId, action: "busy" });
    } else {
      ensureCallClient().handleRinging({
        callId: res.callId,
        targetId: res.targetId,
        callType: res.callType,
        recipientOnline: res.recipientOnline,
      });
    }
    return true;
  }
  if (event === "call:signal") {
    await apiJson("/api/calls/signal", { method: "POST", body: payload });
    return true;
  }
  return false;
}

function ensureCallClient() {
  if (!callClient) {
    callClient = createCallClient(
      sendWs,
      fetchUserProfile,
      setState,
      (message) => toast(message),
      waitForRealtimeConnection,
      {
        getIceServers: fetchCallIceServers,
        sendSignal: sendCallSignalHttp,
      },
    );
  }
  return callClient;
}

function upsertMessageIntoThread(peerId: string, incoming: ChatMessage) {
  const existing = state.threads[peerId] ?? [];
  const filtered = existing.filter(
    (m) =>
      m.id !== incoming.id &&
      !(m.id.startsWith("temp_") && m.from === incoming.from && m.text === incoming.text),
  );
  const next = dedupeMessagesById([...filtered, incoming]).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  setState({
    threads: { ...state.threads, [peerId]: next },
  });
}

function handleIncomingMessageEvent(msg: ChatMessage, sender?: PublicAccount) {
  const myId = state.me?.id;
  if (!myId) return;
  const peerId = msg.from === myId ? msg.to : msg.from;

  const typingTimer = typingTimers.get(peerId);
  if (typingTimer) {
    window.clearTimeout(typingTimer);
    typingTimers.delete(peerId);
  }
  if (state.typingByPeer[peerId]) {
    setState({ typingByPeer: { ...state.typingByPeer, [peerId]: false } });
  }

  upsertMessageIntoThread(peerId, msg);

  // Update conversation preview smoothly
  const existingConv = state.conversations.find((c) => c.peer.id === peerId);
  const isIncoming = msg.from !== myId;
  const isPageHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  const isViewingThread = state.activePeerId === peerId && !isPageHidden;

  const peerAccount = existingConv?.peer ??
    sender ??
    state.discoveredUsers.find((u) => u.id === peerId) ?? {
      id: peerId,
      fullName: "Reader",
      displayHandle: "@reader",
      bio: "",
      avatarUrl: null,
      theme: "instagram" as SecretThemeId,
      phoneVerified: false,
      lastActiveAt: msg.createdAt,
      online: true,
    };

  const nextConv: ConversationItem = existingConv
    ? {
        ...existingConv,
        peer: sender ? { ...existingConv.peer, ...sender } : existingConv.peer,
        lastMessage: msg,
        unreadCount:
          isIncoming && !isViewingThread ? existingConv.unreadCount + 1 : existingConv.unreadCount,
      }
    : {
        peer: peerAccount,
        blockedByMe: false,
        blockedMe: false,
        pinned: false,
        muted: false,
        lastMessage: msg,
        unreadCount: isIncoming && !isViewingThread ? 1 : 0,
      };

  const rest = state.conversations.filter((c) => c.peer.id !== peerId);
  const sorted = dedupeConversationsByPeerId([nextConv, ...rest], myId).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastMessage?.createdAt ?? "").localeCompare(a.lastMessage?.createdAt ?? "");
  });
  setState({ conversations: sorted });

  if (isIncoming && isViewingThread) {
    void markThreadSeen(peerId);
    return;
  }

  if (isIncoming && !nextConv.muted) {
    const payload = buildIncomingMessageAlertPayload({
      senderName: peerAccount.fullName,
      text: msg.text,
      mediaKind: msg.mediaKind,
    });
    const onChatRoute =
      typeof window !== "undefined" &&
      (window.location.pathname.startsWith("/messages") ||
        window.location.pathname.startsWith("/chat"));
    const isTypingInChat =
      typeof document !== "undefined" &&
      onChatRoute &&
      isActiveElementTextInput(document.activeElement);

    if (!isTypingInChat) {
      triggerVibration(payload.vibratePattern);
    }
    playNotificationTone();

    if (state.activePeerId !== peerId) {
      setState({
        incomingMessageAlert: {
          id: `${peerId}-${Date.now()}`,
          peer: peerAccount,
          preview: payload.body,
          createdAt: msg.createdAt,
        },
      });
    }

    if (isPageHidden || !onChatRoute || state.activePeerId !== peerId) {
      showSystemNotification({
        title: payload.title,
        body: payload.body,
        tag: payload.tag,
        onClick: () => {
          void openThread(peerId);
          if (
            typeof window !== "undefined" &&
            !window.location.pathname.startsWith("/messages") &&
            !window.location.pathname.startsWith("/chat")
          ) {
            window.location.assign(`/messages?peer=${encodeURIComponent(peerId)}`);
          }
        },
      });
    }
  }
}

function handleRealtimeEvent(event: string | undefined, payload: Record<string, unknown>) {
  if (!event || event === "pong") return;
  if (event === "connected") {
    void syncPendingIncomingCalls();
    return;
  }

  if (event === "presence:update") {
    const userId = String(payload["userId"] ?? "");
    const online = Boolean(payload["online"]);
    const lastActiveAt = String(payload["lastActiveAt"] ?? new Date().toISOString());
    setState({
      discoveredUsers: state.discoveredUsers.map((u) =>
        u.id === userId ? { ...u, online, lastActiveAt } : u,
      ),
      conversations: state.conversations.map((c) =>
        c.peer.id === userId ? { ...c, peer: { ...c.peer, online, lastActiveAt } } : c,
      ),
    });
    return;
  }

  if (event === "user:registered") {
    const incomingUser = payload["user"] as PublicAccount | undefined;
    if (incomingUser && incomingUser.id !== state.me?.id) {
      const rest = state.discoveredUsers.filter((u) => u.id !== incomingUser.id);
      setState({
        discoveredUsers: dedupeUsersById(
          filterAndSortUsers([incomingUser, ...rest], "", "all"),
          state.me?.id,
        ),
      });
    }
    return;
  }

  if (event === "user:deleted") {
    const deletedId = String(payload["userId"] ?? "");
    setState({
      discoveredUsers: state.discoveredUsers.filter((u) => u.id !== deletedId),
      conversations: state.conversations.filter((c) => c.peer.id !== deletedId),
    });
    return;
  }

  if (event === "typing") {
    const fromUserId = String(payload["fromUserId"] ?? "");
    const active = Boolean(payload["active"]);
    if (fromUserId) {
      const prevTimer = typingTimers.get(fromUserId);
      if (prevTimer) {
        window.clearTimeout(prevTimer);
        typingTimers.delete(fromUserId);
      }
      if (active && typeof window !== "undefined") {
        const timeoutId = window.setTimeout(() => {
          typingTimers.delete(fromUserId);
          if (state.typingByPeer[fromUserId]) {
            setState({
              typingByPeer: { ...state.typingByPeer, [fromUserId]: false },
            });
          }
        }, 4500);
        typingTimers.set(fromUserId, timeoutId);
      }
      setState({
        typingByPeer: { ...state.typingByPeer, [fromUserId]: active },
      });
    }
    return;
  }

  if (event === "message:new") {
    const msg = payload["message"] as ChatMessage | undefined;
    const sender = payload["sender"] as PublicAccount | undefined;
    if (msg) handleIncomingMessageEvent(msg, sender);
    return;
  }

  if (event === "message:updated" || event === "message:deleted") {
    const msg = payload["message"] as ChatMessage | undefined;
    if (!msg || !state.me) return;
    const peerId = msg.from === state.me.id ? msg.to : msg.from;
    const thread = state.threads[peerId];
    if (thread) {
      setState({
        threads: {
          ...state.threads,
          [peerId]: thread.map((m) => (m.id === msg.id ? msg : m)),
        },
      });
    }
    setState({
      conversations: state.conversations.map((c) =>
        c.peer.id === peerId && c.lastMessage?.id === msg.id ? { ...c, lastMessage: msg } : c,
      ),
    });
    return;
  }

  if (event === "message:reaction") {
    const messageId = String(payload["messageId"] ?? "");
    const reactions = (payload["reactions"] as MessageReactionGroup[] | undefined) ?? [];
    const nextThreads: Record<string, ChatMessage[]> = {};
    let changed = false;
    for (const [peerId, msgs] of Object.entries(state.threads)) {
      if (msgs.some((m) => m.id === messageId)) {
        changed = true;
        nextThreads[peerId] = msgs.map((m) => (m.id === messageId ? { ...m, reactions } : m));
      } else {
        nextThreads[peerId] = msgs;
      }
    }
    if (changed) setState({ threads: nextThreads });
    return;
  }

  if (event === "messages:delivered") {
    const peerId = String(payload["peerId"] ?? payload["byUserId"] ?? "");
    const deliveredAt = String(payload["deliveredAt"] ?? new Date().toISOString());
    const msgs = state.threads[peerId];
    if (msgs && state.me) {
      setState({
        threads: {
          ...state.threads,
          [peerId]: msgs.map((m) =>
            m.from === state.me!.id && !m.deliveredAt ? { ...m, deliveredAt } : m,
          ),
        },
      });
    }
    return;
  }

  if (event === "messages:seen") {
    const peerId = String(payload["peerId"] ?? payload["byUserId"] ?? "");
    const seenAt = String(payload["seenAt"] ?? new Date().toISOString());
    const msgs = state.threads[peerId];
    if (msgs && state.me) {
      setState({
        threads: {
          ...state.threads,
          [peerId]: msgs.map((m) =>
            m.from === state.me!.id && !m.seenAt
              ? { ...m, seenAt, deliveredAt: m.deliveredAt ?? seenAt }
              : m,
          ),
        },
      });
    }
    setState({
      conversations: state.conversations.map((c) =>
        c.peer.id === peerId && c.lastMessage && !c.lastMessage.seenAt
          ? { ...c, lastMessage: { ...c.lastMessage, seenAt } }
          : c,
      ),
    });
    return;
  }

  if (event === "follow:updated") {
    const followerId = String(payload["followerId"] ?? "");
    const followingId = String(payload["followingId"] ?? "");
    const isFollowing = Boolean(payload["isFollowing"]);
    const targetFollowerCount = payload["targetFollowerCount"];
    const myFollowingCount = payload["myFollowingCount"];
    setState({
      me:
        state.me && typeof myFollowingCount === "number"
          ? { ...state.me, followingCount: myFollowingCount }
          : state.me,
      discoveredUsers: state.discoveredUsers.map((u) => {
        if (u.id === followingId && followerId === state.me?.id) {
          return {
            ...u,
            isFollowing,
            ...(typeof targetFollowerCount === "number"
              ? { followerCount: targetFollowerCount }
              : {}),
          };
        }
        if (u.id === followerId && followingId === state.me?.id) {
          return { ...u, followsMe: isFollowing };
        }
        return u;
      }),
    });
    return;
  }

  if (event === "block:updated") {
    void loadConversations();
    void discoverUsers();
    void loadBlocks();
    return;
  }

  if (event === "call:incoming") {
    ensureCallClient().handleIncoming(
      payload as unknown as {
        callId: string;
        callType: "audio" | "video";
        from: PublicAccount;
      },
    );
    return;
  }

  if (event === "call:ringing") {
    ensureCallClient().handleRinging(
      payload as unknown as {
        callId: string;
        targetId: string;
        callType: "audio" | "video";
        recipientOnline: boolean;
      },
    );
    return;
  }

  if (event === "call:signal") {
    void ensureCallClient().handleSignal(payload as unknown as CallSignalMessage);
    return;
  }

  if (event === "call:error") {
    ensureCallClient().handleCallError(payload as { error?: string });
  }
}

async function connectSseFallback(): Promise<void> {
  if (typeof window === "undefined" || !state.me) return;
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (sseAbortController) return;

  if (sseReconnectTimer) {
    window.clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }

  const controller = new AbortController();
  sseAbortController = controller;

  try {
    const headers = await getBearerHeaders({ Accept: "text/event-stream" });
    if (controller.signal.aborted || !state.me || (ws && ws.readyState === WebSocket.OPEN)) {
      return;
    }

    let resp = await fetch("/api/events", {
      headers,
      credentials: "include",
      signal: controller.signal,
    });
    if (resp.status === 401 && !controller.signal.aborted && state.me) {
      const refreshed = await tryRefreshAuthSession();
      if (refreshed && !controller.signal.aborted && state.me) {
        resp = await fetch("/api/events", {
          headers: await getBearerHeaders({ Accept: "text/event-stream" }),
          credentials: "include",
          signal: controller.signal,
        });
      }
    }
    if (!resp.ok || !resp.body || controller.signal.aborted || !state.me) {
      throw new Error(`SSE stream failed (${resp.status})`);
    }

    sseConnected = true;
    setState({ wsConnected: true });
    void syncPendingIncomingCalls();
    if (state.activePeerId) {
      void apiJson("/api/thread/active", {
        method: "POST",
        body: { peerId: state.activePeerId },
      }).catch(() => {});
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const dataLines = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) continue;
        try {
          const parsed = JSON.parse(dataLines.join("\n")) as {
            event?: string;
            payload?: Record<string, unknown>;
          };
          handleRealtimeEvent(parsed.event, parsed.payload ?? {});
        } catch {
          /* ignore malformed SSE event */
        }
      }
    }
  } catch {
    /* SSE fallback error triggers retry below if still signed in */
  } finally {
    if (sseAbortController === controller) {
      sseAbortController = null;
      sseConnected = false;
      setState({ wsConnected: Boolean(ws && ws.readyState === WebSocket.OPEN) });
      if (!controller.signal.aborted && state.me && (!ws || ws.readyState !== WebSocket.OPEN)) {
        sseReconnectTimer = window.setTimeout(() => {
          sseReconnectTimer = null;
          if (state.me && (!ws || ws.readyState !== WebSocket.OPEN)) {
            void connectSseFallback();
          }
        }, 1500);
      }
    }
  }
}

async function connectRealtimeAsync(): Promise<void> {
  if (typeof window === "undefined" || !state.me) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (wsConnectPromise) {
    return wsConnectPromise;
  }

  wsConnectPromise = (async () => {
    ensureCallClient();
    let effectiveToken = state.sessionToken;
    if (!effectiveToken || !effectiveToken.startsWith("rc_sess_")) {
      const resolved = await getEffectiveAuthToken();
      if (!resolved) {
        await (getFirebaseAuth().authStateReady?.() ?? Promise.resolve()).catch(() => {});
      }
      effectiveToken = (await getEffectiveAuthToken()) ?? effectiveToken;
      if (!state.me) return;
      if (effectiveToken && effectiveToken.startsWith("rc_sess_")) {
        setState({ sessionToken: effectiveToken });
      }
    }

    if (!state.me) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const queryToken = effectiveToken && effectiveToken !== "__cookie__" ? effectiveToken : null;
    const tokenQuery = queryToken ? `?token=${encodeURIComponent(queryToken)}` : "";
    const socket = new WebSocket(`${proto}//${window.location.host}/ws${tokenQuery}`);
    ws = socket;

    if (wsConnectTimer) window.clearTimeout(wsConnectTimer);
    wsConnectTimer = window.setTimeout(() => {
      if (ws === socket && socket.readyState === WebSocket.CONNECTING) socket.close();
    }, 10_000);

    if (sseFallbackDelayTimer) window.clearTimeout(sseFallbackDelayTimer);
    sseFallbackDelayTimer = window.setTimeout(() => {
      sseFallbackDelayTimer = null;
      if (state.me && (!ws || ws.readyState !== WebSocket.OPEN)) {
        void connectSseFallback();
      }
    }, 1200);

    socket.onopen = () => {
      if (wsConnectTimer) {
        window.clearTimeout(wsConnectTimer);
        wsConnectTimer = null;
      }
      if (sseFallbackDelayTimer) {
        window.clearTimeout(sseFallbackDelayTimer);
        sseFallbackDelayTimer = null;
      }
      stopSseFallback();
      wsReconnectAttempt = 0;
      setState({ wsConnected: true });
      if (wsPingTimer) window.clearInterval(wsPingTimer);
      wsPingTimer = window.setInterval(() => {
        sendWs("ping", {});
      }, 20_000);
      if (state.activePeerId) {
        sendWs("thread:active", { peerId: state.activePeerId });
        void openThread(state.activePeerId);
      }
      void Promise.allSettled([loadConversations(), discoverUsers(), syncPendingIncomingCalls()]);
    };

    socket.onmessage = (evt) => {
      try {
        const parsed = JSON.parse(String(evt.data)) as {
          event?: string;
          payload?: Record<string, unknown>;
        };
        handleRealtimeEvent(parsed.event, parsed.payload ?? {});
      } catch {
        /* ignore malformed frame */
      }
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      if (wsConnectTimer) {
        window.clearTimeout(wsConnectTimer);
        wsConnectTimer = null;
      }
      if (sseFallbackDelayTimer) {
        window.clearTimeout(sseFallbackDelayTimer);
        sseFallbackDelayTimer = null;
      }
      if (wsPingTimer) {
        window.clearInterval(wsPingTimer);
        wsPingTimer = null;
      }
      setState({ wsConnected: sseConnected });
      if (state.me) {
        void connectSseFallback();
        const delay = Math.min(30_000, 750 * 2 ** wsReconnectAttempt++);
        wsReconnectTimer = window.setTimeout(() => {
          wsReconnectTimer = null;
          if (!state.me) return;
          void tryRefreshAuthSession().finally(connectRealtime);
        }, delay);
      }
    };
  })().finally(() => {
    wsConnectPromise = null;
  });

  return wsConnectPromise;
}

function connectRealtime() {
  void connectRealtimeAsync();
}

async function hydrateAuthenticatedSession(user: PublicAccount, token?: string | null) {
  let effectiveToken = token ?? state.sessionToken;
  if (!effectiveToken || effectiveToken === "__cookie__") {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(AUTH_TOKEN_KEY);
      if (stored && stored.startsWith("rc_sess_")) {
        effectiveToken = stored;
      }
    }
  }
  const sessionToken = effectiveToken ?? "__cookie__";
  if (typeof window !== "undefined" && sessionToken.startsWith("rc_sess_")) {
    window.localStorage.setItem(AUTH_TOKEN_KEY, sessionToken);
  }
  setState({
    ready: true,
    me: user,
    sessionToken,
  });
  connectRealtime();
  startPendingCallsPolling();
  void Promise.allSettled([
    loadConversations(),
    discoverUsers(),
    fetchNfcLink(),
    fetchGallery(),
    loadBlocks(),
    syncPendingIncomingCalls(),
  ]);
}

function resetLocalSessionState() {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
  }
  clearMediaBlobCache();
  disconnectRealtime();
  cursorByPeer.clear();
  hasOlderByPeer.clear();
  for (const timer of typingTimers.values()) {
    window.clearTimeout(timer);
  }
  typingTimers.clear();
  setState({
    ready: true,
    me: null,
    sessionToken: null,
    conversations: [],
    discoveredUsers: [],
    activePeerId: null,
    threads: {},
    hasOlderMessages: false,
    loadingOlderMessages: false,
    typingByPeer: {},
    blockedUsers: [],
    nfc: null,
    gallery: [],
    incomingCall: null,
    outgoingCall: null,
    incomingMessageAlert: null,
  });
}

function bootstrap() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  window.addEventListener("online", () => {
    if (state.me) {
      connectRealtime();
      startPendingCallsPolling();
      void Promise.allSettled([loadConversations(), discoverUsers(), syncPendingIncomingCalls()]);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.me) {
      connectRealtime();
      startPendingCallsPolling();
      void Promise.allSettled([loadConversations(), discoverUsers(), syncPendingIncomingCalls()]);
    }
  });

  const savedSound = localStorage.getItem(SOUND_STORAGE_KEY);
  if (savedSound === "false") {
    setState({ soundEnabled: false });
  }

  let serverCheckResolved = false;

  const bridgeFirebaseUser = async (fbUser: FirebaseUser) => {
    if (state.me && state.sessionToken) return;
    try {
      const idToken = await fbUser.getIdToken();
      const data = await apiJson<{ token: string; user: PublicAccount }>(
        "/api/auth/firebase-session",
        {
          method: "POST",
          body: { idToken },
        },
      );
      await hydrateAuthenticatedSession(data.user, data.token);
    } catch {
      setState({ ready: true });
    }
  };

  void (async () => {
    try {
      const storedToken =
        typeof window !== "undefined" ? window.localStorage.getItem(AUTH_TOKEN_KEY) : null;
      const [healthRes, sessionRes] = await Promise.all([
        fetch("/api/health")
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})),
        fetch("/api/auth/session", {
          credentials: "include",
          headers:
            storedToken && storedToken.startsWith("rc_sess_")
              ? { Authorization: `Bearer ${storedToken}` }
              : {},
        })
          .then((r) => r.json())
          .catch(() => ({
            authenticated: false,
            user: null,
          })),
      ]);

      const health = healthRes as { otpConfigured?: boolean; emailOtpConfigured?: boolean };
      const sess = sessionRes as {
        authenticated?: boolean;
        token?: string | null;
        user?: PublicAccount | null;
      };

      setState({
        otpConfigured: Boolean(health.otpConfigured),
        emailOtpConfigured: Boolean(health.emailOtpConfigured),
      });

      if (sess.authenticated && sess.user) {
        serverCheckResolved = true;
        await hydrateAuthenticatedSession(
          sess.user,
          sess.token ?? state.sessionToken ?? "__cookie__",
        );
        return;
      }
    } catch {
      /* ignore transient boot network error */
    }
    serverCheckResolved = true;
    const fbUser = getFirebaseAuth().currentUser;
    if (fbUser && !state.me && !isFirebaseSyncSuppressed()) {
      await bridgeFirebaseUser(fbUser);
      return;
    }
    if (!state.me) {
      setState({ ready: true });
    }
  })();

  const auth = getFirebaseAuth();
  onAuthStateChanged(auth, (fbUser) => {
    if (isFirebaseSyncSuppressed() || !serverCheckResolved) return;
    if (!fbUser) {
      if (!state.me) {
        setState({ ready: true });
      }
      return;
    }

    // Only auto-bridge Firebase user if there isn't already an active SQLite session
    if (state.me && state.sessionToken) {
      return;
    }

    void bridgeFirebaseUser(fbUser);
  });
}

function subscribe(listener: () => void) {
  bootstrap();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChat() {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => INITIAL,
  );
}

function mapFirebaseAuthError(err: unknown): Error & { needsProviderConfig?: boolean } {
  const code = (err as { code?: string })?.code ?? "";
  if (code === "auth/email-already-in-use") {
    return new Error("An account is already registered with this email. Please sign in instead.");
  }
  if (code === "auth/invalid-email") {
    return new Error("Enter a valid email address.");
  }
  if (code === "auth/weak-password") {
    return new Error("Password must be at least 8 characters.");
  }
  if (
    code === "auth/invalid-credential" ||
    code === "auth/wrong-password" ||
    code === "auth/user-not-found"
  ) {
    return new Error("Invalid credentials.");
  }
  if (code === "auth/too-many-requests") {
    return new Error("Too many attempts. Please wait a moment and try again.");
  }
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
    return new Error("Google sign-in was canceled.");
  }
  if (code === "auth/popup-blocked") {
    return new Error(
      "Browser blocked the Google sign-in popup. Please allow popups and try again.",
    );
  }
  if (code === "auth/unauthorized-domain") {
    return new Error(
      "Google sign-in is not authorized on this domain yet. Sign in with Gmail, Phone, or Username below.",
    );
  }
  if (code === "auth/operation-not-allowed") {
    const e = new Error(
      "This sign-in method is not enabled in Firebase Authentication.",
    ) as Error & { needsProviderConfig?: boolean };
    e.needsProviderConfig = true;
    return e;
  }
  if (code === "auth/network-request-failed") {
    return new Error("Network error while connecting to authentication service. Please try again.");
  }
  if (code === "auth/user-disabled") {
    return new Error("This account has been disabled.");
  }
  return err instanceof Error ? err : new Error("Authentication failed.");
}

export async function signInWithGoogle(): Promise<PublicAccount> {
  const auth = getFirebaseAuth();
  return withFirebaseSyncSuppressed(async () => {
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      const idToken = await cred.user.getIdToken();
      const data = await apiJson<{ token: string; user: PublicAccount }>(
        "/api/auth/firebase-session",
        {
          method: "POST",
          body: { idToken },
        },
      );
      await hydrateAuthenticatedSession(data.user, data.token);
      return data.user;
    } catch (err) {
      throw mapFirebaseAuthError(err);
    }
  });
}

export async function getFreshGoogleReauthToken(): Promise<string> {
  const auth = getFirebaseAuth();
  const cred = await signInWithPopup(auth, googleProvider).catch((err) => {
    throw mapFirebaseAuthError(err);
  });
  return cred.user.getIdToken(true);
}

export async function verifyEmailWithFirebase(password: string): Promise<PublicAccount> {
  if (!state.me?.email) {
    throw new Error("Add an email address first.");
  }
  const auth = getFirebaseAuth();
  let fbUser = auth.currentUser;
  if (!fbUser || fbUser.email?.toLowerCase() !== state.me.email.toLowerCase()) {
    try {
      const cred = await signInWithEmailAndPassword(auth, state.me.email, password);
      fbUser = cred.user;
    } catch {
      const cred = await createUserWithEmailAndPassword(auth, state.me.email, password).catch(
        (err) => {
          throw mapFirebaseAuthError(err);
        },
      );
      fbUser = cred.user;
    }
  }
  await fbUser.reload();
  if (fbUser.emailVerified) {
    const idToken = await fbUser.getIdToken(true);
    const res = await apiJson<{ ok: boolean; user: PublicAccount }>(
      "/api/auth/verify-email-firebase",
      {
        method: "POST",
        body: { idToken },
      },
    );
    setState({ me: res.user });
    return res.user;
  }
  await sendEmailVerification(fbUser);
  throw new Error(
    `Verification link sent to ${state.me.email}. Click the link in your inbox, then press "Check Verification" again.`,
  );
}

export async function checkEmailVerificationStatus(): Promise<PublicAccount | null> {
  const fbUser = getFirebaseAuth().currentUser;
  if (!fbUser) return state.me;
  await fbUser.reload();
  if (!fbUser.emailVerified) return state.me;
  const idToken = await fbUser.getIdToken(true);
  const res = await apiJson<{ ok: boolean; user: PublicAccount }>(
    "/api/auth/verify-email-firebase",
    {
      method: "POST",
      body: { idToken },
    },
  );
  setState({ me: res.user });
  return res.user;
}

export async function registerAccount(input: {
  email?: string;
  username?: string;
  fullName: string;
  phone?: string;
  countryCode?: string;
  password: string;
  bio?: string;
  otpCode?: string;
  avatarDataUrl?: string | null;
  linkToExisting?: boolean;
  existingAccountPassword?: string;
}): Promise<PublicAccount> {
  const cleanName = input.fullName.trim();
  if (cleanName.length < 2 || cleanName.length > 60) {
    throw new Error("Full name is required (2–60 characters).");
  }
  if (input.password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  let avatarDataUrl: string | undefined;
  if (input.avatarDataUrl) {
    avatarDataUrl = (await compressAvatarDataUrl(input.avatarDataUrl)) ?? undefined;
  }

  // Try Firebase email sync in parallel silently when possible so email verification & Google fallback also stay linked
  let firebaseIdToken: string | undefined;
  const cleanEmail = input.email ? normalizeEmail(input.email) : null;
  if (cleanEmail && !input.linkToExisting) {
    try {
      const fbUser = getFirebaseAuth().currentUser;
      if (fbUser && fbUser.email?.toLowerCase() === cleanEmail && fbUser.emailVerified) {
        firebaseIdToken = await fbUser.getIdToken();
      }
    } catch {
      /* optional */
    }
  }

  const data = await apiJson<{ token: string; user: PublicAccount }>("/api/auth/register", {
    method: "POST",
    body: {
      email: input.email?.trim() || undefined,
      username: input.username?.trim() || undefined,
      fullName: cleanName,
      phone: input.phone?.trim() || undefined,
      countryCode: input.countryCode ?? "+91",
      password: input.password,
      bio: input.bio ?? "",
      avatarDataUrl,
      linkToExisting: input.linkToExisting,
      existingAccountPassword: input.existingAccountPassword,
      phoneOtpCode: input.otpCode,
      firebaseIdToken,
    },
  });

  // Best-effort Firebase mirror for non-linked first email signup so Firebase Forgot Password works out of the box
  if (cleanEmail && !input.linkToExisting) {
    suppressFirebaseSyncDepth += 1;
    void createUserWithEmailAndPassword(getFirebaseAuth(), cleanEmail, input.password)
      .then((cred) => updateProfile(cred.user, { displayName: cleanName }))
      .catch(() => {})
      .finally(() => {
        suppressFirebaseSyncDepth = Math.max(0, suppressFirebaseSyncDepth - 1);
      });
  }

  await hydrateAuthenticatedSession(data.user, data.token);
  return data.user;
}

export const registerWithPhone = registerAccount;

export async function loginAccount(input: {
  mode?: LoginMode;
  identifier?: string;
  email?: string;
  phone?: string;
  username?: string;
  countryCode?: string;
  password: string;
  targetUserId?: string;
}): Promise<PublicAccount> {
  const mode: LoginMode = input.mode ?? "auto";
  const rawIdentifier = String(
    mode === "phone"
      ? (input.phone ?? input.identifier ?? "")
      : mode === "gmail"
        ? (input.email ?? input.identifier ?? "")
        : mode === "username"
          ? (input.username ?? input.identifier ?? "")
          : (input.identifier ?? input.email ?? input.phone ?? input.username ?? ""),
  ).trim();

  if (!rawIdentifier) {
    throw new Error(
      mode === "phone"
        ? "Enter your phone number."
        : mode === "gmail"
          ? "Enter your Gmail or email address."
          : mode === "username"
            ? "Enter your username."
            : "Please enter your email, username, or phone number.",
    );
  }

  return withFirebaseSyncSuppressed(async () => {
    const resp = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        mode,
        identifier: rawIdentifier,
        email: input.email,
        phone: input.phone,
        username: input.username,
        countryCode: input.countryCode ?? "+91",
        password: input.password,
        targetUserId: input.targetUserId,
      }),
    });

    const data = (await resp.json().catch(() => ({}))) as {
      token?: string;
      user?: PublicAccount;
      requiresAccountChoice?: boolean;
      accounts?: AccountChoiceOption[];
      error?: string;
    };

    if (resp.ok && data.requiresAccountChoice && Array.isArray(data.accounts)) {
      throw new AccountChoiceRequiredError(data.accounts);
    }

    if (resp.ok && data.token && data.user) {
      await hydrateAuthenticatedSession(data.user, data.token);
      return data.user;
    }

    // Legacy Firebase email/password fallback when SQLite login returned 401 and identifier is an email
    if (
      resp.status === 401 &&
      (mode === "gmail" || (mode === "auto" && rawIdentifier.includes("@")))
    ) {
      const cleanEmail = normalizeEmail(rawIdentifier);
      if (cleanEmail) {
        try {
          const cred = await signInWithEmailAndPassword(
            getFirebaseAuth(),
            cleanEmail,
            input.password,
          );
          const idToken = await cred.user.getIdToken();
          const bridged = await apiJson<{ token: string; user: PublicAccount }>(
            "/api/auth/firebase-session",
            {
              method: "POST",
              body: { idToken, targetUserId: input.targetUserId },
            },
          );
          await hydrateAuthenticatedSession(bridged.user, bridged.token);
          return bridged.user;
        } catch {
          // Preserve server 401 message below
        }
      }
    }

    throw new Error(data.error || "Invalid credentials.");
  });
}

export const loginWithPhone = loginAccount;

export async function fetchLinkedAccounts(): Promise<LinkedAccountsInfo> {
  const data = await apiJson<LinkedAccountsInfo>("/api/auth/linked-accounts");
  return {
    ...data,
    accounts: dedupeUsersById(data.accounts ?? []),
  };
}

export async function createLinkedAccount(input: {
  fullName: string;
  username?: string;
  password: string;
  bio?: string;
  avatarDataUrl?: string | null;
  linkBy?: "email" | "phone" | "both" | "auto";
  switchToNew?: boolean;
}): Promise<{ user: PublicAccount; switched: boolean }> {
  let avatarDataUrl: string | undefined;
  if (input.avatarDataUrl) {
    avatarDataUrl = (await compressAvatarDataUrl(input.avatarDataUrl)) ?? undefined;
  }
  const data = await apiJson<{ token: string | null; switched: boolean; user: PublicAccount }>(
    "/api/auth/linked-accounts/create",
    {
      method: "POST",
      body: {
        fullName: input.fullName.trim(),
        username: input.username?.trim() || undefined,
        password: input.password,
        bio: input.bio ?? "",
        avatarDataUrl,
        linkBy: input.linkBy ?? "auto",
        switchToNew: input.switchToNew ?? true,
      },
    },
  );
  if (data.switched && data.token) {
    disconnectRealtime();
    clearMediaBlobCache();
    setState({
      conversations: [],
      threads: {},
      activePeerId: null,
      typingByPeer: {},
      blockedUsers: [],
      gallery: [],
      nfc: null,
      incomingMessageAlert: null,
    });
    await hydrateAuthenticatedSession(data.user, data.token);
  }
  return { user: data.user, switched: data.switched };
}

export async function switchLinkedAccount(targetUserId: string): Promise<PublicAccount> {
  const data = await apiJson<{ token: string; user: PublicAccount }>("/api/auth/switch-account", {
    method: "POST",
    body: { targetUserId },
  });
  disconnectRealtime();
  clearMediaBlobCache();
  setState({
    conversations: [],
    threads: {},
    activePeerId: null,
    typingByPeer: {},
    blockedUsers: [],
    gallery: [],
    nfc: null,
    incomingMessageAlert: null,
  });
  await hydrateAuthenticatedSession(data.user, data.token);
  return data.user;
}

export async function loginWithPersonalLink(token: string): Promise<PublicAccount> {
  const clean = token.trim();
  if (!clean || clean.length < 16) {
    throw new Error("This link is invalid or was revoked.");
  }
  const resp = await fetch("/api/nfc/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    credentials: "include",
    body: JSON.stringify({ token: clean }),
  });
  const data = (await resp.json().catch(() => ({}))) as {
    status?: string;
    token?: string;
    user?: PublicAccount;
    error?: string;
  };
  if (!resp.ok || data.status !== "authorized" || !data.user) {
    throw new Error(data.error || "This link is invalid or was revoked.");
  }

  return withFirebaseSyncSuppressed(async () => {
    await signOut(getFirebaseAuth()).catch(() => {});
    disconnectRealtime();
    clearMediaBlobCache();
    setState({
      conversations: [],
      threads: {},
      activePeerId: null,
      typingByPeer: {},
      blockedUsers: [],
      gallery: [],
      nfc: null,
      incomingMessageAlert: null,
    });
    await hydrateAuthenticatedSession(data.user, data.token);
    return data.user;
  });
}

export async function searchControlUsers(q = ""): Promise<ControlUserRecord[]> {
  const data = await apiJson<{ users: ControlUserRecord[] }>(
    `/api/control/users?q=${encodeURIComponent(q)}`,
  );
  return dedupeUsersById(data.users ?? []);
}

export async function removeControlUser(
  userId: string,
  code: string,
): Promise<{ ok: boolean; deletedUserId: string; selfDeleted: boolean }> {
  const res = await apiJson<{ ok: boolean; deletedUserId: string; selfDeleted: boolean }>(
    `/api/control/users/${encodeURIComponent(userId)}/remove`,
    {
      method: "POST",
      body: { code },
    },
  );
  if (res.selfDeleted || state.me?.id === userId) {
    await withFirebaseSyncSuppressed(async () => {
      await signOut(getFirebaseAuth()).catch(() => {});
      resetLocalSessionState();
    });
  } else {
    setState({
      discoveredUsers: state.discoveredUsers.filter((u) => u.id !== userId),
      conversations: state.conversations.filter((c) => c.peer.id !== userId),
      blockedUsers: state.blockedUsers.filter((u) => u.id !== userId),
      activePeerId: state.activePeerId === userId ? null : state.activePeerId,
    });
  }
  return res;
}

export async function sendPasswordReset(
  email: string,
): Promise<{ mode: "firebase" | "email_otp" }> {
  const clean = normalizeEmail(email);
  if (!clean) throw new Error("Enter a valid Gmail or email address.");
  const serverRes = await apiJson<{ ok: boolean; mode: "firebase" | "email_otp" }>(
    "/api/auth/forgot-password/email/send",
    {
      method: "POST",
      body: { email: clean },
    },
  );
  if (serverRes.mode === "email_otp") {
    return { mode: "email_otp" };
  }
  try {
    await sendPasswordResetEmail(getFirebaseAuth(), clean);
    return { mode: "firebase" };
  } catch (err) {
    throw mapFirebaseAuthError(err);
  }
}

export async function confirmEmailPasswordReset(input: {
  email: string;
  code: string;
  newPassword: string;
  username?: string;
}): Promise<{ ok: boolean; updatedHandle?: string }> {
  return apiJson("/api/auth/forgot-password/email/confirm", {
    method: "POST",
    body: input,
  });
}

export async function logout() {
  await withFirebaseSyncSuppressed(async () => {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: await getBearerHeaders(),
      credentials: "include",
    }).catch(() => {});
    await signOut(getFirebaseAuth()).catch(() => {});
    resetLocalSessionState();
  });
}

export async function deleteAccount(input: {
  password?: string;
  firebaseIdToken?: string;
  securityKey: string;
}): Promise<void> {
  await withFirebaseSyncSuppressed(async () => {
    await apiJson("/api/auth/account/delete", {
      method: "POST",
      body: {
        password: input.password,
        firebaseIdToken: input.firebaseIdToken,
        securityKey: input.securityKey,
      },
    });
    await signOut(getFirebaseAuth()).catch(() => {});
    resetLocalSessionState();
  });
}

export async function sendOtp(input: {
  phone: string;
  countryCode: string;
  purpose: "reset_password" | "verify_phone" | "register";
}) {
  return apiJson<{ ok: boolean; phoneMasked?: string }>("/api/auth/otp/send", {
    method: "POST",
    body: input,
  });
}

export async function resetPasswordWithOtp(input: {
  phone: string;
  countryCode: string;
  code: string;
  newPassword: string;
  targetUserId?: string;
}) {
  return apiJson<{ ok: boolean; updatedHandle?: string }>("/api/auth/otp/reset-password", {
    method: "POST",
    body: input,
  });
}

export async function verifyMyPhoneOtp(code: string) {
  const res = await apiJson<{ ok: boolean; phoneVerified: boolean }>("/api/auth/otp/verify-phone", {
    method: "POST",
    body: { code },
  });
  if (state.me && res.phoneVerified) {
    setState({ me: { ...state.me, phoneVerified: true } });
  }
  return res;
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
  firebaseIdToken?: string,
) {
  if (newPassword.length < 8) {
    throw new Error("New password must be at least 8 characters.");
  }
  return apiJson<{ ok: boolean }>("/api/auth/change-password", {
    method: "POST",
    body: { currentPassword, newPassword, firebaseIdToken },
  });
}

export async function updateMyProfile(patch: {
  fullName?: string;
  bio?: string;
  displayHandle?: string;
}): Promise<PublicAccount> {
  const data = await apiJson<{ user: PublicAccount }>("/api/profile", {
    method: "PATCH",
    body: patch,
  });
  setState({ me: data.user });
  return data.user;
}

export async function uploadAvatar(file: File): Promise<PublicAccount> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Avatar must be an image file.");
  }
  const form = new FormData();
  form.append("file", file);
  const headers = await getBearerHeaders();
  const resp = await fetch("/api/profile/avatar", {
    method: "POST",
    headers,
    credentials: "include",
    body: form,
  });
  const data = (await resp.json().catch(() => ({}))) as { user?: PublicAccount; error?: string };
  if (!resp.ok || !data.user) {
    throw new Error(data.error || "Could not update avatar.");
  }
  setState({ me: data.user });
  return data.user;
}

export async function setSecretTheme(theme: SecretThemeId) {
  if (state.me) {
    setState({ me: { ...state.me, theme } });
  }
  await apiJson("/api/profile/theme", {
    method: "PATCH",
    body: { theme },
  }).catch(() => {});
}

export async function fetchNfcLink(): Promise<NfcLinkState> {
  const data = await apiJson<NfcLinkState>("/api/nfc");
  setState({ nfc: data });
  return data;
}

export async function regenerateNfcLink(): Promise<NfcLinkState> {
  const data = await apiJson<NfcLinkState>("/api/nfc/regenerate", { method: "POST" });
  setState({ nfc: data });
  return data;
}

export async function revokeNfcLink(): Promise<NfcLinkState> {
  const data = await apiJson<{ revoked: boolean; token: null; path: null; updatedAt: string }>(
    "/api/nfc/revoke",
    { method: "POST" },
  );
  const next: NfcLinkState = {
    revoked: data.revoked,
    version: state.nfc?.version ?? 1,
    updatedAt: data.updatedAt,
    token: null,
    path: null,
  };
  setState({ nfc: next });
  return next;
}

export async function resolveNfcToken(
  token: string,
): Promise<
  | { status: "authorized"; owner?: PublicAccount }
  | { status: "login_required"; ownerHint?: string; signedInAsDifferentAccount?: boolean }
> {
  const headers = await getBearerHeaders();
  const resp = await fetch(`/api/nfc/resolve?token=${encodeURIComponent(token)}`, {
    headers,
    credentials: "include",
  });
  if (resp.status === 404) {
    throw new Error("This link is invalid or was revoked.");
  }
  const data = (await resp.json().catch(() => ({}))) as {
    status?: "authorized" | "login_required" | "invalid";
    owner?: PublicAccount;
    ownerHint?: string;
    signedInAsDifferentAccount?: boolean;
  };
  if (data.status === "invalid" || !data.status) {
    throw new Error("This link is invalid or was revoked.");
  }
  if (data.status === "authorized") {
    return {
      status: "authorized",
      ...(data.owner !== undefined ? { owner: data.owner } : {}),
    };
  }
  return {
    status: "login_required",
    ...(data.ownerHint !== undefined ? { ownerHint: data.ownerHint } : {}),
    ...(data.signedInAsDifferentAccount !== undefined
      ? { signedInAsDifferentAccount: data.signedInAsDifferentAccount }
      : {}),
  };
}

export async function discoverUsers(
  q = "",
  filter: "all" | "following" | "followers" = "all",
): Promise<PublicAccount[]> {
  if (!state.me) return [];
  const data = await apiJson<{ users: PublicAccount[] }>(
    `/api/users?q=${encodeURIComponent(q)}&filter=${encodeURIComponent(filter)}`,
  );
  const uniqueUsers = dedupeUsersById(data.users ?? [], state.me.id);
  if (!q && filter === "all") {
    setState({ discoveredUsers: uniqueUsers });
  }
  return uniqueUsers;
}

export async function searchUsers(q: string): Promise<PublicAccount[]> {
  if (!state.me) return [];
  const data = await apiJson<{ users: PublicAccount[] }>(
    `/api/users/search?q=${encodeURIComponent(q)}`,
  );
  return dedupeUsersById(data.users ?? [], state.me.id);
}

export async function fetchUserProfile(userId: string): Promise<PublicAccount> {
  const data = await apiJson<{ user: PublicAccount }>(`/api/users/${encodeURIComponent(userId)}`);
  return data.user;
}

export async function followUser(userId: string) {
  const data = await apiJson<{
    ok: boolean;
    isFollowing: boolean;
    followerCount: number;
    followingCount: number;
    myFollowingCount: number;
  }>(`/api/users/${encodeURIComponent(userId)}/follow`, { method: "POST" });

  setState({
    me: state.me ? { ...state.me, followingCount: data.myFollowingCount } : state.me,
    discoveredUsers: state.discoveredUsers.map((u) =>
      u.id === userId ? { ...u, isFollowing: true, followerCount: data.followerCount } : u,
    ),
  });
  return data;
}

export async function unfollowUser(userId: string) {
  const data = await apiJson<{
    ok: boolean;
    isFollowing: boolean;
    followerCount: number;
    followingCount: number;
    myFollowingCount: number;
  }>(`/api/users/${encodeURIComponent(userId)}/follow`, { method: "DELETE" });

  setState({
    me: state.me ? { ...state.me, followingCount: data.myFollowingCount } : state.me,
    discoveredUsers: state.discoveredUsers.map((u) =>
      u.id === userId ? { ...u, isFollowing: false, followerCount: data.followerCount } : u,
    ),
  });
  return data;
}

export async function loadConversations(): Promise<ConversationItem[]> {
  if (!state.me) return [];
  const data = await apiJson<{ conversations: ConversationItem[] }>("/api/conversations");
  const uniqueConversations = dedupeConversationsByPeerId(data.conversations ?? [], state.me.id);
  setState({ conversations: uniqueConversations });
  return uniqueConversations;
}

export function dismissIncomingMessageAlert() {
  if (state.incomingMessageAlert) {
    setState({ incomingMessageAlert: null });
  }
}

export async function openThread(peerId: string | null, options: { markSeen?: boolean } = {}) {
  if (!sendWs("thread:active", { peerId: peerId ?? "" }) && sseConnected && state.me) {
    void apiJson("/api/thread/active", {
      method: "POST",
      body: { peerId: peerId ?? "" },
    }).catch(() => {});
  }
  setState({
    activePeerId: peerId,
    hasOlderMessages: peerId ? Boolean(hasOlderByPeer.get(peerId)) : false,
    loadingOlderMessages: false,
    ...(peerId && state.incomingMessageAlert?.peer.id === peerId
      ? { incomingMessageAlert: null }
      : {}),
  });
  if (!peerId || !state.me) return;

  const data = await apiJson<{
    peer: PublicAccount;
    blockedByMe: boolean;
    blockedMe: boolean;
    pinned: boolean;
    muted: boolean;
    hasMore?: boolean;
    nextCursor?: { before: string; beforeId: string } | null;
    messages: ChatMessage[];
  }>(`/api/messages/${encodeURIComponent(peerId)}?limit=40`);

  const resolvedPeerId = data.peer?.id || peerId;
  hasOlderByPeer.set(peerId, Boolean(data.hasMore));
  cursorByPeer.set(peerId, data.nextCursor ?? null);

  const existingLocal = (state.threads[peerId] ?? []).filter(
    (m) => m.localStatus === "failed" || m.localStatus === "sending",
  );
  const existingRest = (state.threads[peerId] ?? []).filter((m) => !m.id.startsWith("temp_"));
  const mergedMessages = [
    ...mergePaginatedMessages(existingRest, data.messages ?? []),
    ...existingLocal,
  ];
  const uniqueMessages = dedupeMessagesById(mergedMessages);
  const nextConversations = dedupeConversationsByPeerId(
    state.conversations.some((c) => c.peer.id === resolvedPeerId || c.peer.id === peerId)
      ? state.conversations.map((c) =>
          c.peer.id === resolvedPeerId || c.peer.id === peerId
            ? {
                ...c,
                peer: data.peer,
                blockedByMe: data.blockedByMe,
                blockedMe: data.blockedMe,
                pinned: data.pinned,
                muted: data.muted,
                unreadCount: 0,
              }
            : c,
        )
      : [
          ...state.conversations,
          {
            peer: data.peer,
            blockedByMe: data.blockedByMe,
            blockedMe: data.blockedMe,
            pinned: data.pinned,
            muted: data.muted,
            lastMessage: uniqueMessages[uniqueMessages.length - 1] ?? null,
            unreadCount: 0,
          },
        ],
    state.me?.id,
  );

  setState({
    threads: { ...state.threads, [peerId]: uniqueMessages },
    conversations: nextConversations,
    ...(state.activePeerId === peerId ? { hasOlderMessages: Boolean(data.hasMore) } : {}),
  });

  if (options.markSeen !== false) {
    await markThreadSeen(peerId);
  }
}

export async function loadOlderMessages(peerId: string): Promise<void> {
  if (!state.me || !peerId || state.loadingOlderMessages) return;
  const cursor = cursorByPeer.get(peerId);
  if (!hasOlderByPeer.get(peerId) || !cursor) {
    setState({ hasOlderMessages: false, loadingOlderMessages: false });
    return;
  }

  setState({ loadingOlderMessages: true });
  try {
    const data = await apiJson<{
      hasMore?: boolean;
      nextCursor?: { before: string; beforeId: string } | null;
      messages: ChatMessage[];
    }>(
      `/api/messages/${encodeURIComponent(peerId)}?limit=40&before=${encodeURIComponent(cursor.before)}&beforeId=${encodeURIComponent(cursor.beforeId)}`,
    );

    hasOlderByPeer.set(peerId, Boolean(data.hasMore));
    cursorByPeer.set(peerId, data.nextCursor ?? null);

    const current = state.threads[peerId] ?? [];
    const localPending = current.filter(
      (m) => m.localStatus === "failed" || m.localStatus === "sending",
    );
    const serverCurrent = current.filter((m) => !m.id.startsWith("temp_"));
    const merged = [...mergePaginatedMessages(data.messages ?? [], serverCurrent), ...localPending];

    setState({
      threads: { ...state.threads, [peerId]: dedupeMessagesById(merged) },
      ...(state.activePeerId === peerId ? { hasOlderMessages: Boolean(data.hasMore) } : {}),
    });
  } finally {
    setState({ loadingOlderMessages: false });
  }
}

export async function searchThreadMessages(peerId: string, q: string): Promise<ChatMessage[]> {
  const data = await apiJson<{ messages: ChatMessage[] }>(
    `/api/messages/${encodeURIComponent(peerId)}?q=${encodeURIComponent(q)}`,
  );
  return data.messages;
}

export async function markThreadSeen(peerId: string) {
  if (!state.me) return;
  await apiJson(`/api/messages/${encodeURIComponent(peerId)}/seen`, { method: "POST" }).catch(
    () => {},
  );
  setState({
    conversations: state.conversations.map((c) =>
      c.peer.id === peerId ? { ...c, unreadCount: 0 } : c,
    ),
  });
}

async function uploadMediaViaServer(
  file: File,
  recipientId?: string,
  galleryScope: GalleryScope = "normal",
) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("galleryScope", parseGalleryScope(galleryScope));
  if (recipientId) {
    formData.append("recipientId", recipientId);
  }
  const sendUpload = async () => {
    const headers = await getBearerHeaders();
    delete headers["Content-Type"];
    return fetch("/api/media", {
      method: "POST",
      headers,
      credentials: "include",
      body: formData,
    });
  };

  let resp = await sendUpload();
  if (resp.status === 401) {
    const refreshed = await tryRefreshAuthSession();
    if (refreshed) {
      resp = await sendUpload();
    }
  }
  const data = (await resp.json().catch(() => ({}))) as {
    id?: string;
    kind?: MediaKind;
    mimeType?: string;
    originalName?: string;
    sizeBytes?: number;
    galleryScope?: GalleryScope;
    createdAt?: string;
    url?: string;
    mine?: boolean;
    error?: string;
  };
  if (!resp.ok || !data.id) {
    throw new Error(data.error || `Could not upload ${file.name} (${resp.status})`);
  }
  const kind: MediaKind =
    data.kind ??
    (file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "image");
  return {
    id: data.id,
    kind,
    mimeType: data.mimeType ?? file.type,
    originalName: data.originalName ?? file.name,
    sizeBytes: data.sizeBytes ?? file.size,
    galleryScope: parseGalleryScope(data.galleryScope ?? galleryScope),
    createdAt: data.createdAt ?? new Date().toISOString(),
    url: data.url ?? `/api/media/${data.id}`,
    mine: true,
  };
}

export async function uploadChatMedia(
  file: File,
  recipientId?: string,
  galleryScope: GalleryScope = "normal",
) {
  if (!state.me) throw new Error("Authentication required.");
  const scope = parseGalleryScope(galleryScope);
  let kind: MediaKind | null = file.type.startsWith("image/")
    ? "image"
    : file.type.startsWith("video/")
      ? "video"
      : file.type.startsWith("audio/")
        ? "audio"
        : null;

  if (!kind) {
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (["mp4", "webm", "mov", "m4v", "mkv", "3gp", "ogv"].includes(ext)) {
      kind = "video";
    } else if (["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "bmp", "svg"].includes(ext)) {
      kind = "image";
    } else if (["mp3", "wav", "ogg", "m4a", "aac", "weba"].includes(ext)) {
      kind = "audio";
    }
  }

  if (!kind) throw new Error("Choose a supported image, video, or audio file.");

  const effectiveMimeType =
    file.type && file.type !== "application/octet-stream"
      ? file.type
      : kind === "video"
        ? "video/mp4"
        : kind === "audio"
          ? "audio/webm"
          : "image/jpeg";

  let data: {
    id: string;
    kind: MediaKind;
    mimeType: string;
    originalName: string;
    sizeBytes: number;
    galleryScope?: GalleryScope;
    createdAt: string;
    url: string;
    mine: boolean;
  } | null = null;

  // 1. Attempt direct signed storage upload if Supabase is configured
  try {
    const ticket = await apiJson<{
      id: string;
      kind: MediaKind;
      mimeType: string;
      originalName: string;
      sizeBytes: number;
      galleryScope?: GalleryScope;
      createdAt: string;
      url: string;
      mine: boolean;
      storageKey: string;
      uploadToken: string;
      supabaseUrl?: string;
      anonKey?: string;
      recipientId: string | null;
    }>("/api/media/upload-ticket", {
      method: "POST",
      body: {
        kind,
        mimeType: effectiveMimeType,
        originalName: file.name,
        sizeBytes: file.size,
        galleryScope: scope,
        ...(recipientId ? { recipientId } : {}),
      },
    });

    if (ticket?.supabaseUrl && ticket?.anonKey && ticket?.uploadToken) {
      const storageClient = createClient(ticket.supabaseUrl, ticket.anonKey);
      const { error: uploadError } = await storageClient.storage
        .from("reading-corner-media")
        .uploadToSignedUrl(ticket.storageKey, ticket.uploadToken, file, {
          contentType: file.type,
          upsert: true,
        });

      if (!uploadError) {
        data = await apiJson<{
          id: string;
          kind: MediaKind;
          mimeType: string;
          originalName: string;
          sizeBytes: number;
          galleryScope?: GalleryScope;
          createdAt: string;
          url: string;
          mine: boolean;
        }>("/api/media/complete", {
          method: "POST",
          body: {
            id: ticket.id,
            kind: ticket.kind,
            mimeType: ticket.mimeType,
            originalName: ticket.originalName,
            sizeBytes: ticket.sizeBytes,
            galleryScope: scope,
            ...(ticket.recipientId ? { recipientId: ticket.recipientId } : {}),
          },
        });
      }
    }
  } catch {
    // If ticket generation or signed URL storage upload fails, smoothly fall through to server upload
    data = null;
  }

  // 2. Direct server upload fallback (works across local SQLite, container disk, and server storage)
  if (!data) {
    data = await uploadMediaViaServer(file, recipientId, scope);
  }

  primeMediaObjectUrl(data.url, file);
  uploadedMediaMeta.set(data.id, { url: data.url, kind: data.kind, name: data.originalName });
  if (data.kind === "image" || data.kind === "video") {
    const newItem: GalleryItem = {
      id: data.id,
      kind: data.kind,
      mimeType: data.mimeType || file.type,
      originalName: data.originalName || file.name,
      sizeBytes: data.sizeBytes,
      galleryScope: parseGalleryScope(data.galleryScope ?? scope),
      createdAt: data.createdAt,
      url: data.url,
      mine: true,
    };
    setState({ gallery: [newItem, ...state.gallery.filter((item) => item.id !== data.id)] });
  }
  return data;
}

export async function sendChatMessage(
  peerId: string,
  text: string,
  mediaId?: string | null,
  replyToId?: string | null,
  existingTempId?: string,
): Promise<ChatMessage> {
  if (!state.me) throw new Error("Authentication required.");

  const cleanText = text.trim().slice(0, 4000);
  const mediaMeta = mediaId ? (uploadedMediaMeta.get(mediaId) ?? null) : null;
  const optimisticText =
    cleanText ||
    (mediaMeta?.kind === "video"
      ? "Sent a video"
      : mediaMeta?.kind === "audio"
        ? "Voice note"
        : mediaMeta?.kind === "image"
          ? "Sent a photo"
          : "");

  if (!optimisticText && !mediaId) {
    throw new Error("Message text or media is required.");
  }

  const tempId = existingTempId ?? `temp_${crypto.randomUUID()}`;
  const existingFailed = (state.threads[peerId] ?? []).find((m) => m.id === tempId);
  const optimistic: ChatMessage = {
    id: tempId,
    threadKey: threadKeyFor(state.me.id, peerId),
    from: state.me.id,
    to: peerId,
    text: existingFailed?.text || optimisticText,
    mediaUrl: existingFailed?.mediaUrl ?? mediaMeta?.url ?? null,
    mediaId: mediaId ?? existingFailed?.mediaId ?? null,
    mediaKind: existingFailed?.mediaKind ?? mediaMeta?.kind ?? null,
    mediaName: existingFailed?.mediaName ?? mediaMeta?.name ?? null,
    replyToId: replyToId ?? null,
    replyTo: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    deliveredAt: null,
    createdAt: existingFailed?.createdAt ?? new Date().toISOString(),
    seenAt: null,
    localStatus: "sending",
    pendingRetry: {
      text: cleanText,
      mediaId: mediaId ?? null,
      replyToId: replyToId ?? null,
    },
  };
  upsertMessageIntoThread(peerId, optimistic);

  try {
    const res = await apiJson<{ message: ChatMessage; sender: PublicAccount }>("/api/messages", {
      method: "POST",
      body: { peerId, text: cleanText, mediaId: mediaId ?? null, replyToId: replyToId ?? null },
    });
    const existing = (state.threads[peerId] ?? []).filter((m) => m.id !== tempId);
    setState({ threads: { ...state.threads, [peerId]: existing } });
    handleIncomingMessageEvent(res.message, res.sender);
    return res.message;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Could not send message.";
    const failedList = (state.threads[peerId] ?? []).map((m) =>
      m.id === tempId
        ? {
            ...m,
            localStatus: "failed" as const,
            sendError: errMsg,
          }
        : m,
    );
    setState({ threads: { ...state.threads, [peerId]: failedList } });
    throw err;
  }
}

export async function retryChatMessage(
  peerId: string,
  tempId: string,
): Promise<ChatMessage | null> {
  const msg = (state.threads[peerId] ?? []).find((m) => m.id === tempId);
  if (!msg?.pendingRetry) return null;
  return sendChatMessage(
    peerId,
    msg.pendingRetry.text,
    msg.pendingRetry.mediaId,
    msg.pendingRetry.replyToId,
    tempId,
  );
}

export function dismissFailedMessage(peerId: string, tempId: string) {
  const next = (state.threads[peerId] ?? []).filter((m) => m.id !== tempId);
  setState({ threads: { ...state.threads, [peerId]: next } });
}

export async function editChatMessage(messageId: string, text: string): Promise<ChatMessage> {
  const res = await apiJson<{ message: ChatMessage }>(
    `/api/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      body: { text },
    },
  );
  if (state.me) {
    const peerId = res.message.from === state.me.id ? res.message.to : res.message.from;
    const msgs = state.threads[peerId];
    if (msgs) {
      setState({
        threads: {
          ...state.threads,
          [peerId]: msgs.map((m) => (m.id === messageId ? res.message : m)),
        },
      });
    }
  }
  return res.message;
}

export async function deleteChatMessage(messageId: string): Promise<ChatMessage> {
  const res = await apiJson<{ ok: boolean; message: ChatMessage }>(
    `/api/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE" },
  );
  if (state.me) {
    const peerId = res.message.from === state.me.id ? res.message.to : res.message.from;
    const msgs = state.threads[peerId];
    if (msgs) {
      setState({
        threads: {
          ...state.threads,
          [peerId]: msgs.map((m) => (m.id === messageId ? res.message : m)),
        },
      });
    }
  }
  return res.message;
}

export async function reactToMessage(
  messageId: string,
  emoji: string,
): Promise<MessageReactionGroup[]> {
  const res = await apiJson<{ ok: boolean; reactions: MessageReactionGroup[] }>(
    `/api/messages/${encodeURIComponent(messageId)}/reactions`,
    {
      method: "POST",
      body: { emoji },
    },
  );
  return res.reactions;
}

export async function updateConversationSettings(
  peerId: string,
  patch: { pinned?: boolean; muted?: boolean },
) {
  const res = await apiJson<{ ok: boolean; pinned: boolean; muted: boolean }>(
    `/api/conversations/${encodeURIComponent(peerId)}`,
    {
      method: "PATCH",
      body: patch,
    },
  );
  setState({
    conversations: state.conversations
      .map((c) => (c.peer.id === peerId ? { ...c, pinned: res.pinned, muted: res.muted } : c))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return (b.lastMessage?.createdAt ?? "").localeCompare(a.lastMessage?.createdAt ?? "");
      }),
  });
  return res;
}

export function sendTyping(peerId: string, active: boolean) {
  if (!state.me || !peerId) return;
  sendWs("typing", { peerId, active });
}

export async function fetchGallery(): Promise<GalleryItem[]> {
  if (!state.me) return [];
  try {
    const data = await apiJson<{ items?: GalleryItem[] }>("/api/gallery");
    const items = dedupeByKey(Array.isArray(data.items) ? data.items : [], (item) => item.id);
    for (const item of items) {
      uploadedMediaMeta.set(item.id, {
        url: item.url,
        kind: item.kind,
        name: item.originalName,
      });
    }
    setState({ gallery: items });
    return items;
  } catch {
    return state.gallery;
  }
}

export async function saveMediaToGallery(
  url: string,
  galleryScope: GalleryScope = "normal",
): Promise<void> {
  const mediaId = url.match(/\/api\/media\/([^/?#]+)/)?.[1];
  if (!mediaId) throw new Error("This media cannot be saved to your gallery.");
  await apiJson(`/api/media/${encodeURIComponent(mediaId)}/save`, {
    method: "POST",
    body: { galleryScope: parseGalleryScope(galleryScope) },
  });
  await fetchGallery();
}

export async function deleteGalleryMedia(mediaId: string): Promise<void> {
  await apiJson(`/api/media/${encodeURIComponent(mediaId)}`, { method: "DELETE" });
  uploadedMediaMeta.delete(mediaId);
  evictMediaObjectUrl(`/api/media/${mediaId}`);
  setState({
    gallery: state.gallery.filter((item) => item.id !== mediaId),
  });
}

export async function loadBlocks() {
  if (!state.me) return [];
  const data = await apiJson<{ blockedUsers: BlockedUserItem[] }>("/api/blocks");
  const uniqueBlocked = dedupeUsersById(data.blockedUsers ?? [], state.me.id);
  setState({ blockedUsers: uniqueBlocked });
  return uniqueBlocked;
}

export async function blockUser(targetUserId: string) {
  await apiJson("/api/blocks", {
    method: "POST",
    body: { targetUserId },
  });
  await Promise.allSettled([loadBlocks(), loadConversations(), discoverUsers()]);
}

export async function unblockUser(targetUserId: string) {
  await apiJson(`/api/blocks/${encodeURIComponent(targetUserId)}`, {
    method: "DELETE",
  });
  await Promise.allSettled([loadBlocks(), loadConversations(), discoverUsers()]);
}

export async function reportUser(reportedUserId: string, reason: string, details = "") {
  return apiJson<{ ok: boolean; reportId: string }>("/api/reports", {
    method: "POST",
    body: { reportedUserId, reason, details },
  });
}

export async function initiateCall(target: PublicAccount, kind: "audio" | "video") {
  warmUpCallAudio();
  const client = ensureCallClient();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    await connectRealtimeAsync();
  }
  await client.dial(target, kind);
}

export function respondToCall(
  id: string,
  _targetId: string,
  action: "accepted" | "declined" | "ended",
) {
  if (action === "accepted") {
    warmUpCallAudio();
  }
  void callClient?.respond(id, action);
}

export function setCallMicMuted(muted: boolean) {
  callClient?.setMicMuted(muted);
}

export function setCallCameraEnabled(enabled: boolean) {
  callClient?.setCameraEnabled(enabled);
}

export async function switchCallCamera() {
  await callClient?.switchCamera();
}

export function setSoundEnabled(enabled: boolean) {
  if (typeof window !== "undefined") {
    localStorage.setItem(SOUND_STORAGE_KEY, String(enabled));
  }
  setState({ soundEnabled: enabled });
}

export function initialsOf(name: string) {
  const parts = name
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/);
  return (parts[0]?.[0] ?? "?").concat(parts[1]?.[0] ?? "").toUpperCase();
}

export function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatRelative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

export async function fetchReadingState(): Promise<{
  state: Record<string, unknown> | null;
  updatedAt: string | null;
}> {
  if (!state.me) return { state: null, updatedAt: null };
  return apiJson<{ state: Record<string, unknown> | null; updatedAt: string | null }>(
    "/api/reading-state",
  );
}

export async function saveReadingState(readingState: Record<string, unknown>) {
  if (!state.me) throw new Error("Authentication required.");
  return apiJson<{ ok: boolean; updatedAt: string }>("/api/reading-state", {
    method: "PUT",
    body: { state: readingState },
  });
}
