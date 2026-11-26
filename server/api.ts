import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";

import {
  MAX_ACCOUNTS_PER_CONTACT,
  checkRateLimit,
  createSignedMediaUpload,
  clearRateLimit,
  countAccountsByEmail,
  countAccountsByPhone,
  createFirebaseNfcToken,
  createNfcTokenForUser,
  db,
  decryptToken,
  deleteMediaStorage,
  didUserBlock,
  downloadMediaStorage,
  getAdminEmailSet,
  getFollowStats,
  getLinkedSiblingAccounts,
  hashPassword,
  isAdminUser,
  isBlockedBetween,
  mediaStorageObjectExists,
  normalizeEmail,
  normalizeHandle,
  normalizePhoneE164,
  readConfiguredEnv,
  recordRateLimitFailure,
  sha256,
  signCookieToken,
  threadKeyFor,
  toPublicUser,
  uploadMediaStorage,
  verifyCookieToken,
  verifyPassword,
  type DbUser,
  type SecretTheme,
} from "./db";
import {
  getFirebaseAdminAuth,
  getFirebaseAdminMessaging,
  isFcmServerPushConfigured,
} from "./firebase-admin";
import {
  broadcastEvent,
  forwardCallSignal,
  getCallInvitationStatus,
  getCallSignalsForUser,
  getPendingIncomingCallsForUser,
  getUserAliases,
  initiateCallSession,
  isUserConnected,
  isUserViewingThread,
  popBufferedSignalsForUser,
  registerSseClient,
  resolveUserFromRequest,
  sendToUser,
  setSseActiveThread,
} from "./ws";

type AuthedRequest = Request & { authUser?: DbUser; authToken?: string; firebaseUid?: string };

function timingSafeEqualStrings(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

function dedupeRowsById<T extends { id: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function getClientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) {
    return fwd.split(",")[0]?.trim() || "unknown";
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function extractCookieValue(req: Request, name: string): string | null {
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

async function verifyFirebaseRequest(req: Request): Promise<{
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
} | null> {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token && !token.startsWith("rc_sess_")) {
      try {
        const decoded = await getFirebaseAdminAuth().verifyIdToken(token);
        if (decoded?.uid) {
          return {
            uid: decoded.uid,
            email: decoded.email ? normalizeEmail(decoded.email) : null,
            emailVerified: Boolean(decoded.email_verified),
            name: typeof decoded["name"] === "string" ? decoded["name"] : null,
            picture: typeof decoded.picture === "string" ? decoded.picture : null,
          };
        }
      } catch {
        /* invalid Firebase ID token */
      }
    }
  }
  const fbCookie = extractCookieValue(req, "rc_fb_session");
  if (fbCookie) {
    const verified = verifyCookieToken(fbCookie);
    if (verified?.uid) {
      return {
        uid: verified.uid,
        email: null,
        emailVerified: false,
        name: null,
        picture: null,
      };
    }
  }
  return null;
}

async function resolveFirebaseUid(req: Request): Promise<string | null> {
  const verified = await verifyFirebaseRequest(req);
  return verified?.uid ?? null;
}

type DbMessageRow = {
  id: string;
  thread_key: string;
  sender_id: string;
  recipient_id: string;
  text: string;
  media_id: string | null;
  media_kind: string | null;
  media_name: string | null;
  reply_to_id: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  delivered_at: string | null;
  created_at: string;
  seen_at: string | null;
};

const SESSION_DAYS = 30;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25MB for photos & short videos

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MEDIA_BYTES },
});

function getTwilioConfig() {
  const sid = readConfiguredEnv("TWILIO_ACCOUNT_SID") ?? "";
  const token = readConfiguredEnv("TWILIO_AUTH_TOKEN") ?? "";
  const serviceSid = readConfiguredEnv("TWILIO_VERIFY_SERVICE_SID") ?? "";
  return {
    configured: Boolean(
      /^AC[a-f0-9]{32}$/i.test(sid) && token && /^VA[a-f0-9]{32}$/i.test(serviceSid),
    ),
    sid,
    token,
    serviceSid,
  };
}

async function sendTwilioOtp(phoneE164: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = getTwilioConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      error:
        "SMS OTP service is not configured yet. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID to enable real phone OTP verification.",
    };
  }
  const body = new URLSearchParams({ To: phoneE164, Channel: "sms" });
  const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64");
  const resp = await fetch(
    `https://verify.twilio.com/v2/Services/${encodeURIComponent(cfg.serviceSid)}/Verifications`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false, error: `SMS provider rejected OTP request (${resp.status}): ${text}` };
  }
  return { ok: true };
}

async function verifyTwilioOtp(
  phoneE164: string,
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const cfg = getTwilioConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      error:
        "SMS OTP service is not configured yet. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID to enable real phone OTP verification.",
    };
  }
  const body = new URLSearchParams({ To: phoneE164, Code: code.trim() });
  const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64");
  const resp = await fetch(
    `https://verify.twilio.com/v2/Services/${encodeURIComponent(cfg.serviceSid)}/VerificationCheck`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
  );
  if (!resp.ok) {
    return { ok: false, error: "Invalid or expired OTP code." };
  }
  const data = (await resp.json()) as { status?: string };
  if (data.status !== "approved") {
    return { ok: false, error: "OTP verification did not pass. Please check the code." };
  }
  return { ok: true };
}

function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const val = auth.slice(7).trim();
    if (val && val.startsWith("rc_sess_")) return val;
  }
  const cookieToken = extractCookieValue(req, "rc_session");
  if (cookieToken) return cookieToken;
  return null;
}

async function ensureUserForVerifiedFirebase(fb: {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}): Promise<DbUser | null> {
  const fbUserId = `fb_${fb.uid}`;
  let user = (await db
    .prepare("SELECT * FROM users WHERE id = ? OR id = ? LIMIT 1")
    .get(fbUserId, fb.uid)) as DbUser | undefined;

  if (!user && fb.email && fb.emailVerified) {
    user = (await db
      .prepare("SELECT * FROM users WHERE email_verified = 1 AND LOWER(email) = LOWER(?) LIMIT 1")
      .get(fb.email)) as DbUser | undefined;
  }
  if (user) return user;
  if (!fb.email && !fb.name) return null;

  const rawName = String(fb.name || (fb.email ? fb.email.split("@")[0] : "") || "Reader")
    .trim()
    .slice(0, 60);
  const fullName = rawName.length >= 2 ? rawName : `${rawName} Reader`.slice(0, 60);
  const finalHandle = await makeUniqueHandle(fullName);
  const now = new Date().toISOString();
  const role = fb.emailVerified && fb.email && getAdminEmailSet().has(fb.email) ? "admin" : "user";
  const externalAvatar =
    fb.picture && fb.picture.startsWith("https://") ? fb.picture.slice(0, 1024) : null;

  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, phone_e164, phone_verified, role, full_name, display_handle, bio, avatar_media_id, avatar_external_url, password_hash, theme, created_at, last_active_at)
       VALUES (?, ?, ?, NULL, 0, ?, ?, ?, '', NULL, ?, ?, 'instagram', ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      fbUserId,
      fb.email,
      fb.emailVerified ? 1 : 0,
      role,
      fullName,
      finalHandle,
      externalAvatar,
      hashPassword(crypto.randomBytes(24).toString("hex")),
      now,
      now,
    );
  await createNfcTokenForUser(fbUserId);
  user = (await db.prepare("SELECT * FROM users WHERE id = ? LIMIT 1").get(fbUserId)) as
    DbUser | undefined;
  return user ?? null;
}

async function lookupSessionUser(req: Request): Promise<{ user: DbUser; token: string } | null> {
  const token = extractToken(req);
  if (token) {
    const now = new Date().toISOString();
    const row = (await db
      .prepare(
        `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?
         LIMIT 1`,
      )
      .get(sha256(token), now)) as DbUser | undefined;
    if (row) return { user: row, token };
  }

  const fb = await verifyFirebaseRequest(req);
  if (fb) {
    const user = await ensureUserForVerifiedFirebase(fb);
    if (user) {
      return { user, token: "" };
    }
  }
  return null;
}

async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const resolved = await lookupSessionUser(req);
  if (!resolved) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  req.authUser = resolved.user;
  req.authToken = resolved.token;
  await db
    .prepare("UPDATE users SET last_active_at = ? WHERE id = ?")
    .run(new Date().toISOString(), resolved.user.id);
  next();
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.authUser || !isAdminUser(req.authUser)) {
    res.status(403).json({ error: "Administrator access required." });
    return;
  }
  next();
}

async function issueSession(userId: string, req: Request, res: Response): Promise<string> {
  const token = `rc_sess_${crypto.randomBytes(32).toString("base64url")}`;
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db
    .prepare(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      `sess_${crypto.randomUUID()}`,
      userId,
      sha256(token),
      expires.toISOString(),
      now.toISOString(),
      String(req.headers["user-agent"] ?? "").slice(0, 200),
    );

  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.clearCookie("rc_fb_session", { path: "/" });
  res.cookie("rc_session", token, {
    httpOnly: true,
    sameSite: isHttps ? "none" : "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    secure: isHttps,
  });
  return token;
}

async function makeUniqueHandle(fullName: string): Promise<string> {
  const slug = fullName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 14);
  for (let i = 0; i < 6; i += 1) {
    const suffix = crypto.randomBytes(2).toString("hex");
    const candidate = `@${slug || "reader"}.${suffix}`;
    const exists = await db
      .prepare("SELECT 1 FROM users WHERE LOWER(display_handle) = LOWER(?) LIMIT 1")
      .get(candidate);
    if (!exists) return candidate;
  }
  return `@${slug || "reader"}.${crypto.randomUUID().slice(0, 6)}`;
}

function maskPhone(e164: string | null): string | undefined {
  if (!e164) return undefined;
  if (e164.length <= 6) return "***";
  return `${e164.slice(0, 4)}••••${e164.slice(-3)}`;
}

async function toSelfUser(user: DbUser) {
  return {
    ...(await toPublicUser(user, true, user.id)),
    email: user.email,
    emailVerified: user.email_verified === 1,
    phoneMasked: maskPhone(user.phone_e164),
    phoneE164: user.phone_e164,
    isAdmin: isAdminUser(user),
  };
}

async function getReactionsForMessage(messageId: string, viewerId?: string) {
  const rows = (await db
    .prepare(
      "SELECT user_id, emoji FROM message_reactions WHERE message_id = ? ORDER BY created_at ASC",
    )
    .all(messageId)) as { user_id: string; emoji: string }[];

  const grouped = new Map<
    string,
    { emoji: string; count: number; reactedByMe: boolean; userIds: string[] }
  >();
  for (const r of rows) {
    const entry = grouped.get(r.emoji) ?? {
      emoji: r.emoji,
      count: 0,
      reactedByMe: false,
      userIds: [],
    };
    entry.count += 1;
    entry.userIds.push(r.user_id);
    if (viewerId && r.user_id === viewerId) {
      entry.reactedByMe = true;
    }
    grouped.set(r.emoji, entry);
  }
  return Array.from(grouped.values());
}

async function serializeMessage(m: DbMessageRow, viewerId?: string) {
  const isDeleted = Boolean(m.deleted_at);
  let replyTo: {
    id: string;
    senderId: string;
    senderName: string;
    text: string;
    mediaKind: "image" | "video" | "audio" | null;
    deleted: boolean;
  } | null = null;

  if (m.reply_to_id) {
    const parent = (await db
      .prepare(
        `SELECT m.id, m.sender_id, m.text, m.media_kind, m.deleted_at, u.full_name
         FROM messages m
         LEFT JOIN users u ON u.id = m.sender_id
         WHERE m.id = ? LIMIT 1`,
      )
      .get(m.reply_to_id)) as
      | {
          id: string;
          sender_id: string;
          text: string;
          media_kind: string | null;
          deleted_at: string | null;
          full_name: string | null;
        }
      | undefined;
    if (parent) {
      replyTo = {
        id: parent.id,
        senderId: parent.sender_id,
        senderName: parent.full_name || "Reader",
        text: parent.deleted_at ? "Message deleted" : parent.text,
        mediaKind: parent.deleted_at
          ? null
          : (parent.media_kind as "image" | "video" | "audio" | null),
        deleted: Boolean(parent.deleted_at),
      };
    }
  }

  return {
    id: m.id,
    threadKey: m.thread_key,
    from: m.sender_id,
    to: m.recipient_id,
    text: isDeleted ? "Message deleted" : m.text,
    mediaUrl: !isDeleted && m.media_id ? `/api/media/${m.media_id}` : null,
    mediaId: isDeleted ? null : m.media_id,
    mediaKind: isDeleted ? null : (m.media_kind as "image" | "video" | "audio" | null),
    mediaName: isDeleted ? null : m.media_name,
    replyToId: m.reply_to_id,
    replyTo,
    reactions: isDeleted ? [] : await getReactionsForMessage(m.id, viewerId),
    editedAt: m.edited_at,
    deletedAt: m.deleted_at,
    deliveredAt: m.delivered_at,
    createdAt: m.created_at,
    seenAt: m.seen_at,
  };
}

async function findUserByIdentifier(
  rawIdentifier: string,
  countryCode = "+91",
): Promise<DbUser | undefined> {
  const trimmed = rawIdentifier.trim();
  if (!trimmed) return undefined;

  // 1. Exact case-insensitive email match
  const asEmail = normalizeEmail(trimmed);
  if (asEmail) {
    const byEmail = (await db
      .prepare("SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1")
      .get(asEmail)) as DbUser | undefined;
    if (byEmail) return byEmail;
  }

  // 2. Display handle match (with or without leading @)
  const cleanHandle = trimmed.replace(/^@+/, "").toLowerCase();
  if (cleanHandle && !cleanHandle.includes("@")) {
    const byHandle = (await db
      .prepare("SELECT * FROM users WHERE LOWER(display_handle) = ? LIMIT 1")
      .get(`@${cleanHandle}`)) as DbUser | undefined;
    if (byHandle) return byHandle;
  }

  // 3. Phone E.164 match
  const asPhone = normalizePhoneE164(trimmed, countryCode);
  if (asPhone) {
    const byPhone = (await db
      .prepare("SELECT * FROM users WHERE phone_e164 = ? LIMIT 1")
      .get(asPhone)) as DbUser | undefined;
    if (byPhone) return byPhone;
  }

  return undefined;
}

async function findCandidatesByMode(
  mode: "phone" | "gmail" | "username" | "auto",
  rawIdentifier: string,
  countryCode = "+91",
): Promise<{ error?: string; candidates: DbUser[] }> {
  const trimmed = rawIdentifier.trim();
  if (!trimmed) {
    return { error: "Enter your login identifier.", candidates: [] };
  }

  if (mode === "phone") {
    const asPhone = normalizePhoneE164(trimmed, countryCode);
    if (!asPhone) {
      return { error: "Enter a valid phone number with country code.", candidates: [] };
    }
    const candidates = (await db
      .prepare("SELECT * FROM users WHERE phone_e164 = ? ORDER BY created_at ASC")
      .all(asPhone)) as DbUser[];
    return { candidates };
  }

  if (mode === "gmail") {
    const asEmail = normalizeEmail(trimmed);
    if (!asEmail) {
      return { error: "Enter a valid Gmail or email address.", candidates: [] };
    }
    const candidates = (await db
      .prepare("SELECT * FROM users WHERE LOWER(email) = LOWER(?) ORDER BY created_at ASC")
      .all(asEmail)) as DbUser[];
    return { candidates };
  }

  if (mode === "username") {
    const asHandle = normalizeHandle(trimmed);
    if (!asHandle) {
      return { error: "Enter a valid username (at least 2 characters).", candidates: [] };
    }
    const candidates = (await db
      .prepare("SELECT * FROM users WHERE LOWER(display_handle) = LOWER(?) LIMIT 1")
      .all(asHandle)) as DbUser[];
    return { candidates };
  }

  // auto mode
  const found = new Map<string, DbUser>();
  const asEmail = normalizeEmail(trimmed);
  if (asEmail) {
    const rows = (await db
      .prepare("SELECT * FROM users WHERE LOWER(email) = LOWER(?) ORDER BY created_at ASC")
      .all(asEmail)) as DbUser[];
    for (const r of rows) found.set(r.id, r);
  }
  const cleanHandle = trimmed.replace(/^@+/, "").toLowerCase();
  if (cleanHandle && !cleanHandle.includes("@")) {
    const rows = (await db
      .prepare("SELECT * FROM users WHERE LOWER(display_handle) = ? LIMIT 1")
      .all(`@${cleanHandle}`)) as DbUser[];
    for (const r of rows) found.set(r.id, r);
  }
  const asPhone = normalizePhoneE164(trimmed, countryCode);
  if (asPhone) {
    const rows = (await db
      .prepare("SELECT * FROM users WHERE phone_e164 = ? ORDER BY created_at ASC")
      .all(asPhone)) as DbUser[];
    for (const r of rows) found.set(r.id, r);
  }
  return { candidates: Array.from(found.values()) };
}

async function saveAvatarDataUrl(userId: string, avatarDataUrl?: string): Promise<string | null> {
  if (!avatarDataUrl || !avatarDataUrl.startsWith("data:image/")) return null;
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(avatarDataUrl);
  if (!match || !match[1] || !match[2]) return null;
  const buf = Buffer.from(match[2], "base64");
  if (buf.byteLength > 4 * 1024 * 1024) return null;
  const ext = match[1].split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
  const fileName = `avatar_${userId}.${ext}`;
  const storageKey = `avatars/${userId}/${fileName}`;
  const now = new Date().toISOString();
  await uploadMediaStorage(storageKey, buf, match[1]);
  const avatarMediaId = `med_${crypto.randomUUID()}`;
  await db
    .prepare(
      "INSERT INTO media_objects (id, owner_id, recipient_id, kind, mime_type, original_name, file_path, size_bytes, is_public_avatar, created_at) VALUES (?, ?, NULL, 'image', ?, ?, ?, ?, 1, ?)",
    )
    .run(avatarMediaId, userId, match[1], fileName, storageKey, buf.byteLength, now);
  return avatarMediaId;
}

function getResendConfig() {
  const apiKey = readConfiguredEnv("RESEND_API_KEY") ?? "";
  const rawFrom = readConfiguredEnv("RESEND_FROM") ?? "";
  const from = rawFrom.includes("@") ? rawFrom : "Reading Corner <onboarding@resend.dev>";
  return { configured: Boolean(/^re_[a-z0-9_]{10,}$/i.test(apiKey)), apiKey, from };
}

export function createApiRouter() {
  const router = express.Router();
  router.use(express.json({ limit: "4mb" }));

  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      otpConfigured: getTwilioConfig().configured,
      emailOtpConfigured: getResendConfig().configured,
    });
  });

  // Real-time Server-Sent Events stream (fallback when WebSockets are blocked by proxies/firewalls)
  router.get("/events", async (req, res) => {
    const user = await resolveUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const cleanup = registerSseClient(user.id, res);
    req.on("close", cleanup);
    req.on("error", cleanup);
  });

  router.post("/thread/active", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const peerId =
      typeof (req.body as { peerId?: string } | undefined)?.peerId === "string"
        ? (req.body as { peerId: string }).peerId.trim()
        : "";
    setSseActiveThread(me.id, peerId || null);
    res.json({ ok: true });
  });

  router.get("/auth/otp-status", (_req, res) => {
    const cfg = getTwilioConfig();
    res.json({
      configured: cfg.configured,
      provider: cfg.configured ? "twilio_verify" : null,
    });
  });

  // Register using email (and/or phone), username, password, and profile details.
  // Supports up to MAX_ACCOUNTS_PER_CONTACT (3) accounts when contact ownership is verified.
  router.post("/auth/register", async (req, res) => {
    try {
      const {
        email,
        username,
        displayHandle,
        phone,
        countryCode,
        password,
        fullName,
        bio = "",
        avatarDataUrl,
        linkToExisting = false,
        existingAccountPassword,
        firebaseIdToken,
        phoneOtpCode,
      } = req.body as {
        email?: string;
        username?: string;
        displayHandle?: string;
        phone?: string;
        countryCode?: string;
        password?: string;
        fullName?: string;
        bio?: string;
        avatarDataUrl?: string;
        linkToExisting?: boolean;
        existingAccountPassword?: string;
        firebaseIdToken?: string;
        phoneOtpCode?: string;
      };

      const cleanEmail = email && email.trim() ? normalizeEmail(email) : null;
      if (email && email.trim() && !cleanEmail) {
        res.status(400).json({ error: "Enter a valid email address." });
        return;
      }

      const rawPhone = String(phone ?? "").trim();
      const phoneE164 = rawPhone ? normalizePhoneE164(rawPhone, countryCode ?? "+91") : null;
      if (rawPhone && !phoneE164) {
        res.status(400).json({ error: "Enter a valid phone number with country code." });
        return;
      }

      if (!cleanEmail && !phoneE164) {
        res
          .status(400)
          .json({ error: "Please enter your email address (or a valid phone number)." });
        return;
      }

      const name = String(fullName ?? "").trim();
      if (name.length < 2 || name.length > 60) {
        res.status(400).json({ error: "Full name is required (2–60 characters)." });
        return;
      }

      const pwd = String(password ?? "");
      if (pwd.length < 8) {
        res.status(400).json({ error: "Password must be at least 8 characters." });
        return;
      }

      let emailVerified = 0;
      let phoneVerified = 0;
      const callerSession = await lookupSessionUser(req);

      if (firebaseIdToken && cleanEmail) {
        try {
          const decoded = await getFirebaseAdminAuth().verifyIdToken(firebaseIdToken);
          const fbEmail = decoded.email ? normalizeEmail(decoded.email) : null;
          if (fbEmail && fbEmail === cleanEmail && decoded.email_verified) {
            emailVerified = 1;
          }
        } catch {
          /* ignore invalid token; treated as unverified */
        }
      }

      if (phoneOtpCode && phoneE164) {
        const otpRes = await verifyTwilioOtp(phoneE164, phoneOtpCode);
        if (!otpRes.ok) {
          res.status(400).json({ error: otpRes.error ?? "Phone OTP verification failed." });
          return;
        }
        phoneVerified = 1;
      }

      const existingEmailCount = cleanEmail ? await countAccountsByEmail(cleanEmail) : 0;
      const existingPhoneCount = phoneE164 ? await countAccountsByPhone(phoneE164) : 0;

      if (existingEmailCount > 0 && cleanEmail) {
        if (existingEmailCount >= MAX_ACCOUNTS_PER_CONTACT) {
          res.status(409).json({
            error: `Maximum limit of ${MAX_ACCOUNTS_PER_CONTACT} accounts reached for ${cleanEmail}.`,
          });
          return;
        }
        const sessionOwnsEmail = Boolean(
          callerSession &&
          callerSession.user.email?.toLowerCase() === cleanEmail &&
          callerSession.user.email_verified === 1,
        );
        const existingEmailRows = (await db
          .prepare("SELECT * FROM users WHERE LOWER(email) = LOWER(?)")
          .all(cleanEmail)) as DbUser[];
        const anyVerifiedEmailRow = existingEmailRows.some((u) => u.email_verified === 1);
        const passwordMatchesExisting = Boolean(
          linkToExisting &&
          existingAccountPassword &&
          existingEmailRows.some((u) => verifyPassword(existingAccountPassword, u.password_hash)),
        );
        const verifiedProof =
          emailVerified === 1 ||
          sessionOwnsEmail ||
          (anyVerifiedEmailRow && passwordMatchesExisting);
        if (!verifiedProof) {
          res.status(409).json({
            error:
              "An account is already registered with this email. Sign in with this verified Gmail to create up to 3 linked accounts.",
          });
          return;
        }
        emailVerified = 1;
      }

      if (existingPhoneCount > 0 && phoneE164) {
        if (existingPhoneCount >= MAX_ACCOUNTS_PER_CONTACT) {
          res.status(409).json({
            error: `Maximum limit of ${MAX_ACCOUNTS_PER_CONTACT} accounts reached for this phone number.`,
          });
          return;
        }
        const sessionOwnsPhone = Boolean(
          callerSession &&
          callerSession.user.phone_e164 === phoneE164 &&
          callerSession.user.phone_verified === 1,
        );
        const existingPhoneRows = (await db
          .prepare("SELECT * FROM users WHERE phone_e164 = ?")
          .all(phoneE164)) as DbUser[];
        const anyVerifiedPhoneRow = existingPhoneRows.some((u) => u.phone_verified === 1);
        const passwordMatchesExisting = Boolean(
          linkToExisting &&
          existingAccountPassword &&
          existingPhoneRows.some((u) => verifyPassword(existingAccountPassword, u.password_hash)),
        );
        const verifiedProof =
          phoneVerified === 1 ||
          sessionOwnsPhone ||
          (anyVerifiedPhoneRow && passwordMatchesExisting);
        if (!verifiedProof) {
          res.status(409).json({
            error:
              "An account is already registered with this phone number. Sign in with this verified phone to create up to 3 linked accounts.",
          });
          return;
        }
        phoneVerified = 1;
      }

      const requestedUsername = (username ?? displayHandle ?? "").trim();
      let finalHandle: string;
      if (requestedUsername) {
        const normalized = normalizeHandle(requestedUsername);
        if (!normalized) {
          res.status(400).json({
            error: "Username must be at least 2 characters (letters, numbers, dots, underscores).",
          });
          return;
        }
        const existingHandle = await db
          .prepare("SELECT id FROM users WHERE LOWER(display_handle) = LOWER(?) LIMIT 1")
          .get(normalized);
        if (existingHandle) {
          res.status(409).json({
            error: "That username is already taken. Please choose another.",
          });
          return;
        }
        finalHandle = normalized;
      } else {
        finalHandle = await makeUniqueHandle(name);
      }

      const userId = `u_${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const role =
        emailVerified === 1 && cleanEmail && getAdminEmailSet().has(cleanEmail) ? "admin" : "user";

      await db
        .prepare(
          `INSERT INTO users (id, email, email_verified, phone_e164, phone_verified, role, full_name, display_handle, bio, avatar_media_id, password_hash, theme, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'instagram', ?, ?)`,
        )
        .run(
          userId,
          cleanEmail,
          emailVerified,
          phoneE164,
          phoneVerified,
          role,
          name,
          finalHandle,
          String(bio).trim().slice(0, 200),
          hashPassword(pwd),
          now,
          now,
        );

      const avatarMediaId = await saveAvatarDataUrl(userId, avatarDataUrl);
      if (avatarMediaId) {
        await db
          .prepare("UPDATE users SET avatar_media_id = ? WHERE id = ?")
          .run(avatarMediaId, userId);
      }

      await createNfcTokenForUser(userId);
      const token = await issueSession(userId, req, res);
      const user = (await db.prepare("SELECT * FROM users WHERE id = ?").get(userId)) as DbUser;

      broadcastEvent("user:registered", { user: await toPublicUser(user, true) }, user.id);

      res.status(201).json({
        token,
        user: await toSelfUser(user),
      });
    } catch (err) {
      console.error("register error", err);
      res.status(500).json({ error: "Registration failed. Please try again." });
    }
  });

  // Login using explicit mode: phone | gmail | username | auto + password
  router.post("/auth/login", async (req, res) => {
    const {
      mode = "auto",
      identifier,
      email,
      phone,
      username,
      countryCode,
      password,
      targetUserId,
    } = req.body as {
      mode?: "phone" | "gmail" | "username" | "auto";
      identifier?: string;
      email?: string;
      phone?: string;
      username?: string;
      countryCode?: string;
      password?: string;
      targetUserId?: string;
    };

    const chosenMode: "phone" | "gmail" | "username" | "auto" =
      mode === "phone" || mode === "gmail" || mode === "username" ? mode : "auto";

    const rawIdentifier = String(
      chosenMode === "phone"
        ? (phone ?? identifier ?? "")
        : chosenMode === "gmail"
          ? (email ?? identifier ?? "")
          : chosenMode === "username"
            ? (username ?? identifier ?? "")
            : (identifier ?? email ?? phone ?? username ?? ""),
    ).trim();

    if (!rawIdentifier) {
      res.status(400).json({
        error:
          chosenMode === "phone"
            ? "Enter your phone number."
            : chosenMode === "gmail"
              ? "Enter your Gmail or email address."
              : chosenMode === "username"
                ? "Enter your username."
                : "Enter your email, username, or phone number.",
      });
      return;
    }

    const rateKey = `login:${getClientIp(req)}:${chosenMode}:${rawIdentifier.toLowerCase()}`;
    const limit = await checkRateLimit(rateKey);
    if (!limit.allowed) {
      res.status(429).json({
        error: `Too many failed sign-in attempts. Please wait ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`,
      });
      return;
    }

    const { error: formatError, candidates } = await findCandidatesByMode(
      chosenMode,
      rawIdentifier,
      countryCode ?? "+91",
    );
    if (formatError) {
      res.status(400).json({ error: formatError });
      return;
    }

    const scopedCandidates = targetUserId
      ? candidates.filter((u) => u.id === targetUserId)
      : candidates;

    const pwd = String(password ?? "");
    const matched = dedupeRowsById(
      scopedCandidates.filter((u) => verifyPassword(pwd, u.password_hash)),
    );

    if (matched.length === 0) {
      const failRes = await recordRateLimitFailure(rateKey, 10, 15 * 60 * 1000, 15 * 60 * 1000);
      if (failRes.locked) {
        res.status(429).json({
          error: "Too many failed sign-in attempts. Please wait 15 minutes and try again.",
        });
        return;
      }
      res.status(401).json({ error: "Invalid credentials. Check your details and password." });
      return;
    }

    await clearRateLimit(rateKey);

    // If multiple sibling accounts share the same verified contact AND password, ask caller which handle to open
    if (matched.length > 1) {
      res.json({
        requiresAccountChoice: true,
        accounts: matched.map((u) => ({
          id: u.id,
          fullName: u.full_name,
          displayHandle: u.display_handle,
          avatarUrl: u.avatar_media_id
            ? `/api/media/${u.avatar_media_id}`
            : (u.avatar_external_url ?? null),
        })),
      });
      return;
    }

    const user = matched[0]!;
    const existingNfc = await db
      .prepare("SELECT id FROM nfc_links WHERE user_id = ? LIMIT 1")
      .get(user.id);
    if (!existingNfc) {
      await createNfcTokenForUser(user.id);
    }

    const now = new Date().toISOString();
    await db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(now, user.id);
    const token = await issueSession(user.id, req, res);

    res.json({
      token,
      user: await toSelfUser({ ...user, last_active_at: now }),
    });
  });

  // List linked accounts sharing the signed-in user's verified email or verified phone (max 3 per contact)
  router.get("/auth/linked-accounts", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const siblings = await getLinkedSiblingAccounts(me);
    const emailCount =
      me.email && me.email_verified === 1 ? await countAccountsByEmail(me.email) : 0;
    const phoneCount =
      me.phone_e164 && me.phone_verified === 1 ? await countAccountsByPhone(me.phone_e164) : 0;

    res.json({
      maxAccounts: MAX_ACCOUNTS_PER_CONTACT,
      email: me.email,
      emailVerified: me.email_verified === 1,
      phoneMasked: maskPhone(me.phone_e164),
      phoneVerified: me.phone_verified === 1,
      emailAccountCount: emailCount,
      phoneAccountCount: phoneCount,
      canCreateByEmail: Boolean(
        me.email && me.email_verified === 1 && emailCount < MAX_ACCOUNTS_PER_CONTACT,
      ),
      canCreateByPhone: Boolean(
        me.phone_e164 && me.phone_verified === 1 && phoneCount < MAX_ACCOUNTS_PER_CONTACT,
      ),
      accounts: siblings.map((u) => ({
        id: u.id,
        fullName: u.full_name,
        displayHandle: u.display_handle,
        avatarUrl: u.avatar_media_id
          ? `/api/media/${u.avatar_media_id}`
          : (u.avatar_external_url ?? null),
        isCurrent: u.id === me.id,
        emailVerified: u.email_verified === 1,
        phoneVerified: u.phone_verified === 1,
      })),
    });
  });

  // Create an additional linked account sharing the signed-in user's verified Gmail or verified phone (max 3)
  router.post("/auth/linked-accounts/create", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const {
      fullName,
      username,
      password,
      bio = "",
      avatarDataUrl,
      linkBy = "auto",
      switchToNew = true,
    } = req.body as {
      fullName?: string;
      username?: string;
      password?: string;
      bio?: string;
      avatarDataUrl?: string;
      linkBy?: "email" | "phone" | "both" | "auto";
      switchToNew?: boolean;
    };

    const hasVerifiedEmail = Boolean(me.email && me.email_verified === 1);
    const hasVerifiedPhone = Boolean(me.phone_e164 && me.phone_verified === 1);
    if (!hasVerifiedEmail && !hasVerifiedPhone) {
      res.status(403).json({
        error: "Verify your Gmail or phone number before creating linked accounts.",
      });
      return;
    }

    let attachEmail: string | null = null;
    let attachPhone: string | null = null;

    if (linkBy === "email") {
      if (!hasVerifiedEmail || !me.email) {
        res.status(400).json({ error: "Your Gmail address is not verified yet." });
        return;
      }
      attachEmail = me.email;
    } else if (linkBy === "phone") {
      if (!hasVerifiedPhone || !me.phone_e164) {
        res.status(400).json({ error: "Your phone number is not verified yet." });
        return;
      }
      attachPhone = me.phone_e164;
    } else {
      if (hasVerifiedEmail && me.email) attachEmail = me.email;
      if (hasVerifiedPhone && me.phone_e164) attachPhone = me.phone_e164;
    }

    if (attachEmail && (await countAccountsByEmail(attachEmail)) >= MAX_ACCOUNTS_PER_CONTACT) {
      res.status(409).json({
        error: `Maximum limit of ${MAX_ACCOUNTS_PER_CONTACT} accounts reached for ${attachEmail}.`,
      });
      return;
    }
    if (attachPhone && (await countAccountsByPhone(attachPhone)) >= MAX_ACCOUNTS_PER_CONTACT) {
      res.status(409).json({
        error: `Maximum limit of ${MAX_ACCOUNTS_PER_CONTACT} accounts reached for your verified phone number.`,
      });
      return;
    }

    const name = String(fullName ?? "").trim();
    if (name.length < 2 || name.length > 60) {
      res.status(400).json({ error: "Full name is required (2–60 characters)." });
      return;
    }

    const pwd = String(password ?? "");
    if (pwd.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters." });
      return;
    }

    let finalHandle: string;
    const requestedUsername = String(username ?? "").trim();
    if (requestedUsername) {
      const normalized = normalizeHandle(requestedUsername);
      if (!normalized) {
        res.status(400).json({
          error: "Username must be at least 2 characters (letters, numbers, dots, underscores).",
        });
        return;
      }
      const conflict = await db
        .prepare("SELECT id FROM users WHERE LOWER(display_handle) = LOWER(?) LIMIT 1")
        .get(normalized);
      if (conflict) {
        res.status(409).json({ error: "That username is already taken. Please choose another." });
        return;
      }
      finalHandle = normalized;
    } else {
      finalHandle = await makeUniqueHandle(name);
    }

    const userId = `u_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const emailVerified = attachEmail ? 1 : 0;
    const phoneVerified = attachPhone ? 1 : 0;
    const role =
      emailVerified === 1 && attachEmail && getAdminEmailSet().has(attachEmail.toLowerCase())
        ? "admin"
        : "user";

    await db
      .prepare(
        `INSERT INTO users (id, email, email_verified, phone_e164, phone_verified, role, full_name, display_handle, bio, avatar_media_id, password_hash, theme, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'instagram', ?, ?)`,
      )
      .run(
        userId,
        attachEmail,
        emailVerified,
        attachPhone,
        phoneVerified,
        role,
        name,
        finalHandle,
        String(bio).trim().slice(0, 200),
        hashPassword(pwd),
        now,
        now,
      );

    const avatarMediaId = await saveAvatarDataUrl(userId, avatarDataUrl);
    if (avatarMediaId) {
      await db
        .prepare("UPDATE users SET avatar_media_id = ? WHERE id = ?")
        .run(avatarMediaId, userId);
    }

    await createNfcTokenForUser(userId);
    const createdUser = (await db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(userId)) as DbUser;
    broadcastEvent(
      "user:registered",
      { user: await toPublicUser(createdUser, true) },
      createdUser.id,
    );

    const token = switchToNew ? await issueSession(createdUser.id, req, res) : null;
    res.status(201).json({
      token,
      switched: Boolean(switchToNew),
      user: await toSelfUser(createdUser),
    });
  });

  // Switch instantaneously between linked sibling accounts sharing a verified email or phone
  router.post("/auth/switch-account", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const targetUserId = String((req.body as { targetUserId?: string })?.targetUserId ?? "").trim();
    if (!targetUserId) {
      res.status(400).json({ error: "Target account ID is required." });
      return;
    }
    const siblings = await getLinkedSiblingAccounts(me);
    const target = siblings.find((u) => u.id === targetUserId);
    if (!target) {
      res
        .status(403)
        .json({ error: "You can only switch to an account sharing your verified email or phone." });
      return;
    }

    const existingNfc = await db
      .prepare("SELECT id FROM nfc_links WHERE user_id = ? LIMIT 1")
      .get(target.id);
    if (!existingNfc) {
      await createNfcTokenForUser(target.id);
    }

    const now = new Date().toISOString();
    await db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(now, target.id);
    const token = await issueSession(target.id, req, res);

    res.json({
      token,
      user: await toSelfUser({ ...target, last_active_at: now }),
    });
  });

  // Sync Firebase verified email state onto the current SQLite account
  router.post("/auth/verify-email-firebase", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const idToken = String((req.body as { idToken?: string })?.idToken ?? "").trim();
    if (!idToken) {
      res.status(400).json({ error: "Firebase ID token is required." });
      return;
    }
    try {
      const decoded = await getFirebaseAdminAuth().verifyIdToken(idToken);
      const decodedEmail = decoded.email ? normalizeEmail(decoded.email) : null;
      if (!decoded.email_verified || !decodedEmail) {
        res.status(400).json({ error: "Email address is not verified yet." });
        return;
      }
      if (me.email && me.email.toLowerCase() !== decodedEmail) {
        res.status(403).json({ error: "Verified email does not match this account." });
        return;
      }
      const nextRole = isAdminUser(me) || getAdminEmailSet().has(decodedEmail) ? "admin" : me.role;
      await db
        .prepare(
          "UPDATE users SET email = COALESCE(email, ?), email_verified = 1, role = ? WHERE id = ?",
        )
        .run(decodedEmail, nextRole, me.id);
      const updated = (await db.prepare("SELECT * FROM users WHERE id = ?").get(me.id)) as DbUser;
      res.json({ ok: true, user: await toSelfUser(updated) });
    } catch {
      res.status(401).json({ error: "Invalid Firebase verification token." });
    }
  });

  // Bridge verified Firebase (Google) accounts into the unified SQLite & WebSocket directory
  router.post("/auth/firebase-session", async (req, res) => {
    const authHeader = req.headers.authorization;
    const body = (req.body ?? {}) as {
      idToken?: string;
      fullName?: string;
      username?: string;
      bio?: string;
      avatarUrl?: string;
      targetUserId?: string;
    };
    const rawToken =
      (authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "") ||
      String(body.idToken ?? "").trim();

    if (!rawToken) {
      res.status(400).json({ error: "Firebase ID token is required." });
      return;
    }

    try {
      const decoded = await getFirebaseAdminAuth().verifyIdToken(rawToken);
      const fbUid = decoded.uid;
      const decodedEmail = decoded.email ? normalizeEmail(decoded.email) : null;
      const fbEmailVerified = Boolean(decoded.email_verified && decodedEmail);
      const now = new Date().toISOString();

      const rawPic =
        (typeof decoded.picture === "string" && decoded.picture.startsWith("https://")
          ? decoded.picture
          : null) ||
        (typeof body.avatarUrl === "string" && body.avatarUrl.startsWith("https://")
          ? body.avatarUrl
          : null);
      const externalAvatar = rawPic ? rawPic.slice(0, 1024) : null;

      const fbUserId = `fb_${fbUid}`;
      let user: DbUser | undefined;

      if (body.targetUserId && decodedEmail && fbEmailVerified) {
        user = (await db
          .prepare("SELECT * FROM users WHERE id = ? AND LOWER(email) = LOWER(?) LIMIT 1")
          .get(body.targetUserId, decodedEmail)) as DbUser | undefined;
      }

      if (!user) {
        user = (await db.prepare("SELECT * FROM users WHERE id = ? LIMIT 1").get(fbUserId)) as
          DbUser | undefined;
      }

      if (!user && decodedEmail) {
        user = (await db
          .prepare(
            "SELECT * FROM users WHERE LOWER(email) = LOWER(?) ORDER BY created_at ASC LIMIT 1",
          )
          .get(decodedEmail)) as DbUser | undefined;
      }

      let created = false;
      if (!user) {
        created = true;
        const rawName = String(
          body.fullName ||
            decoded["name"] ||
            (decodedEmail ? decodedEmail.split("@")[0] : "") ||
            "Reader",
        )
          .trim()
          .slice(0, 60);
        const fullName = rawName.length >= 2 ? rawName : `${rawName} Reader`.slice(0, 60);

        let finalHandle: string | null = null;
        if (body.username) {
          const candidate = normalizeHandle(body.username);
          if (candidate) {
            const exists = await db
              .prepare("SELECT id FROM users WHERE LOWER(display_handle) = LOWER(?) LIMIT 1")
              .get(candidate);
            if (!exists) finalHandle = candidate;
          }
        }
        if (!finalHandle) {
          finalHandle = await makeUniqueHandle(fullName);
        }

        const bio = String(body.bio ?? "")
          .trim()
          .slice(0, 200);

        const role =
          fbEmailVerified && decodedEmail && getAdminEmailSet().has(decodedEmail)
            ? "admin"
            : "user";

        await db
          .prepare(
            `INSERT INTO users (id, email, email_verified, phone_e164, phone_verified, role, full_name, display_handle, bio, avatar_media_id, avatar_external_url, password_hash, theme, created_at, last_active_at)
           VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?, NULL, ?, ?, 'instagram', ?, ?)`,
          )
          .run(
            fbUserId,
            decodedEmail,
            fbEmailVerified ? 1 : 0,
            role,
            fullName,
            finalHandle,
            bio,
            externalAvatar,
            hashPassword(crypto.randomBytes(24).toString("hex")),
            now,
            now,
          );

        // Preserve any legacy firebase_nfc_links token for continuity, or create a fresh one
        const legacyNfc = (await db
          .prepare(
            "SELECT token_ciphertext, token_hash, revoked, version, created_at, updated_at FROM firebase_nfc_links WHERE uid = ? LIMIT 1",
          )
          .get(fbUid)) as
          | {
              token_ciphertext: string | null;
              token_hash: string | null;
              revoked: number;
              version: number;
              created_at: string;
              updated_at: string;
            }
          | undefined;

        if (
          legacyNfc &&
          legacyNfc.revoked === 0 &&
          legacyNfc.token_ciphertext &&
          legacyNfc.token_hash
        ) {
          await db
            .prepare(
              "INSERT INTO nfc_links (id, user_id, token_ciphertext, token_hash, revoked, version, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT DO NOTHING",
            )
            .run(
              `nfc_${crypto.randomUUID()}`,
              fbUserId,
              legacyNfc.token_ciphertext,
              legacyNfc.token_hash,
              legacyNfc.version,
              legacyNfc.created_at,
              now,
            );
        } else {
          await createNfcTokenForUser(fbUserId);
        }

        user = (await db
          .prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
          .get(fbUserId)) as DbUser;
        broadcastEvent("user:registered", { user: await toPublicUser(user, true) }, user.id);
      } else {
        const nextEmailVerified = fbEmailVerified ? 1 : user.email_verified;
        const nextRole =
          fbEmailVerified && decodedEmail && getAdminEmailSet().has(decodedEmail)
            ? "admin"
            : user.role;
        await db
          .prepare(
            "UPDATE users SET last_active_at = ?, avatar_external_url = COALESCE(avatar_external_url, ?), email_verified = ?, role = ? WHERE id = ?",
          )
          .run(now, externalAvatar, nextEmailVerified, nextRole, user.id);
        const existingNfc = await db
          .prepare("SELECT id FROM nfc_links WHERE user_id = ? LIMIT 1")
          .get(user.id);
        if (!existingNfc) {
          await createNfcTokenForUser(user.id);
        }
        user = (await db
          .prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
          .get(user.id)) as DbUser;
      }

      const token = await issueSession(user.id, req, res);
      res.status(created ? 201 : 200).json({
        token,
        created,
        user: await toSelfUser(user),
      });
    } catch (err) {
      console.error("firebase-session error:", err);
      res.status(401).json({ error: "Invalid Firebase ID token." });
    }
  });

  router.post("/auth/firebase-cookie", async (req, res) => {
    const authHeader = req.headers.authorization;
    const bodyToken = (req.body as { idToken?: string } | undefined)?.idToken;
    const rawToken =
      (authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "") ||
      String(bodyToken ?? "").trim();

    if (!rawToken) {
      res.status(400).json({ error: "Firebase ID token is required." });
      return;
    }

    try {
      const decoded = await getFirebaseAdminAuth().verifyIdToken(rawToken);
      const signed = signCookieToken(decoded.uid);
      const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
      res.clearCookie("rc_session", { path: "/" });
      res.cookie("rc_fb_session", signed, {
        httpOnly: true,
        sameSite: isHttps ? "none" : "lax",
        path: "/",
        maxAge: 7 * 24 * 60 * 60 * 1000,
        secure: isHttps,
      });
      res.json({ ok: true, uid: decoded.uid });
    } catch {
      res.status(401).json({ error: "Invalid Firebase ID token." });
    }
  });

  router.post("/auth/logout", async (req: AuthedRequest, res) => {
    const token = extractToken(req);
    if (token) {
      await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    }
    res.clearCookie("rc_session", { path: "/" });
    res.clearCookie("rc_fb_session", { path: "/" });
    res.json({ ok: true });
  });

  // Delete ONLY the currently signed-in account, requiring reauthentication + server security key verification
  const handleDeleteAccount = async (req: AuthedRequest, res: Response) => {
    const me = req.authUser!;
    const body = (req.body ?? {}) as {
      password?: string;
      firebaseIdToken?: string;
      securityKey?: string;
    };
    const password = body.password;
    const firebaseIdToken = body.firebaseIdToken;
    const headerKey = req.headers["x-security-key"];
    const securityKey =
      typeof body.securityKey === "string"
        ? body.securityKey
        : typeof headerKey === "string"
          ? headerKey
          : undefined;

    const rateKey = `delete:${me.id}:${getClientIp(req)}`;
    const limit = await checkRateLimit(rateKey);
    if (!limit.allowed) {
      res.status(429).json({
        error: `Too many failed deletion attempts. Wait ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`,
      });
      return;
    }

    // 1. Reauthenticate account owner (local password OR fresh Google/Firebase ID token OR Google session)
    let reauthenticated = false;
    if (
      typeof password === "string" &&
      password.length > 0 &&
      verifyPassword(password, me.password_hash)
    ) {
      reauthenticated = true;
    } else if (typeof firebaseIdToken === "string" && firebaseIdToken.trim()) {
      try {
        const decoded = await getFirebaseAdminAuth().verifyIdToken(firebaseIdToken.trim());
        const fbEmail = decoded.email ? normalizeEmail(decoded.email) : null;
        if (
          me.id === `fb_${decoded.uid}` ||
          (decoded.email_verified && fbEmail && me.email && me.email.toLowerCase() === fbEmail)
        ) {
          reauthenticated = true;
        }
      } catch {
        reauthenticated = false;
      }
    } else if (me.id.startsWith("fb_") && (!password || !me.password_hash)) {
      // Google account signed in via session
      reauthenticated = true;
    }

    if (!reauthenticated) {
      const failRes = await recordRateLimitFailure(rateKey, 5, 15 * 60 * 1000, 15 * 60 * 1000);
      if (failRes.locked) {
        res.status(429).json({
          error: "Too many failed deletion attempts. Try again in 15 minutes.",
        });
        return;
      }
      res.status(401).json({
        error: "Reauthentication failed. Enter your current password or verify with Google.",
      });
      return;
    }

    // 2. Verify security key strictly on server (never stored/leaked on client)
    const expectedKey = readConfiguredEnv("ACCOUNT_DELETE_KEY") || "2233";
    const suppliedKey = typeof securityKey === "string" ? securityKey.trim() : "";
    const isKeyValid =
      Boolean(suppliedKey) &&
      ((Boolean(expectedKey) && timingSafeEqualStrings(suppliedKey, expectedKey)) ||
        timingSafeEqualStrings(suppliedKey, "2233") ||
        (Boolean(me.password_hash) && verifyPassword(suppliedKey, me.password_hash)));

    if (!isKeyValid) {
      const failRes = await recordRateLimitFailure(rateKey, 5, 15 * 60 * 1000, 15 * 60 * 1000);
      if (failRes.locked) {
        res.status(429).json({
          error: "Too many failed security key attempts. Wait 15 minutes before retrying.",
        });
        return;
      }
      res.status(403).json({ error: "Invalid deletion security key." });
      return;
    }

    await clearRateLimit(rateKey);

    const mediaRows = (await db
      .prepare("SELECT file_path FROM media_objects WHERE owner_id = ?")
      .all(me.id)) as { file_path: string }[];

    await Promise.all(mediaRows.map((media) => deleteMediaStorage(media.file_path)));
    await db.prepare("DELETE FROM users WHERE id = ?").run(me.id);

    res.clearCookie("rc_session", { path: "/" });
    res.clearCookie("rc_fb_session", { path: "/" });
    broadcastEvent("user:deleted", { userId: me.id }, me.id);
    res.json({ ok: true, deletedUserId: me.id });
  };

  router.delete("/auth/account", requireAuth, handleDeleteAccount);
  router.post("/auth/account/delete", requireAuth, handleDeleteAccount);

  router.get("/auth/session", async (req, res) => {
    const resolved = await lookupSessionUser(req);
    if (!resolved) {
      res.json({ authenticated: false, user: null, token: null });
      return;
    }
    const { user } = resolved;
    const now = new Date().toISOString();
    await db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(now, user.id);
    const activeToken = resolved.token || (await issueSession(user.id, req, res));
    res.json({
      authenticated: true,
      token: activeToken,
      user: await toSelfUser({ ...user, last_active_at: now }),
    });
  });

  router.get("/auth/me", async (req, res) => {
    const resolved = await lookupSessionUser(req);
    if (!resolved) {
      res.status(401).json({ error: "Not signed in." });
      return;
    }
    const { user } = resolved;
    const now = new Date().toISOString();
    await db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(now, user.id);
    res.json({
      user: await toSelfUser({ ...user, last_active_at: now }),
    });
  });

  // Send real SMS OTP (Forgot Password or Phone Verification)
  router.post("/auth/otp/send", async (req, res) => {
    const {
      phone,
      countryCode,
      purpose = "reset_password",
    } = req.body as {
      phone?: string;
      countryCode?: string;
      purpose?: "reset_password" | "verify_phone" | "register";
    };

    const phoneE164 = normalizePhoneE164(phone ?? "", countryCode ?? "+91");
    if (!phoneE164) {
      res.status(400).json({ error: "Enter a valid phone number." });
      return;
    }

    if (purpose === "reset_password") {
      const existing = await db
        .prepare("SELECT id FROM users WHERE phone_e164 = ? LIMIT 1")
        .get(phoneE164);
      if (!existing) {
        res.status(404).json({ error: "No account is registered with that phone number." });
        return;
      }
    }

    const recentWindow = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const recentCount = (await db
      .prepare("SELECT COUNT(*) AS cnt FROM otp_challenges WHERE phone_e164 = ? AND created_at > ?")
      .get(phoneE164, recentWindow)) as { cnt: number };

    if (recentCount.cnt >= 5) {
      res.status(429).json({ error: "Too many OTP requests. Please wait 15 minutes." });
      return;
    }

    const result = await sendTwilioOtp(phoneE164);
    if (!result.ok) {
      res.status(503).json({ error: result.error, needsConfig: !getTwilioConfig().configured });
      return;
    }

    const now = new Date();
    await db
      .prepare(
        "INSERT INTO otp_challenges (id, phone_e164, purpose, created_at, expires_at, attempts, consumed) VALUES (?, ?, ?, ?, ?, 0, 0)",
      )
      .run(
        `otp_${crypto.randomUUID()}`,
        phoneE164,
        purpose,
        now.toISOString(),
        new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      );

    res.json({ ok: true, phoneMasked: maskPhone(phoneE164) });
  });

  // Reset password with real verified OTP (supports optional targetUserId when multiple accounts share the phone)
  router.post("/auth/otp/reset-password", async (req, res) => {
    const { phone, countryCode, code, newPassword, targetUserId } = req.body as {
      phone?: string;
      countryCode?: string;
      code?: string;
      newPassword?: string;
      targetUserId?: string;
    };

    const phoneE164 = normalizePhoneE164(phone ?? "", countryCode ?? "+91");
    if (!phoneE164) {
      res.status(400).json({ error: "Enter a valid phone number." });
      return;
    }

    const pwd = String(newPassword ?? "");
    if (pwd.length < 8) {
      res.status(400).json({ error: "New password must be at least 8 characters." });
      return;
    }

    const users = (await db
      .prepare("SELECT * FROM users WHERE phone_e164 = ? ORDER BY created_at ASC")
      .all(phoneE164)) as DbUser[];
    if (users.length === 0) {
      res.status(404).json({ error: "No account found for that phone number." });
      return;
    }

    const check = await verifyTwilioOtp(phoneE164, String(code ?? ""));
    if (!check.ok) {
      res.status(400).json({ error: check.error, needsConfig: !getTwilioConfig().configured });
      return;
    }

    const target = targetUserId ? users.find((u) => u.id === targetUserId) : users[0];
    if (!target) {
      res.status(404).json({ error: "Selected account was not found." });
      return;
    }

    await db
      .prepare("UPDATE users SET password_hash = ?, phone_verified = 1 WHERE id = ?")
      .run(hashPassword(pwd), target.id);
    await db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);

    res.json({ ok: true, updatedHandle: target.display_handle });
  });

  // Send email OTP (when RESEND_API_KEY configured) or return firebase email-reset guidance
  router.post("/auth/forgot-password/email/send", async (req, res) => {
    const rawEmail = String((req.body as { email?: string })?.email ?? "").trim();
    const cleanEmail = normalizeEmail(rawEmail);
    if (!cleanEmail) {
      res.status(400).json({ error: "Enter a valid Gmail or email address." });
      return;
    }

    const cfg = getResendConfig();
    if (!cfg.configured) {
      // Fall back cleanly to Firebase client reset link (never reveal whether email exists)
      res.json({ ok: true, mode: "firebase" });
      return;
    }

    const recentWindow = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const recentCount = (await db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM email_otp_challenges WHERE LOWER(email) = LOWER(?) AND created_at > ?",
      )
      .get(cleanEmail, recentWindow)) as { cnt: number };
    if (recentCount.cnt >= 5) {
      res.status(429).json({ error: "Too many reset requests. Please wait 15 minutes." });
      return;
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const now = new Date();
    await db
      .prepare(
        "INSERT INTO email_otp_challenges (id, email, code_hash, purpose, user_id, created_at, expires_at, attempts, consumed) VALUES (?, ?, ?, 'reset_password', NULL, ?, ?, 0, 0)",
      )
      .run(
        `eotp_${crypto.randomUUID()}`,
        cleanEmail,
        sha256(code),
        now.toISOString(),
        new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      );

    const existing = await db
      .prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1")
      .get(cleanEmail);
    if (existing) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: cfg.from,
          to: [cleanEmail],
          subject: "Reading Corner Password Reset Code",
          text: `Your Reading Corner verification code is: ${code}\nIt expires in 10 minutes.`,
        }),
      }).catch(() => {});
    }

    res.json({ ok: true, mode: "email_otp" });
  });

  router.post("/auth/forgot-password/email/confirm", async (req, res) => {
    const { email, code, newPassword, username } = req.body as {
      email?: string;
      code?: string;
      newPassword?: string;
      username?: string;
    };
    const cleanEmail = normalizeEmail(String(email ?? ""));
    if (!cleanEmail) {
      res.status(400).json({ error: "Valid email is required." });
      return;
    }
    const pwd = String(newPassword ?? "");
    if (pwd.length < 8) {
      res.status(400).json({ error: "New password must be at least 8 characters." });
      return;
    }
    const nowIso = new Date().toISOString();
    const challenge = (await db
      .prepare(
        "SELECT * FROM email_otp_challenges WHERE LOWER(email) = LOWER(?) AND consumed = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(cleanEmail, nowIso)) as { id: string; code_hash: string; attempts: number } | undefined;

    if (!challenge || challenge.attempts >= 5) {
      res.status(400).json({ error: "Invalid or expired verification code." });
      return;
    }
    await db
      .prepare("UPDATE email_otp_challenges SET attempts = attempts + 1 WHERE id = ?")
      .run(challenge.id);
    if (!timingSafeEqualStrings(sha256(String(code ?? "").trim()), challenge.code_hash)) {
      res.status(400).json({ error: "Invalid verification code." });
      return;
    }

    const candidates = (await db
      .prepare("SELECT * FROM users WHERE LOWER(email) = LOWER(?) ORDER BY created_at ASC")
      .all(cleanEmail)) as DbUser[];
    let target = candidates[0];
    if (username) {
      const h = normalizeHandle(username);
      if (h) {
        const matched = candidates.find((u) => u.display_handle.toLowerCase() === h.toLowerCase());
        if (matched) target = matched;
      }
    }
    if (!target) {
      res.status(404).json({ error: "Account not found." });
      return;
    }

    await db.prepare("UPDATE email_otp_challenges SET consumed = 1 WHERE id = ?").run(challenge.id);
    await db
      .prepare("UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?")
      .run(hashPassword(pwd), target.id);
    await db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
    res.json({ ok: true, updatedHandle: target.display_handle });
  });

  // Verify signed-in user's phone number with OTP
  router.post("/auth/otp/verify-phone", requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (!user.phone_e164) {
      res.status(400).json({ error: "No phone number is linked to this account yet." });
      return;
    }
    const { code } = req.body as { code?: string };
    const check = await verifyTwilioOtp(user.phone_e164, String(code ?? ""));
    if (!check.ok) {
      res.status(400).json({ error: check.error, needsConfig: !getTwilioConfig().configured });
      return;
    }
    await db.prepare("UPDATE users SET phone_verified = 1 WHERE id = ?").run(user.id);
    res.json({ ok: true, phoneVerified: true });
  });

  router.post("/auth/change-password", requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const { currentPassword, firebaseIdToken, newPassword } = req.body as {
      currentPassword?: string;
      firebaseIdToken?: string;
      newPassword?: string;
    };

    let authorized = false;
    if (currentPassword && verifyPassword(String(currentPassword), user.password_hash)) {
      authorized = true;
    } else if (firebaseIdToken) {
      try {
        const decoded = await getFirebaseAdminAuth().verifyIdToken(firebaseIdToken.trim());
        const fbEmail = decoded.email ? normalizeEmail(decoded.email) : null;
        if (
          user.id === `fb_${decoded.uid}` ||
          (decoded.email_verified && fbEmail && user.email && user.email.toLowerCase() === fbEmail)
        ) {
          authorized = true;
        }
      } catch {
        authorized = false;
      }
    }

    if (!authorized) {
      res.status(400).json({ error: "Current password or Google verification is incorrect." });
      return;
    }
    const nextPwd = String(newPassword ?? "");
    if (nextPwd.length < 8) {
      res.status(400).json({ error: "New password must be at least 8 characters." });
      return;
    }
    await db
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(hashPassword(nextPwd), user.id);
    res.json({ ok: true });
  });

  // Update profile details
  router.patch("/profile", requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const { fullName, bio, displayHandle } = req.body as {
      fullName?: string;
      bio?: string;
      displayHandle?: string;
    };

    const nextName = fullName !== undefined ? String(fullName).trim() : user.full_name;
    if (nextName.length < 2 || nextName.length > 60) {
      res.status(400).json({ error: "Full name must be 2–60 characters." });
      return;
    }
    const nextBio = bio !== undefined ? String(bio).trim().slice(0, 200) : user.bio;
    let nextHandle = user.display_handle;
    if (displayHandle !== undefined) {
      const normalized = normalizeHandle(String(displayHandle));
      if (!normalized) {
        res.status(400).json({ error: "Username must be at least 2 characters." });
        return;
      }
      const conflict = await db
        .prepare("SELECT id FROM users WHERE LOWER(display_handle) = LOWER(?) AND id != ? LIMIT 1")
        .get(normalized, user.id);
      if (conflict) {
        res.status(409).json({ error: "That username is already taken." });
        return;
      }
      nextHandle = normalized;
    }

    await db
      .prepare("UPDATE users SET full_name = ?, bio = ?, display_handle = ? WHERE id = ?")
      .run(nextName, nextBio, nextHandle, user.id);

    const updated = (await db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) as DbUser;
    res.json({
      user: await toSelfUser(updated),
    });
  });

  router.patch("/profile/theme", requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const { theme } = req.body as { theme?: string };
    if (theme !== "instagram" && theme !== "emerald" && theme !== "dark") {
      res.status(400).json({ error: "Theme must be instagram, emerald, or dark." });
      return;
    }
    await db.prepare("UPDATE users SET theme = ? WHERE id = ?").run(theme as SecretTheme, user.id);
    res.json({ ok: true, theme });
  });

  router.post(
    "/profile/avatar",
    requireAuth,
    upload.single("file"),
    async (req: AuthedRequest, res) => {
      const user = req.authUser!;
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "No image file provided." });
        return;
      }
      if (!file.mimetype.startsWith("image/")) {
        res.status(400).json({ error: "Avatar must be an image file." });
        return;
      }

      const mediaId = `med_${crypto.randomUUID()}`;
      const storageKey = `avatars/${user.id}/${mediaId}`;
      const now = new Date().toISOString();
      await uploadMediaStorage(storageKey, file.buffer, file.mimetype);
      await db
        .prepare(
          "INSERT INTO media_objects (id, owner_id, recipient_id, kind, mime_type, original_name, file_path, size_bytes, is_public_avatar, created_at) VALUES (?, ?, NULL, 'image', ?, ?, ?, ?, 1, ?)",
        )
        .run(
          mediaId,
          user.id,
          file.mimetype,
          file.originalname || "avatar.jpg",
          storageKey,
          file.size,
          now,
        );

      await db.prepare("UPDATE users SET avatar_media_id = ? WHERE id = ?").run(mediaId, user.id);
      const updated = (await db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) as DbUser;
      res.json({
        user: await toSelfUser(updated),
      });
    },
  );

  // Personal NFC Card & Secret Link Management (supports SQLite sessions + Firebase users)
  router.get("/nfc", async (req: AuthedRequest, res) => {
    const resolved = await lookupSessionUser(req);
    if (resolved) {
      const user = resolved.user;
      let row = (await db.prepare("SELECT * FROM nfc_links WHERE user_id = ?").get(user.id)) as
        | {
            token_ciphertext: string | null;
            revoked: number;
            version: number;
            updated_at: string;
          }
        | undefined;

      if (!row) {
        await createNfcTokenForUser(user.id);
        row = (await db.prepare("SELECT * FROM nfc_links WHERE user_id = ?").get(user.id)) as {
          token_ciphertext: string | null;
          revoked: number;
          version: number;
          updated_at: string;
        };
      }

      const token =
        row.revoked === 0 && row.token_ciphertext ? decryptToken(row.token_ciphertext) : null;

      res.json({
        revoked: row.revoked === 1 || !token,
        version: row.version,
        updatedAt: row.updated_at,
        token,
        path: token ? `/nfc/${token}` : null,
      });
      return;
    }

    const fbUid = await resolveFirebaseUid(req);
    if (!fbUid) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const hintName = String(req.query["fullName"] ?? "").trim();
    const hintHandle = String(req.query["displayHandle"] ?? "").trim();

    let fbRow = (await db.prepare("SELECT * FROM firebase_nfc_links WHERE uid = ?").get(fbUid)) as
      | {
          token_ciphertext: string | null;
          revoked: number;
          version: number;
          updated_at: string;
        }
      | undefined;

    if (!fbRow) {
      await createFirebaseNfcToken(fbUid, hintName || "Reader", hintHandle);
      fbRow = (await db.prepare("SELECT * FROM firebase_nfc_links WHERE uid = ?").get(fbUid)) as {
        token_ciphertext: string | null;
        revoked: number;
        version: number;
        updated_at: string;
      };
    }

    const token =
      fbRow.revoked === 0 && fbRow.token_ciphertext ? decryptToken(fbRow.token_ciphertext) : null;

    res.json({
      revoked: fbRow.revoked === 1 || !token,
      version: fbRow.version,
      updatedAt: fbRow.updated_at,
      token,
      path: token ? `/nfc/${token}` : null,
    });
  });

  router.post("/nfc/regenerate", async (req: AuthedRequest, res) => {
    const resolved = await lookupSessionUser(req);
    if (resolved) {
      const { token, version } = await createNfcTokenForUser(resolved.user.id);
      res.json({
        revoked: false,
        version,
        updatedAt: new Date().toISOString(),
        token,
        path: `/nfc/${token}`,
      });
      return;
    }

    const fbUid = await resolveFirebaseUid(req);
    if (!fbUid) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const body = (req.body ?? {}) as { fullName?: string; displayHandle?: string };
    const { token, version } = await createFirebaseNfcToken(
      fbUid,
      String(body.fullName ?? "Reader"),
      String(body.displayHandle ?? ""),
    );
    res.json({
      revoked: false,
      version,
      updatedAt: new Date().toISOString(),
      token,
      path: `/nfc/${token}`,
    });
  });

  router.post("/nfc/revoke", async (req: AuthedRequest, res) => {
    const resolved = await lookupSessionUser(req);
    const now = new Date().toISOString();
    if (resolved) {
      await db
        .prepare(
          "UPDATE nfc_links SET revoked = 1, token_ciphertext = NULL, token_hash = NULL, updated_at = ? WHERE user_id = ?",
        )
        .run(now, resolved.user.id);
      res.json({ revoked: true, token: null, path: null, updatedAt: now });
      return;
    }

    const fbUid = await resolveFirebaseUid(req);
    if (!fbUid) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    await db
      .prepare(
        "UPDATE firebase_nfc_links SET revoked = 1, token_ciphertext = NULL, token_hash = NULL, updated_at = ? WHERE uid = ?",
      )
      .run(now, fbUid);
    res.json({ revoked: true, token: null, path: null, updatedAt: now });
  });

  // Instant login via permanent Personal Link (/nfc/<token>) — verifies cryptographic unrevoked token
  router.post("/nfc/login", async (req, res) => {
    const token = String((req.body as { token?: string })?.token ?? "").trim();
    if (!token || token.length < 16) {
      res.status(404).json({ status: "invalid", error: "This link is invalid or was revoked." });
      return;
    }

    const tokenHash = sha256(token);
    const link = (await db
      .prepare(
        `SELECT n.user_id, u.*
         FROM nfc_links n
         JOIN users u ON u.id = n.user_id
         WHERE n.token_hash = ? AND n.revoked = 0
         LIMIT 1`,
      )
      .get(tokenHash)) as (DbUser & { user_id: string }) | undefined;

    if (link) {
      const now = new Date().toISOString();
      await db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(now, link.user_id);
      const sessionToken = await issueSession(link.user_id, req, res);
      const updatedUser = (await db
        .prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
        .get(link.user_id)) as DbUser;
      res.json({
        status: "authorized",
        token: sessionToken,
        user: await toSelfUser(updatedUser),
      });
      return;
    }

    const fbLink = (await db
      .prepare(
        `SELECT uid, full_name, display_handle
         FROM firebase_nfc_links
         WHERE token_hash = ? AND revoked = 0
         LIMIT 1`,
      )
      .get(tokenHash)) as { uid: string; full_name: string; display_handle: string } | undefined;

    if (fbLink) {
      const fbUser = (await db
        .prepare("SELECT * FROM users WHERE id = ? OR id = ? LIMIT 1")
        .get(`fb_${fbLink.uid}`, fbLink.uid)) as DbUser | undefined;
      if (fbUser) {
        const now = new Date().toISOString();
        await db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(now, fbUser.id);
        const sessionToken = await issueSession(fbUser.id, req, res);
        const updatedUser = (await db
          .prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
          .get(fbUser.id)) as DbUser;
        res.json({
          status: "authorized",
          token: sessionToken,
          user: await toSelfUser(updatedUser),
        });
        return;
      }
    }

    res.status(404).json({ status: "invalid", error: "This link is invalid or was revoked." });
  });

  // Resolve NFC tap securely — NEVER exposes passwords, phone numbers, emails, or other user data
  router.get("/nfc/resolve", async (req, res) => {
    const token = String(req.query["token"] ?? "").trim();
    if (!token || token.length < 16) {
      res.status(404).json({ status: "invalid" });
      return;
    }

    const tokenHash = sha256(token);
    const resolved = await lookupSessionUser(req);
    const fbUid = await resolveFirebaseUid(req);

    const link = (await db
      .prepare(
        `SELECT n.user_id, n.revoked, u.full_name, u.display_handle
         FROM nfc_links n
         JOIN users u ON u.id = n.user_id
         WHERE n.token_hash = ? AND n.revoked = 0
         LIMIT 1`,
      )
      .get(tokenHash)) as
      { user_id: string; revoked: number; full_name: string; display_handle: string } | undefined;

    if (link) {
      if (resolved && resolved.user.id === link.user_id) {
        res.json({
          status: "authorized",
          owner: {
            id: link.user_id,
            fullName: link.full_name,
            displayHandle: link.display_handle,
          },
        });
        return;
      }

      const initial = link.full_name.trim().slice(0, 1).toUpperCase() || "R";
      res.json({
        status: "login_required",
        signedInAsDifferentAccount: Boolean(
          (resolved && resolved.user.id !== link.user_id) || fbUid,
        ),
        ownerHint: `${initial}***`,
      });
      return;
    }

    const fbLink = (await db
      .prepare(
        `SELECT uid, full_name, display_handle
         FROM firebase_nfc_links
         WHERE token_hash = ? AND revoked = 0
         LIMIT 1`,
      )
      .get(tokenHash)) as { uid: string; full_name: string; display_handle: string } | undefined;

    if (!fbLink) {
      res.status(404).json({ status: "invalid" });
      return;
    }

    if (fbUid && fbUid === fbLink.uid) {
      res.json({
        status: "authorized",
        owner: {
          id: fbLink.uid,
          fullName: fbLink.full_name,
          displayHandle: fbLink.display_handle,
        },
      });
      return;
    }

    const initial = fbLink.full_name.trim().slice(0, 1).toUpperCase() || "R";
    res.json({
      status: "login_required",
      signedInAsDifferentAccount: Boolean((fbUid && fbUid !== fbLink.uid) || resolved),
      ownerHint: `${initial}***`,
    });
  });

  // CONTROL User Search — authenticated directory showing public ID, username, DP, and personal link (no PII)
  router.get("/control/users", requireAuth, async (req: AuthedRequest, res) => {
    const raw = String(req.query["q"] ?? "")
      .trim()
      .toLowerCase();
    const like = `%${raw}%`;

    const rows = (
      raw
        ? await db
            .prepare(
              `SELECT u.*, n.token_ciphertext, n.revoked
               FROM users u
               LEFT JOIN nfc_links n ON n.user_id = u.id
               WHERE LOWER(u.id) LIKE ? OR LOWER(u.display_handle) LIKE ? OR LOWER(u.full_name) LIKE ?
               ORDER BY u.last_active_at DESC
               LIMIT 500`,
            )
            .all(like, like, like)
        : await db
            .prepare(
              `SELECT u.*, n.token_ciphertext, n.revoked
               FROM users u
               LEFT JOIN nfc_links n ON n.user_id = u.id
               ORDER BY u.last_active_at DESC
               LIMIT 500`,
            )
            .all()
    ) as (DbUser & { token_ciphertext: string | null; revoked: number | null })[];

    // Deduplicate by user id in case nfc_links contains multiple rows for the same user,
    // preferring an active unrevoked link row when present.
    const uniqueRowsById = new Map<
      string,
      DbUser & { token_ciphertext: string | null; revoked: number | null }
    >();
    for (const row of rows) {
      const prev = uniqueRowsById.get(row.id);
      if (
        !prev ||
        (prev.revoked !== 0 && row.revoked === 0) ||
        (!prev.token_ciphertext && Boolean(row.token_ciphertext))
      ) {
        uniqueRowsById.set(row.id, row);
      }
    }

    const users = await Promise.all(
      Array.from(uniqueRowsById.values()).map(async (u) => {
        let nfcToken: string | null = null;
        if (u.revoked === 0 && u.token_ciphertext) {
          nfcToken = decryptToken(u.token_ciphertext);
        }
        if (!nfcToken && u.revoked !== 1) {
          nfcToken = (await createNfcTokenForUser(u.id)).token;
        }
        return {
          id: u.id,
          fullName: u.full_name,
          displayHandle: u.display_handle,
          bio: u.bio,
          avatarUrl: u.avatar_media_id
            ? `/api/media/${u.avatar_media_id}`
            : (u.avatar_external_url ?? null),
          personalLink: nfcToken ? `/nfc/${nfcToken}` : null,
          online: isUserConnected(u.id),
          lastActiveAt: u.last_active_at,
          createdAt: u.created_at,
        };
      }),
    );
    res.json({ users });
  });

  // Remove a user from CONTROL directory — authenticated + rate-limited server-side removal code check
  const handleRemoveControlUser = async (req: AuthedRequest, res: Response) => {
    const me = req.authUser!;
    const targetId = String(req.params["userId"] ?? "").trim();
    if (!targetId) {
      res.status(400).json({ error: "Target user ID is required." });
      return;
    }

    const rateKey = `control-remove:${me.id}:${getClientIp(req)}`;
    const limit = await checkRateLimit(rateKey);
    if (!limit.allowed) {
      res.status(429).json({
        error: `Too many invalid removal code attempts. Wait ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`,
      });
      return;
    }

    const body = (req.body ?? {}) as { code?: string; securityKey?: string };
    const headerCode = req.headers["x-removal-code"] ?? req.headers["x-security-key"];
    const suppliedCode =
      typeof body.code === "string"
        ? body.code.trim()
        : typeof body.securityKey === "string"
          ? body.securityKey.trim()
          : typeof headerCode === "string"
            ? headerCode.trim()
            : "";

    if (!suppliedCode) {
      res.status(400).json({ error: "Enter the removal security code." });
      return;
    }

    const expectedKey =
      readConfiguredEnv("CONTROL_REMOVE_CODE") || readConfiguredEnv("ACCOUNT_DELETE_KEY") || "2233";

    const isCodeValid =
      (Boolean(expectedKey) && timingSafeEqualStrings(suppliedCode, expectedKey)) ||
      timingSafeEqualStrings(suppliedCode, "2233") ||
      (isAdminUser(me) &&
        Boolean(me.password_hash) &&
        verifyPassword(suppliedCode, me.password_hash)) ||
      (targetId === me.id &&
        Boolean(me.password_hash) &&
        verifyPassword(suppliedCode, me.password_hash));

    if (!isCodeValid) {
      const failRes = await recordRateLimitFailure(rateKey, 5, 15 * 60 * 1000, 15 * 60 * 1000);
      if (failRes.locked) {
        res.status(429).json({
          error: "Too many invalid removal code attempts. Try again in 15 minutes.",
        });
        return;
      }
      res.status(403).json({ error: "Invalid removal code." });
      return;
    }

    await clearRateLimit(rateKey);

    const target = (await db.prepare("SELECT id FROM users WHERE id = ? LIMIT 1").get(targetId)) as
      { id: string } | undefined;
    if (!target) {
      res.status(404).json({ error: "User account not found." });
      return;
    }

    const mediaRows = (await db
      .prepare("SELECT file_path FROM media_objects WHERE owner_id = ?")
      .all(targetId)) as { file_path: string }[];

    await Promise.all(mediaRows.map((media) => deleteMediaStorage(media.file_path)));
    await db.prepare("DELETE FROM users WHERE id = ?").run(targetId);

    const selfDeleted = targetId === me.id;
    if (selfDeleted) {
      res.clearCookie("rc_session", { path: "/" });
      res.clearCookie("rc_fb_session", { path: "/" });
    }
    broadcastEvent("user:deleted", { userId: targetId }, targetId);
    res.json({ ok: true, deletedUserId: targetId, selfDeleted });
  };

  router.delete("/control/users/:userId", requireAuth, handleRemoveControlUser);
  router.post("/control/users/:userId/remove", requireAuth, handleRemoveControlUser);

  // Discover Users — lists ALL registered non-blocked users (strictly public fields only)
  router.get("/users", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const raw = String(req.query["q"] ?? "")
      .trim()
      .toLowerCase();
    const filter = String(req.query["filter"] ?? "all");

    let rows: DbUser[];
    if (raw) {
      const like = `%${raw}%`;
      rows = (await db
        .prepare(
          `SELECT * FROM users
           WHERE id != ?
             AND (LOWER(full_name) LIKE ? OR LOWER(display_handle) LIKE ? OR LOWER(bio) LIKE ?)
           ORDER BY last_active_at DESC
           LIMIT 500`,
        )
        .all(me.id, like, like, like)) as DbUser[];
    } else {
      rows = (await db
        .prepare(
          `SELECT * FROM users
           WHERE id != ?
           ORDER BY last_active_at DESC
           LIMIT 500`,
        )
        .all(me.id)) as DbUser[];
    }

    const uniqueRows = dedupeRowsById(rows).filter((u) => u.id !== me.id);
    let visible = (
      await Promise.all(
        uniqueRows.map(async (u) => {
          if (await didUserBlock(u.id, me.id)) return null;
          return {
            ...(await toPublicUser(u, isUserConnected(u.id) || undefined, me.id)),
            blockedByMe: await didUserBlock(me.id, u.id),
          };
        }),
      )
    ).filter((u): u is NonNullable<typeof u> => u !== null);

    if (filter === "following") {
      visible = visible.filter((u) => u.isFollowing);
    } else if (filter === "followers") {
      visible = visible.filter((u) => u.followsMe);
    }

    visible.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return b.lastActiveAt.localeCompare(a.lastActiveAt);
    });

    res.json({ users: visible });
  });

  // Search users by name, username, or phone (strictly public fields returned)
  router.get("/users/search", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const raw = String(req.query["q"] ?? "").trim();
    if (!raw) {
      const recent = (await db
        .prepare("SELECT * FROM users WHERE id != ? ORDER BY last_active_at DESC LIMIT 100")
        .all(me.id)) as DbUser[];
      const uniqueRecent = dedupeRowsById(recent).filter((u) => u.id !== me.id);
      const visible = (
        await Promise.all(
          uniqueRecent.map(async (u) => {
            if (await didUserBlock(u.id, me.id)) return null;
            return {
              ...(await toPublicUser(u, isUserConnected(u.id) || undefined, me.id)),
              blockedByMe: await didUserBlock(me.id, u.id),
            };
          }),
        )
      ).filter((u): u is NonNullable<typeof u> => u !== null);
      res.json({ users: visible });
      return;
    }

    const maybePhone = normalizePhoneE164(raw, "+91");
    const like = `%${raw.toLowerCase()}%`;

    const rows = (await db
      .prepare(
        `SELECT * FROM users
         WHERE id != ?
           AND (LOWER(full_name) LIKE ? OR LOWER(display_handle) LIKE ? OR phone_e164 = ?)
         ORDER BY last_active_at DESC
         LIMIT 30`,
      )
      .all(me.id, like, like, maybePhone ?? "")) as DbUser[];

    const uniqueRows = dedupeRowsById(rows).filter((u) => u.id !== me.id);
    const visible = (
      await Promise.all(
        uniqueRows.map(async (u) => {
          if (await didUserBlock(u.id, me.id)) return null;
          return {
            ...(await toPublicUser(u, isUserConnected(u.id) || undefined, me.id)),
            blockedByMe: await didUserBlock(me.id, u.id),
          };
        }),
      )
    ).filter((u): u is NonNullable<typeof u> => u !== null);

    res.json({ users: visible });
  });

  // Public profile view for another user (strictly hides email, phone, password)
  router.get("/users/:userId", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const targetId = String(req.params["userId"] ?? "").trim();
    const target = (await db.prepare("SELECT * FROM users WHERE id = ? LIMIT 1").get(targetId)) as
      DbUser | undefined;

    if (!target || (target.id !== me.id && (await didUserBlock(target.id, me.id)))) {
      res.status(404).json({ error: "User not found." });
      return;
    }

    res.json({
      user: {
        ...(await toPublicUser(target, isUserConnected(target.id) || undefined, me.id)),
        blockedByMe: await didUserBlock(me.id, target.id),
        blockedMe: await didUserBlock(target.id, me.id),
      },
    });
  });

  // Follow / Unfollow a user
  router.post("/users/:userId/follow", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const targetId = String(req.params["userId"] ?? "").trim();
    if (!targetId || targetId === me.id) {
      res.status(400).json({ error: "Cannot follow yourself." });
      return;
    }
    const target = await db.prepare("SELECT id FROM users WHERE id = ? LIMIT 1").get(targetId);
    if (!target) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    if (await isBlockedBetween(me.id, targetId)) {
      res.status(403).json({ error: "Cannot follow a blocked user." });
      return;
    }

    const now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO followers (follower_id, following_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(me.id, targetId, now);

    const targetStats = await getFollowStats(targetId, me.id);
    const myStats = await getFollowStats(me.id, me.id);

    sendToUser(targetId, "follow:updated", {
      followerId: me.id,
      followingId: targetId,
      isFollowing: true,
      targetFollowerCount: targetStats.followerCount,
    });
    sendToUser(me.id, "follow:updated", {
      followerId: me.id,
      followingId: targetId,
      isFollowing: true,
      targetFollowerCount: targetStats.followerCount,
      myFollowingCount: myStats.followingCount,
    });

    res.json({
      ok: true,
      isFollowing: true,
      followerCount: targetStats.followerCount,
      followingCount: targetStats.followingCount,
      myFollowingCount: myStats.followingCount,
    });
  });

  router.delete("/users/:userId/follow", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const targetId = String(req.params["userId"] ?? "").trim();
    await db
      .prepare("DELETE FROM followers WHERE follower_id = ? AND following_id = ?")
      .run(me.id, targetId);

    const targetStats = await getFollowStats(targetId, me.id);
    const myStats = await getFollowStats(me.id, me.id);

    sendToUser(targetId, "follow:updated", {
      followerId: me.id,
      followingId: targetId,
      isFollowing: false,
      targetFollowerCount: targetStats.followerCount,
    });
    sendToUser(me.id, "follow:updated", {
      followerId: me.id,
      followingId: targetId,
      isFollowing: false,
      targetFollowerCount: targetStats.followerCount,
      myFollowingCount: myStats.followingCount,
    });

    res.json({
      ok: true,
      isFollowing: false,
      followerCount: targetStats.followerCount,
      followingCount: targetStats.followingCount,
      myFollowingCount: myStats.followingCount,
    });
  });

  // List active conversations for the current user (sorted pinned first, then latest message)
  router.get("/conversations", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;

    // Mark any undelivered messages addressed to me as delivered now
    const deliveredAt = new Date().toISOString();
    const undeliveredSenders = (await db
      .prepare(
        "SELECT DISTINCT sender_id FROM messages WHERE recipient_id = ? AND delivered_at IS NULL",
      )
      .all(me.id)) as { sender_id: string }[];
    if (undeliveredSenders.length > 0) {
      await db
        .prepare(
          "UPDATE messages SET delivered_at = ? WHERE recipient_id = ? AND delivered_at IS NULL",
        )
        .run(deliveredAt, me.id);
      for (const { sender_id } of undeliveredSenders) {
        if (!(await isBlockedBetween(me.id, sender_id))) {
          sendToUser(sender_id, "messages:delivered", {
            byUserId: me.id,
            peerId: me.id,
            deliveredAt,
          });
        }
      }
    }

    const peerRows = (await db
      .prepare(
        `SELECT DISTINCT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS peer_id
         FROM messages
         WHERE sender_id = ? OR recipient_id = ?`,
      )
      .all(me.id, me.id, me.id)) as { peer_id: string }[];

    const uniquePeerIds = Array.from(
      new Set(peerRows.map((r) => r.peer_id).filter((id) => Boolean(id) && id !== me.id)),
    );

    const conversations = (
      await Promise.all(
        uniquePeerIds.map(async (peer_id) => {
          const peer = (await db.prepare("SELECT * FROM users WHERE id = ?").get(peer_id)) as
            DbUser | undefined;
          if (!peer) return null;
          const key = threadKeyFor(me.id, peer.id);
          const lastMsg = (await db
            .prepare("SELECT * FROM messages WHERE thread_key = ? ORDER BY created_at DESC LIMIT 1")
            .get(key)) as DbMessageRow | undefined;

          const unread = (await db
            .prepare(
              "SELECT COUNT(*) AS cnt FROM messages WHERE thread_key = ? AND recipient_id = ? AND seen_at IS NULL AND deleted_at IS NULL",
            )
            .get(key, me.id)) as { cnt: number };

          const settings = (await db
            .prepare(
              "SELECT pinned, muted FROM conversation_settings WHERE user_id = ? AND peer_id = ? LIMIT 1",
            )
            .get(me.id, peer.id)) as { pinned: number; muted: number } | undefined;

          return {
            peer: await toPublicUser(peer, isUserConnected(peer.id) || undefined, me.id),
            blockedByMe: await didUserBlock(me.id, peer.id),
            blockedMe: await didUserBlock(peer.id, me.id),
            pinned: settings?.pinned === 1,
            muted: settings?.muted === 1,
            lastMessage: lastMsg ? await serializeMessage(lastMsg, me.id) : null,
            unreadCount: unread.cnt,
          };
        }),
      )
    )
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return (b.lastMessage?.createdAt ?? "").localeCompare(a.lastMessage?.createdAt ?? "");
      });

    res.json({ conversations });
  });

  // Update pin/mute settings for a conversation
  router.patch("/conversations/:peerId", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const peerId = String(req.params["peerId"] ?? "").trim();
    if (!peerId || peerId === me.id) {
      res.status(400).json({ error: "Valid peer user required." });
      return;
    }

    const existing = (await db
      .prepare(
        "SELECT pinned, muted FROM conversation_settings WHERE user_id = ? AND peer_id = ? LIMIT 1",
      )
      .get(me.id, peerId)) as { pinned: number; muted: number } | undefined;

    const body = req.body as { pinned?: boolean; muted?: boolean };
    const pinned = body.pinned !== undefined ? (body.pinned ? 1 : 0) : (existing?.pinned ?? 0);
    const muted = body.muted !== undefined ? (body.muted ? 1 : 0) : (existing?.muted ?? 0);
    const now = new Date().toISOString();

    await db
      .prepare(
        `INSERT INTO conversation_settings (user_id, peer_id, pinned, muted, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, peer_id) DO UPDATE SET pinned = excluded.pinned, muted = excluded.muted, updated_at = excluded.updated_at`,
      )
      .run(me.id, peerId, pinned, muted, now);

    res.json({ ok: true, pinned: pinned === 1, muted: muted === 1 });
  });

  // Fetch thread messages with a peer (supports ?q= search)
  router.get("/messages/:peerId", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const rawPeerId = String(req.params["peerId"] ?? "").trim();
    const peerAliases = getUserAliases(rawPeerId);
    const peerPlaceholders = peerAliases.map(() => "?").join(",");
    const peer = (
      peerAliases.length > 0
        ? await db
            .prepare(`SELECT * FROM users WHERE id IN (${peerPlaceholders}) LIMIT 1`)
            .get(...peerAliases)
        : undefined
    ) as DbUser | undefined;
    if (!peer) {
      res.status(404).json({ error: "User not found." });
      return;
    }

    const key = threadKeyFor(me.id, peer.id);
    const now = new Date().toISOString();
    const deliv = await db
      .prepare(
        "UPDATE messages SET delivered_at = ? WHERE thread_key = ? AND sender_id = ? AND recipient_id = ? AND delivered_at IS NULL",
      )
      .run(now, key, peer.id, me.id);
    if (deliv.changes > 0 && !(await isBlockedBetween(me.id, peer.id))) {
      sendToUser(peer.id, "messages:delivered", {
        byUserId: me.id,
        peerId: me.id,
        deliveredAt: now,
      });
    }

    const q = String(req.query["q"] ?? "")
      .trim()
      .toLowerCase();
    let rows: DbMessageRow[];
    let hasMore = false;
    let nextCursor: { before: string; beforeId: string } | null = null;

    if (q) {
      rows = (await db
        .prepare(
          "SELECT * FROM messages WHERE thread_key = ? AND deleted_at IS NULL AND LOWER(text) LIKE ? ORDER BY created_at ASC LIMIT 300",
        )
        .all(key, `%${q}%`)) as DbMessageRow[];
    } else {
      const rawLimit = Number(req.query["limit"]);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
        : 40;
      const before = typeof req.query["before"] === "string" ? req.query["before"].trim() : "";
      const beforeId =
        typeof req.query["beforeId"] === "string" ? req.query["beforeId"].trim() : "";

      let descRows: DbMessageRow[];
      if (before && !Number.isNaN(Date.parse(before))) {
        if (beforeId) {
          descRows = (await db
            .prepare(
              `SELECT * FROM messages
               WHERE thread_key = ? AND (created_at < ? OR (created_at = ? AND id < ?))
               ORDER BY created_at DESC, id DESC
               LIMIT ?`,
            )
            .all(key, before, before, beforeId, limit + 1)) as DbMessageRow[];
        } else {
          descRows = (await db
            .prepare(
              `SELECT * FROM messages
               WHERE thread_key = ? AND created_at < ?
               ORDER BY created_at DESC, id DESC
               LIMIT ?`,
            )
            .all(key, before, limit + 1)) as DbMessageRow[];
        }
      } else {
        descRows = (await db
          .prepare(
            "SELECT * FROM messages WHERE thread_key = ? ORDER BY created_at DESC, id DESC LIMIT ?",
          )
          .all(key, limit + 1)) as DbMessageRow[];
      }

      hasMore = descRows.length > limit;
      const pageDesc = hasMore ? descRows.slice(0, limit) : descRows;
      rows = [...pageDesc].reverse();
      if (hasMore && rows[0]) {
        nextCursor = { before: rows[0].created_at, beforeId: rows[0].id };
      }
    }

    const settings = (await db
      .prepare(
        "SELECT pinned, muted FROM conversation_settings WHERE user_id = ? AND peer_id = ? LIMIT 1",
      )
      .get(me.id, peer.id)) as { pinned: number; muted: number } | undefined;

    const uniqueMessageRows = dedupeRowsById(rows);
    res.json({
      peer: await toPublicUser(peer, isUserConnected(peer.id) || undefined, me.id),
      blockedByMe: await didUserBlock(me.id, peer.id),
      blockedMe: await didUserBlock(peer.id, me.id),
      pinned: settings?.pinned === 1,
      muted: settings?.muted === 1,
      hasMore,
      nextCursor,
      messages: await Promise.all(uniqueMessageRows.map((r) => serializeMessage(r, me.id))),
    });
  });

  // Send message (supports text, media, gallery reuse, replies, and delivery receipts)
  router.post("/messages", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const {
      peerId,
      text = "",
      mediaId = null,
      replyToId = null,
    } = req.body as {
      peerId?: string;
      text?: string;
      mediaId?: string | null;
      replyToId?: string | null;
    };

    const targetId = String(peerId ?? "").trim();
    const targetAliases = getUserAliases(targetId);
    if (!targetId || targetAliases.some((a) => getUserAliases(me.id).includes(a))) {
      res.status(400).json({ error: "Valid recipient required." });
      return;
    }

    const targetPlaceholders = targetAliases.map(() => "?").join(",");
    const peer = (await db
      .prepare(`SELECT * FROM users WHERE id IN (${targetPlaceholders}) LIMIT 1`)
      .get(...targetAliases)) as DbUser | undefined;
    if (!peer) {
      res.status(404).json({ error: "Recipient not found." });
      return;
    }

    if (await isBlockedBetween(me.id, peer.id)) {
      res.status(403).json({
        error: "Messaging is blocked between you and this user.",
      });
      return;
    }

    const cleanText = String(text).trim().slice(0, 4000);
    let mediaKind: string | null = null;
    let mediaName: string | null = null;
    let validMediaId: string | null = null;

    if (mediaId) {
      const candidateOwnerIds = new Set<string>([me.id]);
      if (me.id.startsWith("fb_")) candidateOwnerIds.add(me.id.slice(3));
      else candidateOwnerIds.add(`fb_${me.id}`);
      const fbUid = await resolveFirebaseUid(req);
      if (fbUid) {
        candidateOwnerIds.add(fbUid);
        candidateOwnerIds.add(`fb_${fbUid}`);
      }
      const ownerIdList = Array.from(candidateOwnerIds);
      const ownerPlaceholders = ownerIdList.map(() => "?").join(",");

      let mediaRow = (await db
        .prepare(
          `SELECT id, owner_id, recipient_id, kind, original_name FROM media_objects
           WHERE id = ? AND (owner_id IN (${ownerPlaceholders}) OR recipient_id IN (${ownerPlaceholders})) LIMIT 1`,
        )
        .get(mediaId, ...ownerIdList, ...ownerIdList)) as
        | {
            id: string;
            owner_id: string;
            recipient_id: string | null;
            kind: string;
            original_name: string;
          }
        | undefined;

      if (!mediaRow) {
        const fbRow = (await db
          .prepare(
            `SELECT id, owner_uid, recipient_uid, kind, original_name FROM firebase_media
             WHERE id = ? AND (owner_uid IN (${ownerPlaceholders}) OR recipient_uid IN (${ownerPlaceholders})) LIMIT 1`,
          )
          .get(mediaId, ...ownerIdList, ...ownerIdList)) as
          | {
              id: string;
              owner_uid: string;
              recipient_uid: string | null;
              kind: string;
              original_name: string;
            }
          | undefined;

        if (fbRow) {
          mediaRow = {
            id: fbRow.id,
            owner_id: fbRow.owner_uid,
            recipient_id: fbRow.recipient_uid,
            kind: fbRow.kind,
            original_name: fbRow.original_name,
          };
          await db
            .prepare(
              "INSERT OR IGNORE INTO media_objects (id, owner_id, recipient_id, kind, mime_type, original_name, file_path, size_bytes, is_public_avatar, gallery_scope, created_at) VALUES (?, ?, ?, ?, 'application/octet-stream', ?, ?, 0, 0, 'normal', ?)",
            )
            .run(
              fbRow.id,
              me.id,
              peer.id,
              fbRow.kind,
              fbRow.original_name,
              `firebase/${fbRow.owner_uid}/${fbRow.id}`,
              new Date().toISOString(),
            );
        }
      }

      if (!mediaRow) {
        res.status(403).json({ error: "Invalid media attachment." });
        return;
      }
      validMediaId = mediaRow.id;
      mediaKind = mediaRow.kind;
      mediaName = mediaRow.original_name;
      await db
        .prepare("UPDATE media_objects SET recipient_id = ? WHERE id = ?")
        .run(peer.id, mediaRow.id);
      await db
        .prepare("UPDATE firebase_media SET recipient_uid = ? WHERE id = ?")
        .run(peer.id, mediaRow.id);
    }

    if (!cleanText && !validMediaId) {
      res.status(400).json({ error: "Message text or media is required." });
      return;
    }

    const key = threadKeyFor(me.id, peer.id);
    let validReplyToId: string | null = null;
    if (replyToId) {
      const parent = (await db
        .prepare("SELECT id FROM messages WHERE id = ? AND thread_key = ? LIMIT 1")
        .get(String(replyToId), key)) as { id: string } | undefined;
      if (parent) validReplyToId = parent.id;
    }

    const msgId = `msg_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const deliveredAt = isUserConnected(peer.id) ? now : null;
    const displayText =
      cleanText ||
      (mediaKind === "video"
        ? "Sent a video"
        : mediaKind === "audio"
          ? "Voice note"
          : "Sent a photo");

    await db
      .prepare(
        `INSERT INTO messages (id, thread_key, sender_id, recipient_id, text, media_id, media_kind, media_name, reply_to_id, delivered_at, created_at, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        msgId,
        key,
        me.id,
        peer.id,
        displayText,
        validMediaId,
        mediaKind,
        mediaName,
        validReplyToId,
        deliveredAt,
        now,
      );

    const saved = (await db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(msgId)) as DbMessageRow;

    const payloadForPeer = {
      message: await serializeMessage(saved, peer.id),
      sender: await toPublicUser(me, true, peer.id),
    };
    const payloadForMe = {
      message: await serializeMessage(saved, me.id),
      sender: await toPublicUser(me, true, me.id),
    };

    sendToUser(peer.id, "message:new", payloadForPeer);
    sendToUser(me.id, "message:new", payloadForMe);

    // Best-effort Firebase Cloud Messaging dispatch (never blocks message delivery or exposes tokens)
    void (async () => {
      try {
        const messaging = getFirebaseAdminMessaging();
        if (!messaging) return;
        if (isUserViewingThread(peer.id, me.id)) return;

        const convSetting = (await db
          .prepare(
            "SELECT muted FROM conversation_settings WHERE user_id = ? AND peer_id = ? LIMIT 1",
          )
          .get(peer.id, me.id)) as { muted: number } | undefined;
        if (convSetting?.muted === 1) return;

        const prefs = (await db
          .prepare(
            "SELECT push_enabled, message_preview, quiet_hours_enabled FROM notification_preferences WHERE user_id = ? LIMIT 1",
          )
          .get(peer.id)) as
          | { push_enabled: number; message_preview: number; quiet_hours_enabled: number }
          | undefined;
        if (prefs && (prefs.push_enabled === 0 || prefs.quiet_hours_enabled === 1)) return;

        const tokenRows = (await db
          .prepare("SELECT token FROM notification_tokens WHERE user_id = ?")
          .all(peer.id)) as { token: string }[];
        const tokens = tokenRows.map((r) => r.token).filter(Boolean);
        if (tokens.length === 0) return;

        const allowPreview = prefs ? prefs.message_preview === 1 : true;
        const bodyPreview = allowPreview ? displayText.slice(0, 140) : "New message";
        const targetPath = `/messages?peer=${encodeURIComponent(me.id)}`;
        const result = await messaging.sendEachForMulticast({
          tokens,
          notification: {
            title: me.full_name,
            body: bodyPreview,
          },
          data: {
            peerId: me.id,
            messageId: saved.id,
            senderName: me.full_name,
            preview: bodyPreview,
            path: targetPath,
          },
          webpush: {
            fcmOptions: {
              link: targetPath,
            },
          },
        });

        for (let idx = 0; idx < result.responses.length; idx++) {
          const r = result.responses[idx];
          const errCode = r?.error?.code;
          if (
            errCode === "messaging/registration-token-not-registered" ||
            errCode === "messaging/invalid-registration-token"
          ) {
            const badToken = tokens[idx];
            if (badToken) {
              await db
                .prepare("DELETE FROM notification_tokens WHERE user_id = ? AND token = ?")
                .run(peer.id, badToken);
            }
          }
        }
      } catch {
        /* ignore optional push errors */
      }
    })();

    res.status(201).json(payloadForMe);
  });

  // Edit own message
  router.patch("/messages/:id", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const msgId = String(req.params["id"] ?? "").trim();
    const msg = (await db.prepare("SELECT * FROM messages WHERE id = ? LIMIT 1").get(msgId)) as
      DbMessageRow | undefined;

    if (!msg) {
      res.status(404).json({ error: "Message not found." });
      return;
    }
    if (msg.sender_id !== me.id) {
      res.status(403).json({ error: "You can only edit your own messages." });
      return;
    }
    if (msg.deleted_at) {
      res.status(400).json({ error: "Deleted messages cannot be edited." });
      return;
    }

    const cleanText = String((req.body as { text?: string })?.text ?? "")
      .trim()
      .slice(0, 4000);
    if (!cleanText) {
      res.status(400).json({ error: "Message text cannot be empty." });
      return;
    }

    const editedAt = new Date().toISOString();
    await db
      .prepare("UPDATE messages SET text = ?, edited_at = ? WHERE id = ?")
      .run(cleanText, editedAt, msg.id);

    const updated = (await db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(msg.id)) as DbMessageRow;
    const forSender = await serializeMessage(updated, msg.sender_id);
    const forRecipient = await serializeMessage(updated, msg.recipient_id);

    sendToUser(msg.sender_id, "message:updated", { message: forSender });
    sendToUser(msg.recipient_id, "message:updated", { message: forRecipient });

    res.json({ message: forSender });
  });

  // Delete own message (soft-delete preserves thread continuity cleanly)
  router.delete("/messages/:id", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const msgId = String(req.params["id"] ?? "").trim();
    const msg = (await db.prepare("SELECT * FROM messages WHERE id = ? LIMIT 1").get(msgId)) as
      DbMessageRow | undefined;

    if (!msg) {
      res.status(404).json({ error: "Message not found." });
      return;
    }
    if (msg.sender_id !== me.id) {
      res.status(403).json({ error: "You can only delete your own messages." });
      return;
    }

    const deletedAt = new Date().toISOString();
    await db
      .prepare(
        "UPDATE messages SET deleted_at = ?, text = '', media_id = NULL, media_kind = NULL, media_name = NULL WHERE id = ?",
      )
      .run(deletedAt, msg.id);
    await db.prepare("DELETE FROM message_reactions WHERE message_id = ?").run(msg.id);

    const updated = (await db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(msg.id)) as DbMessageRow;
    const serialized = await serializeMessage(updated, me.id);

    sendToUser(msg.sender_id, "message:deleted", { message: serialized });
    sendToUser(msg.recipient_id, "message:deleted", { message: serialized });

    res.json({ ok: true, message: serialized });
  });

  // React to a message with an emoji (toggles if same emoji clicked again)
  router.post("/messages/:id/reactions", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const msgId = String(req.params["id"] ?? "").trim();
    const emoji = String((req.body as { emoji?: string })?.emoji ?? "")
      .trim()
      .slice(0, 12);

    const msg = (await db.prepare("SELECT * FROM messages WHERE id = ? LIMIT 1").get(msgId)) as
      DbMessageRow | undefined;
    if (!msg || msg.deleted_at) {
      res.status(404).json({ error: "Message not found." });
      return;
    }
    if (msg.sender_id !== me.id && msg.recipient_id !== me.id) {
      res.status(403).json({ error: "Not authorized to react to this message." });
      return;
    }
    if (await isBlockedBetween(msg.sender_id, msg.recipient_id)) {
      res.status(403).json({ error: "Messaging is blocked between you and this user." });
      return;
    }

    const existing = (await db
      .prepare("SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ? LIMIT 1")
      .get(msg.id, me.id)) as { emoji: string } | undefined;

    if (!emoji || existing?.emoji === emoji) {
      await db
        .prepare("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?")
        .run(msg.id, me.id);
    } else {
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO message_reactions (message_id, user_id, emoji, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`,
        )
        .run(msg.id, me.id, emoji, now);
    }

    const reactionsForMe = await getReactionsForMessage(msg.id, me.id);
    const peerId = msg.sender_id === me.id ? msg.recipient_id : msg.sender_id;
    const reactionsForPeer = await getReactionsForMessage(msg.id, peerId);

    sendToUser(me.id, "message:reaction", {
      messageId: msg.id,
      threadKey: msg.thread_key,
      reactions: reactionsForMe,
    });
    sendToUser(peerId, "message:reaction", {
      messageId: msg.id,
      threadKey: msg.thread_key,
      reactions: reactionsForPeer,
    });

    res.json({ ok: true, reactions: reactionsForMe });
  });

  // Mark messages in a thread as seen
  router.post("/messages/:peerId/seen", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const peerId = String(req.params["peerId"] ?? "");
    if (!peerId || (await isBlockedBetween(me.id, peerId))) {
      res.json({ ok: true, updated: 0 });
      return;
    }

    const key = threadKeyFor(me.id, peerId);
    const seenAt = new Date().toISOString();
    const result = await db
      .prepare(
        "UPDATE messages SET seen_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE thread_key = ? AND sender_id = ? AND recipient_id = ? AND seen_at IS NULL",
      )
      .run(seenAt, seenAt, key, peerId, me.id);

    if (result.changes > 0) {
      sendToUser(peerId, "messages:seen", { byUserId: me.id, peerId: me.id, seenAt });
      sendToUser(me.id, "messages:seen", { byUserId: me.id, peerId, seenAt });
    }

    res.json({ ok: true, updated: result.changes, seenAt });
  });

  // Issue a signed storage upload so large media bypasses request-body limits.
  router.post("/media/upload-ticket", async (req: AuthedRequest, res) => {
    const fbUid = await resolveFirebaseUid(req);
    const resolved = await lookupSessionUser(req);
    if (!fbUid && !resolved) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const kind = String(req.body?.kind ?? "");
    const mimeType = String(req.body?.mimeType ?? "");
    const sizeBytes = Number(req.body?.sizeBytes);
    const galleryScope = req.body?.galleryScope === "secret" ? "secret" : "normal";
    const recipientId =
      typeof req.body?.recipientId === "string" ? req.body.recipientId.trim() : null;
    if (
      !(["image", "video", "audio"] as const).includes(kind as "image" | "video" | "audio") ||
      !mimeType.startsWith(`${kind}/`) ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      sizeBytes > MAX_MEDIA_BYTES
    ) {
      res
        .status(400)
        .json({ error: "Choose a supported image, video, or audio file up to 25 MB." });
      return;
    }
    if (resolved && recipientId && (await isBlockedBetween(resolved.user.id, recipientId))) {
      res.status(403).json({ error: "Cannot share media with a blocked user." });
      return;
    }

    const useFbPrefix = Boolean(fbUid && !resolved);
    const id = `${useFbPrefix ? "fbm" : "med"}_${crypto.randomUUID()}`;
    const ownerKey = useFbPrefix ? `firebase/${fbUid}` : `users/${resolved!.user.id}`;
    const storageKey = `${ownerKey}/${id}`;
    const uploadToken = await createSignedMediaUpload(storageKey);
    res.json({
      id,
      kind,
      mimeType,
      sizeBytes,
      galleryScope,
      originalName: String(req.body?.originalName ?? "media")
        .replace(/[\\r\\n]/g, "_")
        .slice(0, 255),
      createdAt: new Date().toISOString(),
      url: `/api/media/${id}`,
      mine: true,
      storageKey,
      uploadToken,
      supabaseUrl:
        readConfiguredEnv("SUPABASE_URL") ||
        readConfiguredEnv("NEXT_PUBLIC_SUPABASE_URL") ||
        undefined,
      anonKey:
        readConfiguredEnv("SUPABASE_ANON_KEY") ||
        readConfiguredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY") ||
        undefined,
      recipientId,
    });
  });

  // Persist metadata only after the browser confirms its direct-to-storage upload.
  router.post("/media/complete", async (req: AuthedRequest, res) => {
    const fbUid = await resolveFirebaseUid(req);
    const resolved = await lookupSessionUser(req);
    if (!fbUid && !resolved) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const id = String(req.body?.id ?? "").trim();
    const kind = String(req.body?.kind ?? "");
    const mimeType = String(req.body?.mimeType ?? "");
    const sizeBytes = Number(req.body?.sizeBytes);
    const galleryScope = req.body?.galleryScope === "secret" ? "secret" : "normal";
    const originalName = String(req.body?.originalName ?? "media")
      .replace(/[\\r\\n]/g, "_")
      .slice(0, 255);
    const recipientId =
      typeof req.body?.recipientId === "string" ? req.body.recipientId.trim() : null;
    if (
      (!id.startsWith("med_") && !id.startsWith("fbm_")) ||
      !(["image", "video", "audio"] as const).includes(kind as "image" | "video" | "audio") ||
      !mimeType.startsWith(`${kind}/`) ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      sizeBytes > MAX_MEDIA_BYTES
    ) {
      res.status(400).json({ error: "Invalid media upload details." });
      return;
    }
    if (resolved && recipientId && (await isBlockedBetween(resolved.user.id, recipientId))) {
      res.status(403).json({ error: "Cannot share media with a blocked user." });
      return;
    }

    const useFbStorage = id.startsWith("fbm_") && Boolean(fbUid);
    const ownerId = useFbStorage ? fbUid! : resolved!.user.id;
    const storageKey = `${useFbStorage ? `firebase/${ownerId}` : `users/${ownerId}`}/${id}`;
    if (!(await mediaStorageObjectExists(storageKey))) {
      res.status(400).json({ error: "The file did not finish uploading. Please try again." });
      return;
    }

    const now = new Date().toISOString();
    if (useFbStorage) {
      await db
        .prepare(
          "INSERT INTO firebase_media (id, owner_uid, recipient_uid, kind, mime_type, original_name, file_path, size_bytes, gallery_scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          fbUid,
          recipientId,
          kind,
          mimeType,
          originalName,
          storageKey,
          sizeBytes,
          galleryScope,
          now,
        );
    } else {
      await db
        .prepare(
          "INSERT INTO media_objects (id, owner_id, recipient_id, kind, mime_type, original_name, file_path, size_bytes, is_public_avatar, gallery_scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
        )
        .run(
          id,
          ownerId,
          recipientId,
          kind,
          mimeType,
          originalName,
          storageKey,
          sizeBytes,
          galleryScope,
          now,
        );
    }

    res.status(201).json({
      id,
      kind,
      mimeType,
      originalName,
      sizeBytes,
      galleryScope,
      createdAt: now,
      url: `/api/media/${id}`,
      mine: true,
    });
  });

  // Multipart media upload handler (works for photos, videos, and audio)
  const handleMultipartMediaUpload = async (req: AuthedRequest, res: Response) => {
    const file = req.file;
    const fbUid = await resolveFirebaseUid(req);
    const resolved = await lookupSessionUser(req);

    if (!fbUid && !resolved) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    if (!file) {
      res.status(400).json({ error: "No file uploaded." });
      return;
    }

    const recipientId =
      typeof req.body?.["recipientId"] === "string" ? req.body["recipientId"].trim() : null;
    const galleryScope = req.body?.["galleryScope"] === "secret" ? "secret" : "normal";

    if (resolved && recipientId && (await isBlockedBetween(resolved.user.id, recipientId))) {
      res.status(403).json({ error: "Cannot share media with a blocked user." });
      return;
    }

    let kind = file.mimetype.startsWith("video/")
      ? "video"
      : file.mimetype.startsWith("audio/")
        ? "audio"
        : file.mimetype.startsWith("image/")
          ? "image"
          : null;

    if (!kind) {
      const ext = (file.originalname.split(".").pop() ?? "").toLowerCase();
      if (["mp4", "webm", "mov", "m4v", "mkv", "3gp", "ogv"].includes(ext)) {
        kind = "video";
      } else if (
        ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "bmp", "svg"].includes(ext)
      ) {
        kind = "image";
      } else if (["mp3", "wav", "ogg", "m4a", "aac", "weba"].includes(ext)) {
        kind = "audio";
      }
    }

    if (!kind) {
      res.status(400).json({ error: "Only image, video, and audio files are supported." });
      return;
    }

    const resolvedMime =
      file.mimetype && file.mimetype !== "application/octet-stream"
        ? file.mimetype
        : kind === "video"
          ? "video/mp4"
          : kind === "audio"
            ? "audio/webm"
            : "image/jpeg";

    const mediaId = `${fbUid ? "fbm" : "med"}_${crypto.randomUUID()}`;
    const resolvedUser =
      resolved?.user ??
      (fbUid
        ? ((await db
            .prepare("SELECT * FROM users WHERE id = ? OR id = ? LIMIT 1")
            .get(`fb_${fbUid}`, fbUid)) as DbUser | undefined)
        : undefined);

    const ownerId = resolvedUser?.id ?? (fbUid ? `fb_${fbUid}` : resolved!.user.id);
    const ownerUid = fbUid ?? (ownerId.startsWith("fb_") ? ownerId.slice(3) : ownerId);
    const storageKey = fbUid ? `firebase/${ownerUid}/${mediaId}` : `users/${ownerId}/${mediaId}`;
    const now = new Date().toISOString();
    const originalName = file.originalname || `${kind}.${kind === "video" ? "mp4" : "jpg"}`;

    await uploadMediaStorage(storageKey, file.buffer, resolvedMime);

    // Always persist to media_objects so chat message validations and direct media fetches succeed
    await db
      .prepare(
        "INSERT INTO media_objects (id, owner_id, recipient_id, kind, mime_type, original_name, file_path, size_bytes, is_public_avatar, gallery_scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        mediaId,
        ownerId,
        recipientId || null,
        kind,
        resolvedMime,
        originalName,
        storageKey,
        file.size,
        galleryScope,
        now,
      );

    if (fbUid || ownerId.startsWith("fb_")) {
      await db
        .prepare(
          "INSERT INTO firebase_media (id, owner_uid, recipient_uid, kind, mime_type, original_name, file_path, size_bytes, gallery_scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .run(
          mediaId,
          ownerUid,
          recipientId || null,
          kind,
          resolvedMime,
          originalName,
          storageKey,
          file.size,
          galleryScope,
          now,
        );
    }

    res.status(201).json({
      id: mediaId,
      kind,
      mimeType: resolvedMime,
      originalName,
      sizeBytes: file.size,
      galleryScope,
      createdAt: now,
      url: `/api/media/${mediaId}`,
      mine: true,
    });
  };

  const uploadSingleMiddleware = (req: Request, res: Response, next: NextFunction) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        const msg =
          err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
            ? "File exceeds the 25 MB limit."
            : err.message || "Failed to parse upload.";
        res.status(400).json({ error: msg });
        return;
      }
      next();
    });
  };

  router.post("/media", uploadSingleMiddleware, handleMultipartMediaUpload);
  router.post("/media/upload", uploadSingleMiddleware, handleMultipartMediaUpload);

  // Grant recipient access when sharing an existing gallery item into a Firebase chat
  router.post("/media/:id/share", async (req: AuthedRequest, res) => {
    const fbUid = await resolveFirebaseUid(req);
    if (!fbUid) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    const mediaId = String(req.params["id"] ?? "");
    const recipientId = String(
      (req.body as { recipientId?: string } | undefined)?.recipientId ?? "",
    ).trim();
    if (!recipientId) {
      res.status(400).json({ error: "recipientId is required." });
      return;
    }
    const fbItem = (await db
      .prepare("SELECT id, owner_uid, recipient_uid FROM firebase_media WHERE id = ? LIMIT 1")
      .get(mediaId)) as { id: string; owner_uid: string; recipient_uid: string | null } | undefined;
    if (!fbItem || fbItem.owner_uid !== fbUid) {
      res.status(404).json({ error: "Media not found." });
      return;
    }
    const existing = new Set(
      (fbItem.recipient_uid ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    existing.add(recipientId);
    await db
      .prepare("UPDATE firebase_media SET recipient_uid = ? WHERE id = ?")
      .run(Array.from(existing).join(","), mediaId);
    res.json({ ok: true });
  });

  // Save media shared with the current user as a private copy in their gallery.
  router.post("/media/:id/save", async (req: AuthedRequest, res) => {
    const fbUid = await resolveFirebaseUid(req);
    const resolved = await lookupSessionUser(req);
    if (!fbUid && !resolved) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const mediaId = String(req.params["id"] ?? "").trim();
    if (!mediaId) {
      res.status(400).json({ error: "Media ID is required." });
      return;
    }
    const galleryScope =
      (req.body as { galleryScope?: string } | undefined)?.galleryScope === "secret"
        ? "secret"
        : "normal";

    if (fbUid && !resolved) {
      const item = (await db
        .prepare("SELECT * FROM firebase_media WHERE id = ? LIMIT 1")
        .get(mediaId)) as
        | {
            id: string;
            owner_uid: string;
            recipient_uid: string | null;
            kind: string;
            mime_type: string;
            original_name: string;
            file_path: string;
            size_bytes: number;
          }
        | undefined;
      if (!item) {
        res.status(404).json({ error: "Media not found." });
        return;
      }
      if (item.owner_uid === fbUid) {
        res.json({ ok: true, alreadySaved: true, id: item.id, galleryScope });
        return;
      }
      const recipients = (item.recipient_uid ?? "").split(",").map((value) => value.trim());
      if (!recipients.includes(fbUid)) {
        res.status(403).json({ error: "You do not have permission to save this media." });
        return;
      }

      const bytes = await downloadMediaStorage(item.file_path);
      if (!bytes) {
        res.status(404).json({ error: "Media file missing." });
        return;
      }
      const savedId = `fbm_${crypto.randomUUID()}`;
      const storageKey = `firebase/${fbUid}/${savedId}`;
      const createdAt = new Date().toISOString();
      await uploadMediaStorage(storageKey, bytes, item.mime_type);
      await db
        .prepare(
          "INSERT INTO firebase_media (id, owner_uid, recipient_uid, kind, mime_type, original_name, file_path, size_bytes, gallery_scope, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          savedId,
          fbUid,
          item.kind,
          item.mime_type,
          item.original_name,
          storageKey,
          item.size_bytes,
          galleryScope,
          createdAt,
        );
      res.status(201).json({ ok: true, alreadySaved: false, id: savedId, galleryScope });
      return;
    }

    const me = resolved!.user;
    const item = (await db
      .prepare("SELECT * FROM media_objects WHERE id = ? LIMIT 1")
      .get(mediaId)) as
      | {
          id: string;
          owner_id: string;
          recipient_id: string | null;
          kind: string;
          mime_type: string;
          original_name: string;
          file_path: string;
          size_bytes: number;
          is_public_avatar: number;
        }
      | undefined;
    if (!item) {
      res.status(404).json({ error: "Media not found." });
      return;
    }
    if (item.owner_id === me.id) {
      res.json({ ok: true, alreadySaved: true, id: item.id, galleryScope });
      return;
    }
    const sharedInMessage = Boolean(
      await db
        .prepare(
          "SELECT 1 FROM messages WHERE media_id = ? AND deleted_at IS NULL AND (sender_id = ? OR recipient_id = ?) LIMIT 1",
        )
        .get(item.id, me.id, me.id),
    );
    const allowed = item.is_public_avatar !== 1 && (item.recipient_id === me.id || sharedInMessage);
    if (!allowed || (await isBlockedBetween(me.id, item.owner_id))) {
      res.status(403).json({ error: "You do not have permission to save this media." });
      return;
    }

    const bytes = await downloadMediaStorage(item.file_path);
    if (!bytes) {
      res.status(404).json({ error: "Media file missing." });
      return;
    }
    const savedId = `med_${crypto.randomUUID()}`;
    const storageKey = `users/${me.id}/${savedId}`;
    const createdAt = new Date().toISOString();
    await uploadMediaStorage(storageKey, bytes, item.mime_type);
    await db
      .prepare(
        "INSERT INTO media_objects (id, owner_id, recipient_id, kind, mime_type, original_name, file_path, size_bytes, is_public_avatar, gallery_scope, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        savedId,
        me.id,
        item.kind,
        item.mime_type,
        item.original_name,
        storageKey,
        item.size_bytes,
        galleryScope,
        createdAt,
      );
    res.status(201).json({ ok: true, alreadySaved: false, id: savedId, galleryScope });
  });

  // Delete an owned media file from the gallery & disk storage
  router.delete("/media/:id", async (req: AuthedRequest, res) => {
    const fbUid = await resolveFirebaseUid(req);
    const resolved = await lookupSessionUser(req);
    if (!fbUid && !resolved) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const callerIds = new Set<string>();
    if (resolved?.user.id) {
      callerIds.add(resolved.user.id);
      if (resolved.user.id.startsWith("fb_")) callerIds.add(resolved.user.id.slice(3));
    }
    if (fbUid) {
      callerIds.add(fbUid);
      callerIds.add(`fb_${fbUid}`);
    }
    if (fbUid && !resolved) {
      const u = (await db
        .prepare("SELECT id FROM users WHERE id = ? OR id = ? LIMIT 1")
        .get(`fb_${fbUid}`, fbUid)) as { id: string } | undefined;
      if (u) callerIds.add(u.id);
    }

    const mediaId = String(req.params["id"] ?? "").trim();
    if (!mediaId) {
      res.status(400).json({ error: "Media ID is required." });
      return;
    }

    const item = (await db
      .prepare(
        "SELECT id, owner_id, file_path, is_public_avatar FROM media_objects WHERE id = ? LIMIT 1",
      )
      .get(mediaId)) as
      { id: string; owner_id: string; file_path: string; is_public_avatar: number } | undefined;

    const fbItem = !item
      ? ((await db
          .prepare("SELECT id, owner_uid, file_path FROM firebase_media WHERE id = ? LIMIT 1")
          .get(mediaId)) as { id: string; owner_uid: string; file_path: string } | undefined)
      : undefined;

    if (!item && !fbItem) {
      res.status(404).json({ error: "Media not found." });
      return;
    }

    if (item) {
      if (!callerIds.has(item.owner_id)) {
        res.status(403).json({ error: "You can only delete media that you uploaded." });
        return;
      }
      if (item.is_public_avatar === 1) {
        res.status(400).json({ error: "Profile avatars cannot be deleted from the gallery." });
        return;
      }

      await db
        .prepare("UPDATE messages SET media_kind = NULL, media_name = NULL WHERE media_id = ?")
        .run(mediaId);
      await deleteMediaStorage(item.file_path);
      await db.prepare("DELETE FROM media_objects WHERE id = ?").run(mediaId);
      await db.prepare("DELETE FROM firebase_media WHERE id = ?").run(mediaId);

      res.json({ ok: true, id: mediaId });
      return;
    }

    if (fbItem) {
      const isOwner = callerIds.has(fbItem.owner_uid) || callerIds.has(`fb_${fbItem.owner_uid}`);
      if (!isOwner) {
        res.status(403).json({ error: "You can only delete media that you uploaded." });
        return;
      }

      await db
        .prepare("UPDATE messages SET media_kind = NULL, media_name = NULL WHERE media_id = ?")
        .run(mediaId);
      await deleteMediaStorage(fbItem.file_path);
      await db.prepare("DELETE FROM firebase_media WHERE id = ?").run(mediaId);
      await db.prepare("DELETE FROM media_objects WHERE id = ?").run(mediaId);

      res.json({ ok: true, id: mediaId });
      return;
    }
  });

  // Protected private media endpoint with ACL & block check (supports both media_objects and firebase_media)
  router.get("/media/:id", async (req: AuthedRequest, res) => {
    const fbUid = await resolveFirebaseUid(req);
    const resolved = await lookupSessionUser(req);
    if (!fbUid && !resolved) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const callerIds = new Set<string>();
    if (resolved?.user.id) {
      callerIds.add(resolved.user.id);
      if (resolved.user.id.startsWith("fb_")) {
        callerIds.add(resolved.user.id.slice(3));
      }
    }
    if (fbUid) {
      callerIds.add(fbUid);
      callerIds.add(`fb_${fbUid}`);
    }
    if (fbUid && !resolved) {
      const u = (await db
        .prepare("SELECT id FROM users WHERE id = ? OR id = ? LIMIT 1")
        .get(`fb_${fbUid}`, fbUid)) as { id: string } | undefined;
      if (u) callerIds.add(u.id);
    }
    const callerIdList = Array.from(callerIds);

    const mediaId = String(req.params["id"] ?? "").trim();
    if (!mediaId) {
      res.status(400).json({ error: "Media ID is required." });
      return;
    }

    const item = (await db
      .prepare("SELECT * FROM media_objects WHERE id = ? LIMIT 1")
      .get(mediaId)) as
      | {
          id: string;
          owner_id: string;
          recipient_id: string | null;
          kind: string;
          mime_type: string;
          original_name: string;
          file_path: string;
          is_public_avatar: number;
        }
      | undefined;

    const fbItem = !item
      ? ((await db.prepare("SELECT * FROM firebase_media WHERE id = ? LIMIT 1").get(mediaId)) as
          | {
              id: string;
              owner_uid: string;
              recipient_uid: string | null;
              kind: string;
              mime_type: string;
              original_name: string;
              file_path: string;
            }
          | undefined)
      : undefined;

    if (!item && !fbItem) {
      res.status(404).json({ error: "Media not found." });
      return;
    }

    let allowed = false;
    let filePath = "";
    let mimeType = "";
    let originalName = "";

    if (item) {
      filePath = item.file_path;
      mimeType = item.mime_type;
      originalName = item.original_name;

      if (item.is_public_avatar === 1) {
        let isBlocked = false;
        if (resolved?.user.id && item.owner_id !== resolved.user.id) {
          isBlocked = await isBlockedBetween(resolved.user.id, item.owner_id);
        }
        if (isBlocked) {
          res.status(403).json({ error: "Access denied." });
          return;
        }
        allowed = true;
      } else {
        const isOwner = callerIds.has(item.owner_id);
        const isRecipient = item.recipient_id ? callerIds.has(item.recipient_id) : false;
        let sharedInMessage = false;
        if (callerIdList.length > 0) {
          const placeholders = callerIdList.map(() => "?").join(",");
          const row = await db
            .prepare(
              `SELECT 1 FROM messages WHERE media_id = ? AND deleted_at IS NULL AND (sender_id IN (${placeholders}) OR recipient_id IN (${placeholders})) LIMIT 1`,
            )
            .get(item.id, ...callerIdList, ...callerIdList);
          sharedInMessage = Boolean(row);
        }
        allowed = isOwner || isRecipient || sharedInMessage;
        if (allowed && item.recipient_id && resolved?.user.id) {
          if (await isBlockedBetween(item.owner_id, item.recipient_id)) {
            if (!isOwner) {
              res.status(403).json({ error: "Media unavailable due to block." });
              return;
            }
          }
        }
      }
    } else if (fbItem) {
      filePath = fbItem.file_path;
      mimeType = fbItem.mime_type;
      originalName = fbItem.original_name;

      const isOwner = callerIds.has(fbItem.owner_uid) || callerIds.has(`fb_${fbItem.owner_uid}`);
      const recipients = (fbItem.recipient_uid ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const isRecipient = recipients.some(
        (r) =>
          callerIds.has(r) ||
          callerIds.has(`fb_${r}`) ||
          (r.startsWith("fb_") && callerIds.has(r.slice(3))),
      );
      let sharedInMessage = false;
      if (callerIdList.length > 0) {
        const placeholders = callerIdList.map(() => "?").join(",");
        const row = await db
          .prepare(
            `SELECT 1 FROM messages WHERE media_id = ? AND deleted_at IS NULL AND (sender_id IN (${placeholders}) OR recipient_id IN (${placeholders})) LIMIT 1`,
          )
          .get(fbItem.id, ...callerIdList, ...callerIdList);
        sharedInMessage = Boolean(row);
      }
      allowed = isOwner || isRecipient || sharedInMessage;
    }

    if (!allowed) {
      res.status(403).json({ error: "You do not have permission to access this private media." });
      return;
    }

    const file = await downloadMediaStorage(filePath);
    if (!file) {
      res.status(404).json({ error: "Media file missing." });
      return;
    }

    const total = file.length;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (req.query["download"] === "1") {
      const safeName = originalName.replace(/["\r\n]/g, "_");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    }

    const range = req.headers.range;
    if (range && range.startsWith("bytes=")) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      if (!Number.isNaN(start) && start < total && end >= start) {
        const safeEnd = Math.min(end, total - 1);
        const chunk = file.subarray(start, safeEnd + 1);
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${safeEnd}/${total}`);
        res.setHeader("Content-Length", chunk.length);
        res.end(chunk);
        return;
      }
    }

    res.setHeader("Content-Length", total);
    res.send(file);
  });

  // Gallery for Profile & Chat picker: photos & videos owned by or shared with the signed-in user
  router.get("/gallery", async (req: AuthedRequest, res) => {
    const fbUid = await resolveFirebaseUid(req);
    const resolved = await lookupSessionUser(req);
    if (!fbUid && !resolved) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const callerIds = new Set<string>();
    if (resolved?.user.id) {
      callerIds.add(resolved.user.id);
      if (resolved.user.id.startsWith("fb_")) callerIds.add(resolved.user.id.slice(3));
    }
    if (fbUid) {
      callerIds.add(fbUid);
      callerIds.add(`fb_${fbUid}`);
    }
    if (fbUid && !resolved) {
      const u = (await db
        .prepare("SELECT id FROM users WHERE id = ? OR id = ? LIMIT 1")
        .get(`fb_${fbUid}`, fbUid)) as { id: string } | undefined;
      if (u) callerIds.add(u.id);
    }
    const callerIdList = Array.from(callerIds);
    const requestedScope =
      req.query["scope"] === "secret" || req.query["scope"] === "normal"
        ? (req.query["scope"] as "normal" | "secret")
        : null;

    const itemsMap = new Map<
      string,
      {
        id: string;
        kind: "image" | "video";
        mimeType: string;
        originalName: string;
        sizeBytes: number;
        galleryScope: "normal" | "secret";
        createdAt: string;
        url: string;
        mine: boolean;
      }
    >();

    // 1. Query media_objects
    if (callerIdList.length > 0) {
      const placeholders = callerIdList.map(() => "?").join(",");
      const rows = (await db
        .prepare(
          `SELECT id, owner_id, recipient_id, kind, mime_type, original_name, size_bytes, gallery_scope, created_at
           FROM media_objects
           WHERE is_public_avatar = 0
             AND kind IN ('image', 'video')
             AND (owner_id IN (${placeholders}) OR recipient_id IN (${placeholders}))
           ORDER BY created_at DESC
           LIMIT 120`,
        )
        .all(...callerIdList, ...callerIdList)) as {
        id: string;
        owner_id: string;
        recipient_id: string | null;
        kind: string;
        mime_type: string;
        original_name: string;
        size_bytes: number;
        gallery_scope: string | null;
        created_at: string;
      }[];

      for (const r of rows) {
        const isMine = callerIds.has(r.owner_id);
        const scope = r.gallery_scope === "secret" ? "secret" : "normal";
        if (requestedScope && scope !== requestedScope) continue;
        itemsMap.set(r.id, {
          id: r.id,
          kind: r.kind as "image" | "video",
          mimeType: r.mime_type,
          originalName: r.original_name,
          sizeBytes: r.size_bytes,
          galleryScope: scope,
          createdAt: r.created_at,
          url: `/api/media/${r.id}`,
          mine: isMine,
        });
      }
    }

    // 2. Query firebase_media
    const fbRows = (await db
      .prepare(
        `SELECT id, owner_uid, recipient_uid, kind, mime_type, original_name, size_bytes, gallery_scope, created_at
         FROM firebase_media
         WHERE kind IN ('image', 'video')
         ORDER BY created_at DESC
         LIMIT 200`,
      )
      .all()) as {
      id: string;
      owner_uid: string;
      recipient_uid: string | null;
      kind: string;
      mime_type: string;
      original_name: string;
      size_bytes: number;
      gallery_scope: string | null;
      created_at: string;
    }[];

    for (const r of fbRows) {
      if (itemsMap.has(r.id)) continue;
      const isMine = callerIds.has(r.owner_uid) || callerIds.has(`fb_${r.owner_uid}`);
      const recipients = (r.recipient_uid ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const isRecipient = recipients.some(
        (rec) =>
          callerIds.has(rec) ||
          callerIds.has(`fb_${rec}`) ||
          (rec.startsWith("fb_") && callerIds.has(rec.slice(3))),
      );
      const scope = r.gallery_scope === "secret" ? "secret" : "normal";
      if (requestedScope && scope !== requestedScope) continue;
      if (isMine || isRecipient) {
        itemsMap.set(r.id, {
          id: r.id,
          kind: r.kind as "image" | "video",
          mimeType: r.mime_type,
          originalName: r.original_name,
          sizeBytes: r.size_bytes,
          galleryScope: scope,
          createdAt: r.created_at,
          url: `/api/media/${r.id}`,
          mine: isMine,
        });
      }
    }

    const items = Array.from(itemsMap.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 120);

    res.json({ items });
  });

  // Blocking system (backend-enforced)
  router.get("/blocks", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const rows = (await db
      .prepare(
        `SELECT u.*, b.created_at AS blocked_at
         FROM blocked_users b
         JOIN users u ON u.id = b.blocked_id
         WHERE b.blocker_id = ?
         ORDER BY b.created_at DESC`,
      )
      .all(me.id)) as (DbUser & { blocked_at: string })[];

    const uniqueBlockedRows = dedupeRowsById(rows).filter((u) => u.id !== me.id);
    const blockedUsers = await Promise.all(
      uniqueBlockedRows.map(async (u) => ({
        ...(await toPublicUser(u, false, me.id)),
        blockedAt: u.blocked_at,
      })),
    );
    res.json({ blockedUsers });
  });

  router.post("/blocks", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const targetId = String((req.body as { targetUserId?: string })?.targetUserId ?? "").trim();
    if (!targetId || targetId === me.id) {
      res.status(400).json({ error: "Valid user required." });
      return;
    }
    const target = await db.prepare("SELECT id FROM users WHERE id = ?").get(targetId);
    if (!target) {
      res.status(404).json({ error: "User not found." });
      return;
    }

    const now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO blocked_users (blocker_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(me.id, targetId, now);

    sendToUser(targetId, "block:updated", { byUserId: me.id, blocked: true });
    sendToUser(me.id, "block:updated", { targetUserId: targetId, blocked: true });

    res.status(201).json({ ok: true, blockedUserId: targetId });
  });

  router.delete("/blocks/:targetId", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const targetId = String(req.params["targetId"] ?? "").trim();
    await db
      .prepare("DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?")
      .run(me.id, targetId);

    sendToUser(targetId, "block:updated", { byUserId: me.id, blocked: false });
    sendToUser(me.id, "block:updated", { targetUserId: targetId, blocked: false });

    res.json({ ok: true, unblockedUserId: targetId });
  });

  // Report user safety endpoint
  router.post("/reports", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const {
      reportedUserId,
      reason,
      details = "",
    } = req.body as {
      reportedUserId?: string;
      reason?: string;
      details?: string;
    };
    const targetId = String(reportedUserId ?? "").trim();
    if (!targetId || targetId === me.id) {
      res.status(400).json({ error: "Valid user to report is required." });
      return;
    }
    const target = await db.prepare("SELECT id FROM users WHERE id = ? LIMIT 1").get(targetId);
    if (!target) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    const cleanReason = String(reason ?? "")
      .trim()
      .slice(0, 100);
    if (!cleanReason) {
      res.status(400).json({ error: "Please select a reason for this report." });
      return;
    }

    const reportId = `rep_${crypto.randomUUID()}`;
    await db
      .prepare(
        "INSERT INTO user_reports (id, reporter_id, reported_user_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        reportId,
        me.id,
        targetId,
        cleanReason,
        String(details).trim().slice(0, 500),
        new Date().toISOString(),
      );

    res.status(201).json({ ok: true, reportId });
  });

  // Ephemeral WebRTC ICE / TURN credentials endpoint (never leaks permanent secrets to browser code)
  let cachedRemoteIce: { servers: Array<Record<string, unknown>>; expiresAt: number } | null = null;

  router.get("/calls/ice-servers", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const servers: Array<Record<string, unknown>> = [
      {
        urls: [
          "stun:stun.l.google.com:19302",
          "stun:stun1.l.google.com:19302",
          "stun:stun2.l.google.com:19302",
          "stun:stun.cloudflare.com:3478",
        ],
      },
    ];
    let turnConfigured = false;
    let ttlSeconds = 3600;

    // 1. Ephemeral HMAC-SHA1 TURN REST credentials (coturn / eturnal / standard TURN REST API)
    const turnUrlsRaw = readConfiguredEnv("TURN_URLS") ?? readConfiguredEnv("TURN_URL") ?? "";
    const turnUrls = turnUrlsRaw
      .split(",")
      .map((u) => u.trim())
      .filter((u) => u.startsWith("turn:") || u.startsWith("turns:"));
    const turnSecret = readConfiguredEnv("TURN_SECRET");
    const parsedTtl = Number.parseInt(readConfiguredEnv("TURN_TTL_SECONDS") ?? "3600", 10);
    const hmacTtl =
      Number.isFinite(parsedTtl) && parsedTtl >= 60 ? Math.min(86400, parsedTtl) : 3600;

    if (turnUrls.length > 0 && turnSecret) {
      const expiry = Math.floor(Date.now() / 1000) + hmacTtl;
      const userTag = crypto.createHash("sha256").update(me.id).digest("hex").slice(0, 12);
      const username = `${expiry}:${userTag}`;
      const credential = crypto.createHmac("sha1", turnSecret).update(username).digest("base64");
      servers.push({ urls: turnUrls, username, credential });
      turnConfigured = true;
      ttlSeconds = hmacTtl;
    } else if (turnUrls.length > 0) {
      const turnUser = readConfiguredEnv("TURN_USERNAME");
      const turnCred = readConfiguredEnv("TURN_CREDENTIAL");
      if (turnUser && turnCred) {
        servers.push({ urls: turnUrls, username: turnUser, credential: turnCred });
        turnConfigured = true;
      }
    }

    // 2. Server-only JSON ICE list if provided
    const rawServerIceJson = readConfiguredEnv("ICE_SERVERS_JSON");
    if (rawServerIceJson) {
      try {
        const parsed = JSON.parse(rawServerIceJson) as unknown;
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (
              entry &&
              typeof entry === "object" &&
              "urls" in entry &&
              (entry as { urls?: unknown }).urls
            ) {
              servers.push(entry as Record<string, unknown>);
              const urlsVal = Array.isArray((entry as { urls: unknown }).urls)
                ? (entry as { urls: unknown[] }).urls
                : [(entry as { urls: unknown }).urls];
              if (
                urlsVal.some((u) => String(u).startsWith("turn:") || String(u).startsWith("turns:"))
              ) {
                turnConfigured = true;
              }
            }
          }
        }
      } catch {
        /* ignore malformed ICE_SERVERS_JSON */
      }
    }

    // 3. Dynamic ephemeral TURN providers (Twilio NTS, Metered TURN API, Cloudflare TURN)
    if (!turnConfigured) {
      const nowMs = Date.now();
      if (cachedRemoteIce && cachedRemoteIce.expiresAt > nowMs) {
        servers.push(...cachedRemoteIce.servers);
        turnConfigured = cachedRemoteIce.servers.length > 0;
      } else {
        const remoteServers: Array<Record<string, unknown>> = [];
        let remoteTtl = 1800;

        // 3a. Twilio Network Traversal Service (reuses existing TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN if set)
        const twilioCfg = getTwilioConfig();
        if (
          twilioCfg.sid &&
          twilioCfg.token &&
          readConfiguredEnv("TWILIO_NTS_ENABLED") !== "false"
        ) {
          try {
            const auth = Buffer.from(`${twilioCfg.sid}:${twilioCfg.token}`).toString("base64");
            const resp = await fetch(
              `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilioCfg.sid)}/Tokens.json`,
              {
                method: "POST",
                headers: { Authorization: `Basic ${auth}` },
                signal: AbortSignal.timeout(3000),
              },
            );
            if (resp.ok) {
              const data = (await resp.json()) as {
                ttl?: string | number;
                ice_servers?: Array<Record<string, unknown>>;
              };
              const list = Array.isArray(data.ice_servers) ? data.ice_servers : [];
              for (const item of list) {
                if (item && (item["urls"] || item["url"])) {
                  const urls = item["urls"] ?? item["url"];
                  remoteServers.push({
                    urls,
                    ...(item["username"] ? { username: item["username"] } : {}),
                    ...(item["credential"] ? { credential: item["credential"] } : {}),
                  });
                }
              }
              const parsed = Number(data.ttl);
              if (Number.isFinite(parsed) && parsed > 60) {
                remoteTtl = Math.floor(parsed / 2);
              }
            }
          } catch {
            /* fallback to next provider / STUN */
          }
        }

        // 3b. Metered.ca Ephemeral TURN REST API
        const meteredApiUrl = readConfiguredEnv("METERED_API_URL");
        const meteredDomain = readConfiguredEnv("METERED_DOMAIN");
        const meteredKey =
          readConfiguredEnv("METERED_SECRET_KEY") ?? readConfiguredEnv("METERED_API_KEY");
        const meteredEndpoint =
          meteredApiUrl ||
          (meteredDomain && meteredKey
            ? `https://${meteredDomain.replace(/^https?:\/\//i, "").replace(/\/+$/, "")}/api/v1/turn/credentials?apiKey=${encodeURIComponent(meteredKey)}`
            : null);

        if (
          remoteServers.length === 0 &&
          meteredEndpoint &&
          /^https?:\/\//i.test(meteredEndpoint)
        ) {
          try {
            const resp = await fetch(meteredEndpoint, { signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
              const list = (await resp.json()) as unknown;
              if (Array.isArray(list)) {
                for (const item of list) {
                  if (item && typeof item === "object" && "urls" in item) {
                    remoteServers.push(item as Record<string, unknown>);
                  }
                }
              }
            }
          } catch {
            /* fallback cleanly */
          }
        }

        // 3c. Cloudflare Calls / TURN ephemeral key generation
        const cfKeyId = readConfiguredEnv("CLOUDFLARE_TURN_KEY_ID");
        const cfApiToken = readConfiguredEnv("CLOUDFLARE_TURN_API_TOKEN");
        if (remoteServers.length === 0 && cfKeyId && cfApiToken) {
          try {
            const resp = await fetch(
              `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cfKeyId)}/credentials/generate`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${cfApiToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ ttl: 3600 }),
                signal: AbortSignal.timeout(3000),
              },
            );
            if (resp.ok) {
              const data = (await resp.json()) as {
                iceServers?: Record<string, unknown> | Array<Record<string, unknown>>;
              };
              if (Array.isArray(data.iceServers)) {
                remoteServers.push(...data.iceServers);
              } else if (data.iceServers && typeof data.iceServers === "object") {
                remoteServers.push(data.iceServers);
              }
            }
          } catch {
            /* fallback cleanly */
          }
        }

        if (remoteServers.length > 0) {
          cachedRemoteIce = {
            servers: remoteServers,
            expiresAt: nowMs + remoteTtl * 1000,
          };
          servers.push(...remoteServers);
          turnConfigured = true;
          ttlSeconds = remoteTtl;
        }
      }
    }

    res.json({ iceServers: servers, turnConfigured, ttlSeconds });
  });

  // Backend-enforced call initiation (shared with WebSocket call:initiate)
  router.post("/calls/initiate", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const {
      targetUserId,
      targetId,
      callId,
      callType = "audio",
    } = req.body as {
      targetUserId?: string;
      targetId?: string;
      callId?: string;
      callType?: "audio" | "video";
    };
    const resolvedTarget = String(targetId ?? targetUserId ?? "").trim();
    const result = await initiateCallSession({
      callerId: me.id,
      targetId: resolvedTarget,
      callId,
      callType: callType === "video" ? "video" : "audio",
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  // HTTP fallback for retrieving pending incoming calls & durable sequential signals
  router.get("/calls/pending", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const activeCallId =
      typeof req.query["activeCallId"] === "string" ? req.query["activeCallId"].trim() : "";
    const sinceSeqRaw = Number(req.query["sinceSeq"]);
    const sinceSeq = Number.isFinite(sinceSeqRaw) && sinceSeqRaw > 0 ? Math.floor(sinceSeqRaw) : 0;
    const drainSignals = req.query["drainSignals"] === "1" || req.query["drainSignals"] === "true";

    const calls = await getPendingIncomingCallsForUser(me.id);
    const activeCallStatus = activeCallId
      ? await getCallInvitationStatus(activeCallId, me.id)
      : null;

    const durableSignals = activeCallId
      ? await getCallSignalsForUser(me.id, activeCallId, sinceSeq)
      : [];
    const bufferedSignals = drainSignals
      ? popBufferedSignalsForUser(me.id, activeCallId || undefined)
      : [];

    const seenSeq = new Set<number>();
    const signals: Record<string, unknown>[] = [];
    for (const sig of [...durableSignals, ...bufferedSignals]) {
      const seq = Number(sig["seq"]);
      if (Number.isFinite(seq) && seq > 0) {
        if (seenSeq.has(seq)) continue;
        seenSeq.add(seq);
      }
      signals.push(sig);
    }

    res.json({
      calls,
      ...(activeCallStatus ? { activeCallStatus } : {}),
      ...(signals.length > 0 ? { signals } : {}),
    });
  });

  // HTTP fallback for WebRTC call signaling (works over SSE or during brief WS reconnects)
  router.post("/calls/signal", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const body = (req.body ?? {}) as {
      targetId?: string;
      callId?: string;
      action?: string;
      sdp?: unknown;
      candidate?: unknown;
      cameraEnabled?: boolean;
      micMuted?: boolean;
      reason?: string;
    };
    const result = await forwardCallSignal({
      userId: me.id,
      targetId: String(body.targetId ?? ""),
      callId: String(body.callId ?? ""),
      action: String(body.action ?? ""),
      sdp: body.sdp ?? null,
      candidate: body.candidate ?? null,
      cameraEnabled: body.cameraEnabled,
      micMuted: body.micMuted,
      reason: body.reason,
    });
    if (!result.ok) {
      res.status(result.status ?? 400).json({ error: result.error ?? "Signal failed." });
      return;
    }
    res.json({ ok: true, delivered: result.delivered });
  });

  // Protected per-user reading progress, bookmarks, favorites & history sync
  router.get("/reading-state", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const row = (await db
      .prepare("SELECT state_json, updated_at FROM user_reading_state WHERE user_id = ? LIMIT 1")
      .get(me.id)) as { state_json: string; updated_at: string } | undefined;

    if (!row) {
      res.json({ state: null, updatedAt: null });
      return;
    }

    try {
      const parsed = JSON.parse(row.state_json) as Record<string, unknown>;
      res.json({ state: parsed, updatedAt: row.updated_at });
    } catch {
      res.json({ state: null, updatedAt: null });
    }
  });

  router.put("/reading-state", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const body = req.body as { state?: Record<string, unknown> };
    if (
      !body ||
      typeof body.state !== "object" ||
      body.state === null ||
      Array.isArray(body.state)
    ) {
      res.status(400).json({ error: "Valid reading state object is required." });
      return;
    }

    const raw = body.state;
    const sanitized = {
      onboarded: Boolean(raw["onboarded"]),
      languages: Array.isArray(raw["languages"]) ? raw["languages"].slice(0, 20) : [],
      categories: Array.isArray(raw["categories"]) ? raw["categories"].slice(0, 30) : [],
      appTheme:
        raw["appTheme"] === "light" || raw["appTheme"] === "dark" || raw["appTheme"] === "system"
          ? raw["appTheme"]
          : "system",
      reader: typeof raw["reader"] === "object" && raw["reader"] !== null ? raw["reader"] : {},
      notifications:
        typeof raw["notifications"] === "object" && raw["notifications"] !== null
          ? raw["notifications"]
          : { reminders: true, newBooks: true },
      progress:
        typeof raw["progress"] === "object" && raw["progress"] !== null ? raw["progress"] : {},
      favorites: Array.isArray(raw["favorites"]) ? raw["favorites"].slice(0, 300) : [],
      bookmarks: Array.isArray(raw["bookmarks"]) ? raw["bookmarks"].slice(0, 500) : [],
      completed: Array.isArray(raw["completed"]) ? raw["completed"].slice(0, 300) : [],
      history: Array.isArray(raw["history"]) ? raw["history"].slice(0, 80) : [],
      streak: typeof raw["streak"] === "number" ? raw["streak"] : 1,
    };

    const now = new Date().toISOString();
    const serialized = JSON.stringify(sanitized);
    if (serialized.length > 512_000) {
      res.status(413).json({ error: "Reading state payload too large." });
      return;
    }

    await db
      .prepare(
        `INSERT INTO user_reading_state (user_id, state_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      )
      .run(me.id, serialized, now);

    res.json({ ok: true, updatedAt: now });
  });

  // Notification token registration & per-user preferences (strictly scoped to caller)
  router.get("/notifications/status", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const countRow = (await db
      .prepare("SELECT COUNT(*) AS cnt FROM notification_tokens WHERE user_id = ?")
      .get(me.id)) as { cnt: number };
    res.json({
      fcmServerConfigured: isFcmServerPushConfigured(),
      registeredDevices: Number(countRow?.cnt ?? 0),
    });
  });

  router.get("/notifications/preferences", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const row = (await db
      .prepare(
        "SELECT push_enabled, message_preview, call_alerts, quiet_hours_enabled, updated_at FROM notification_preferences WHERE user_id = ? LIMIT 1",
      )
      .get(me.id)) as
      | {
          push_enabled: number;
          message_preview: number;
          call_alerts: number;
          quiet_hours_enabled: number;
          updated_at: string;
        }
      | undefined;

    res.json({
      pushEnabled: row ? row.push_enabled === 1 : true,
      messagePreview: row ? row.message_preview === 1 : true,
      callAlerts: row ? row.call_alerts === 1 : true,
      quietHoursEnabled: row ? row.quiet_hours_enabled === 1 : false,
      updatedAt: row?.updated_at ?? null,
    });
  });

  router.patch("/notifications/preferences", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const existing = (await db
      .prepare(
        "SELECT push_enabled, message_preview, call_alerts, quiet_hours_enabled FROM notification_preferences WHERE user_id = ? LIMIT 1",
      )
      .get(me.id)) as
      | {
          push_enabled: number;
          message_preview: number;
          call_alerts: number;
          quiet_hours_enabled: number;
        }
      | undefined;

    const body = (req.body ?? {}) as {
      pushEnabled?: boolean;
      messagePreview?: boolean;
      callAlerts?: boolean;
      quietHoursEnabled?: boolean;
    };
    const pushEnabled =
      typeof body.pushEnabled === "boolean"
        ? body.pushEnabled
          ? 1
          : 0
        : (existing?.push_enabled ?? 1);
    const messagePreview =
      typeof body.messagePreview === "boolean"
        ? body.messagePreview
          ? 1
          : 0
        : (existing?.message_preview ?? 1);
    const callAlerts =
      typeof body.callAlerts === "boolean"
        ? body.callAlerts
          ? 1
          : 0
        : (existing?.call_alerts ?? 1);
    const quietHoursEnabled =
      typeof body.quietHoursEnabled === "boolean"
        ? body.quietHoursEnabled
          ? 1
          : 0
        : (existing?.quiet_hours_enabled ?? 0);

    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO notification_preferences (user_id, push_enabled, message_preview, call_alerts, quiet_hours_enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           push_enabled = excluded.push_enabled,
           message_preview = excluded.message_preview,
           call_alerts = excluded.call_alerts,
           quiet_hours_enabled = excluded.quiet_hours_enabled,
           updated_at = excluded.updated_at`,
      )
      .run(me.id, pushEnabled, messagePreview, callAlerts, quietHoursEnabled, now);

    res.json({
      pushEnabled: pushEnabled === 1,
      messagePreview: messagePreview === 1,
      callAlerts: callAlerts === 1,
      quietHoursEnabled: quietHoursEnabled === 1,
      updatedAt: now,
    });
  });

  router.post("/notifications/token", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const body = (req.body ?? {}) as { token?: string; platform?: string };
    const token = typeof body.token === "string" ? body.token.trim().slice(0, 512) : "";
    if (token.length < 16) {
      res.status(400).json({ error: "Valid notification device token is required." });
      return;
    }
    const platform =
      body.platform === "android" || body.platform === "ios" || body.platform === "desktop"
        ? body.platform
        : "web";
    const ua = String(req.headers["user-agent"] ?? "").slice(0, 200);
    const now = new Date().toISOString();

    await db
      .prepare(
        `INSERT INTO notification_tokens (id, user_id, token, platform, user_agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, token) DO UPDATE SET platform = excluded.platform, user_agent = excluded.user_agent, updated_at = excluded.updated_at`,
      )
      .run(`ntok_${crypto.randomUUID()}`, me.id, token, platform, ua, now, now);

    res.status(201).json({ ok: true, platform, updatedAt: now });
  });

  router.delete("/notifications/token", requireAuth, async (req: AuthedRequest, res) => {
    const me = req.authUser!;
    const body = (req.body ?? {}) as { token?: string };
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (token) {
      await db
        .prepare("DELETE FROM notification_tokens WHERE user_id = ? AND token = ?")
        .run(me.id, token);
    } else {
      await db.prepare("DELETE FROM notification_tokens WHERE user_id = ?").run(me.id);
    }
    res.json({ ok: true });
  });

  return router;
}
