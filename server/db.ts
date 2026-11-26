import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function getDataRoot(): string {
  return process.env["DATA_DIR"]?.trim() || os.tmpdir();
}

const uploadDir = path.join(getDataRoot(), "reading-corner-uploads");
fs.mkdirSync(uploadDir, { recursive: true });
export const mediaDir = uploadDir;

const MEDIA_BUCKET = "reading-corner-media";

let supabase: SupabaseClient | undefined;
let localDb: Database.Database | undefined;
let localDbPath: string | undefined;

function getSupabase(): SupabaseClient | null {
  if (supabase) return supabase;
  const url = readConfiguredEnv("SUPABASE_URL") ?? readConfiguredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey =
    readConfiguredEnv("SUPABASE_SERVICE_ROLE_KEY") ?? readConfiguredEnv("SUPABASE_SECRET_KEY");
  if (!url || !serviceKey || !/^https?:\/\/[^/\s]+/i.test(url)) {
    return null;
  }
  supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  return supabase;
}

function ensureColumns(
  dbInstance: Database.Database,
  table: string,
  columns: Array<{ name: string; definition: string }>,
) {
  const existing = new Set(
    (dbInstance.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (col) => col.name,
    ),
  );
  for (const col of columns) {
    if (!existing.has(col.name)) {
      dbInstance.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.definition}`);
    }
  }
}

function getLocalDb(): Database.Database {
  const targetPath = path.join(getDataRoot(), "reading_corner_local.db");
  if (localDb && localDbPath === targetPath) return localDb;
  if (localDb) {
    localDb.close();
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  localDbPath = targetPath;
  localDb = new Database(targetPath);
  localDb.pragma("journal_mode = WAL");
  localDb.pragma("foreign_keys = ON");

  localDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      phone_e164 TEXT,
      phone_verified INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'user',
      full_name TEXT NOT NULL,
      display_handle TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      avatar_media_id TEXT,
      avatar_external_url TEXT,
      password_hash TEXT NOT NULL,
      theme TEXT NOT NULL DEFAULT 'instagram',
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS followers (
      follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (follower_id, following_id)
    );
    CREATE TABLE IF NOT EXISTS blocked_users (
      blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (blocker_id, blocked_id)
    );
    CREATE TABLE IF NOT EXISTS media_objects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id TEXT,
      kind TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      is_public_avatar INTEGER NOT NULL DEFAULT 0,
      gallery_scope TEXT NOT NULL DEFAULT 'normal',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS firebase_media (
      id TEXT PRIMARY KEY,
      owner_uid TEXT NOT NULL,
      recipient_uid TEXT,
      kind TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      gallery_scope TEXT NOT NULL DEFAULT 'normal',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_key TEXT NOT NULL,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL DEFAULT '',
      media_id TEXT,
      media_kind TEXT,
      media_name TEXT,
      reply_to_id TEXT,
      edited_at TEXT,
      deleted_at TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      seen_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_key, created_at, id);
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_settings (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      peer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pinned INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, peer_id)
    );
    CREATE TABLE IF NOT EXISTS nfc_links (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE,
      token_ciphertext TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS firebase_nfc_links (
      id TEXT PRIMARY KEY,
      uid TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      display_handle TEXT NOT NULL,
      token_hash TEXT UNIQUE,
      token_ciphertext TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS otp_challenges (
      id TEXT PRIMARY KEY,
      phone_e164 TEXT NOT NULL,
      purpose TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS email_otp_challenges (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL,
      user_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      rate_key TEXT PRIMARY KEY,
      failures INTEGER NOT NULL DEFAULT 0,
      first_failure_at TEXT NOT NULL,
      locked_until TEXT
    );
    CREATE TABLE IF NOT EXISTS user_reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reported_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_reading_state (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'web',
      user_agent TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, token)
    );
    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      push_enabled INTEGER NOT NULL DEFAULT 1,
      message_preview INTEGER NOT NULL DEFAULT 1,
      call_alerts INTEGER NOT NULL DEFAULT 1,
      quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS call_invitations (
      call_id TEXT PRIMARY KEY,
      caller_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      call_type TEXT NOT NULL DEFAULT 'audio',
      status TEXT NOT NULL DEFAULT 'ringing',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_call_invitations_target_status
      ON call_invitations(target_id, status, expires_at);
  `);

  ensureColumns(localDb, "media_objects", [
    { name: "file_path", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "is_public_avatar", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "gallery_scope", definition: "TEXT NOT NULL DEFAULT 'normal'" },
  ]);
  ensureColumns(localDb, "firebase_media", [
    { name: "gallery_scope", definition: "TEXT NOT NULL DEFAULT 'normal'" },
  ]);

  const mediaCols = (
    localDb.prepare("PRAGMA table_info(media_objects)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (mediaCols.includes("storage_path")) {
    localDb.pragma("foreign_keys = OFF");
    try {
      localDb.transaction(() => {
        localDb!.exec(`
          CREATE TABLE media_objects_migrated (
            id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            recipient_id TEXT,
            kind TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            original_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            is_public_avatar INTEGER NOT NULL DEFAULT 0,
            gallery_scope TEXT NOT NULL DEFAULT 'normal',
            created_at TEXT NOT NULL
          );
          INSERT INTO media_objects_migrated (
            id, owner_id, recipient_id, kind, mime_type, original_name, file_path, size_bytes, is_public_avatar, gallery_scope, created_at
          )
          SELECT
            id, owner_id, recipient_id, kind, mime_type, original_name,
            COALESCE(NULLIF(file_path, ''), storage_path, ''),
            size_bytes, COALESCE(is_public_avatar, 0), COALESCE(NULLIF(gallery_scope, ''), 'normal'), created_at
          FROM media_objects;
          DROP TABLE media_objects;
          ALTER TABLE media_objects_migrated RENAME TO media_objects;
        `);
      })();
    } finally {
      localDb.pragma("foreign_keys = ON");
    }
  }

  ensureColumns(localDb, "messages", [
    { name: "media_kind", definition: "TEXT" },
    { name: "media_name", definition: "TEXT" },
    { name: "reply_to_id", definition: "TEXT" },
    { name: "edited_at", definition: "TEXT" },
    { name: "deleted_at", definition: "TEXT" },
    { name: "delivered_at", definition: "TEXT" },
  ]);

  return localDb;
}

export async function createSignedMediaUpload(key: string): Promise<string> {
  const sb = getSupabase();
  if (sb) {
    try {
      const { data, error } = await sb.storage
        .from(MEDIA_BUCKET)
        .createSignedUploadUrl(key, { upsert: true });
      if (!error && data?.token) return data.token;
    } catch {
      // Fall through to local token
    }
  }
  return `local_token_${crypto.randomBytes(16).toString("hex")}`;
}

export async function mediaStorageObjectExists(key: string): Promise<boolean> {
  const sb = getSupabase();
  if (sb) {
    try {
      const separator = key.lastIndexOf("/");
      const folder = separator < 0 ? "" : key.slice(0, separator);
      const filename = separator < 0 ? key : key.slice(separator + 1);
      const { data, error } = await sb.storage
        .from(MEDIA_BUCKET)
        .list(folder, { search: filename, limit: 100 });
      if (!error && data && data.some((item) => item.name === filename)) {
        return true;
      }
    } catch {
      // Fall through to local check
    }
  }
  const filePath = path.join(uploadDir, key);
  return fs.existsSync(filePath);
}

export async function uploadMediaStorage(
  key: string,
  file: Buffer,
  contentType: string,
): Promise<void> {
  const sb = getSupabase();
  if (sb) {
    try {
      const { error } = await sb.storage.from(MEDIA_BUCKET).upload(key, file, {
        contentType,
        upsert: true,
      });
      if (!error) return;
    } catch {
      // Fall through to local disk
    }
  }
  const filePath = path.join(uploadDir, key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, file);
}

export async function downloadMediaStorage(key: string): Promise<Buffer | null> {
  const sb = getSupabase();
  if (sb) {
    try {
      const { data, error } = await sb.storage.from(MEDIA_BUCKET).download(key);
      if (!error && data) {
        return Buffer.from(await data.arrayBuffer());
      }
    } catch {
      // Fall through to local check
    }
  }
  const filePath = path.join(uploadDir, key);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

export async function deleteMediaStorage(key: string): Promise<void> {
  const sb = getSupabase();
  if (sb) {
    const { error } = await sb.storage.from(MEDIA_BUCKET).remove([key]);
    if (error) throw new Error(`Media removal failed: ${error.message}`);
    return;
  }
  const filePath = path.join(uploadDir, key);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

async function execute<T>(
  statement: string,
  parameters: unknown[],
  operation: "all" | "one" | "run",
): Promise<T> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.rpc("app_execute_sql", {
      statement,
      parameters,
      operation,
    });
    if (error) {
      throw new Error(`Persistent database request failed: ${error.message}`);
    }
    return data as T;
  }

  const dbInstance = getLocalDb();
  let sqliteStmt = statement;
  let paramIdx = 1;
  while (sqliteStmt.includes(`$${paramIdx}`)) {
    sqliteStmt = sqliteStmt.replaceAll(`$${paramIdx}`, "?");
    paramIdx++;
  }
  sqliteStmt = sqliteStmt.replace(/NOW\(\)/gi, "datetime('now')");

  const stmt = dbInstance.prepare(sqliteStmt);
  if (operation === "all") {
    return stmt.all(...parameters) as T;
  } else if (operation === "one") {
    return stmt.get(...parameters) as T;
  } else {
    const info = stmt.run(...parameters);
    return { changes: info.changes } as T;
  }
}

type RunResult = { changes: number };
export const db = {
  prepare(statement: string) {
    return {
      all: (...parameters: unknown[]) => execute<unknown[]>(statement, parameters, "all"),
      get: (...parameters: unknown[]) => execute<unknown | undefined>(statement, parameters, "one"),
      run: (...parameters: unknown[]) => execute<RunResult>(statement, parameters, "run"),
    };
  },
};

export const MAX_ACCOUNTS_PER_CONTACT = 3;

const PLACEHOLDER_ENV_RE =
  /^(?:MY_[A-Z0-9_]+|YOUR_[A-Z0-9_]+|<[^>]+>|\[[^\]]+\]|unset|none|null|undefined|placeholder|changeme|dummy|redacted|\*+)$/i;

function getRuntimeEnvSentinels(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const sentinels = new Set<string>();
  const canaryValidators: Array<[string, (v: string) => boolean]> = [
    ["ADMIN_EMAILS", (v) => v.includes("@")],
    ["RESEND_API_KEY", (v) => /^re_[a-z0-9_]{10,}$/i.test(v)],
    ["RESEND_FROM", (v) => v.includes("@")],
    ["TWILIO_ACCOUNT_SID", (v) => /^AC[a-f0-9]{32}$/i.test(v)],
    ["TWILIO_VERIFY_SERVICE_SID", (v) => /^VA[a-f0-9]{32}$/i.test(v)],
    ["APP_URL", (v) => /^https?:\/\//i.test(v)],
    ["SUPABASE_URL", (v) => /^https?:\/\/[^/\s]+/i.test(v)],
    ["NEXT_PUBLIC_SUPABASE_URL", (v) => /^https?:\/\/[^/\s]+/i.test(v)],
    ["FIREBASE_SERVICE_ACCOUNT", (v) => v.trim().startsWith("{")],
  ];
  for (const [key, isValid] of canaryValidators) {
    const raw = env[key]?.trim();
    if (raw && !isValid(raw)) {
      sentinels.add(raw);
    }
  }
  return sentinels;
}

export function readConfiguredEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (PLACEHOLDER_ENV_RE.test(raw)) return undefined;
  if (getRuntimeEnvSentinels(env).has(raw)) return undefined;
  return raw;
}

export function getAdminEmailSet(): Set<string> {
  const configured = readConfiguredEnv("ADMIN_EMAILS");
  const source = configured && configured.includes("@") ? configured : "mohammadakeem22@gmail.com";
  return new Set(
    source
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.includes("@")),
  );
}

export type SecretTheme = "instagram" | "emerald" | "dark";
export type DbUser = {
  id: string;
  email: string | null;
  email_verified: number;
  phone_e164: string | null;
  phone_verified: number;
  role: string;
  full_name: string;
  display_handle: string;
  bio: string;
  avatar_media_id: string | null;
  avatar_external_url?: string | null;
  password_hash: string;
  theme: SecretTheme;
  created_at: string;
  last_active_at: string;
};
export type PublicUser = {
  id: string;
  fullName: string;
  displayHandle: string;
  bio: string;
  avatarUrl: string | null;
  theme: SecretTheme;
  phoneVerified: boolean;
  lastActiveAt: string;
  online: boolean;
  followerCount?: number;
  followingCount?: number;
  isFollowing?: boolean;
  followsMe?: boolean;
};

function loadServerSecret(): string {
  const secret = readConfiguredEnv("SESSION_SECRET") || readConfiguredEnv("SUPABASE_JWT_SECRET");
  if (secret && secret.length >= 16) return secret;
  if (process.env["VERCEL"] === "1") {
    throw new Error("Set a stable SESSION_SECRET for production session signing.");
  }
  return "local-development-only-reading-corner-secret";
}
const SERVER_SECRET = loadServerSecret();
const NFC_KEY = crypto.createHash("sha256").update(`nfc::${SERVER_SECRET}`).digest();

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function signCookieToken(uid: string, ttlSeconds = 7 * 24 * 60 * 60): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ uid, exp }), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", SERVER_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyCookieToken(token: string): { uid: string } | null {
  try {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const expected = crypto.createHmac("sha256", SERVER_SECRET).update(payload).digest("base64url");
    const actualBuffer = Buffer.from(sig);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    )
      return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      uid?: string;
      exp?: number;
    };
    if (!parsed.uid || !parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return { uid: parsed.uid };
  } catch {
    return null;
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, salt, expectedHex] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", NFC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptToken(payload: string): string | null {
  try {
    const [iv, tag, encrypted] = payload.split(".");
    if (!iv || !tag || !encrypted) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", NFC_KEY, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return value && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? value : null;
}
export function normalizeHandle(raw: string): string | null {
  const value = raw
    .trim()
    .replace(/^@+/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 28)
    .toLowerCase();
  return value.length >= 2 ? `@${value}` : null;
}
export function normalizePhoneE164(raw: string, defaultCountryCode = "+91"): string | null {
  const cleaned = raw.trim().replace(/[\s\-().]/g, "");
  if (!cleaned) return null;
  const international = cleaned.startsWith("+")
    ? cleaned.slice(1)
    : cleaned.startsWith("00")
      ? cleaned.slice(2)
      : "";
  const digits = international
    ? international.replace(/\D/g, "")
    : `${defaultCountryCode.startsWith("+") ? defaultCountryCode : `+${defaultCountryCode}`}${cleaned.replace(/\D/g, "").replace(/^0/, "")}`.slice(
        1,
      );
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}
export function threadKeyFor(userA: string, userB: string): string {
  return [userA, userB].sort().join("::");
}
export function isOnlineActive(lastActiveAt: string): boolean {
  const timestamp = Date.parse(lastActiveAt);
  return !Number.isNaN(timestamp) && Date.now() - timestamp < 90_000;
}

export async function getFollowStats(userId: string, viewerId?: string) {
  const [followersRow, followingRow] = await Promise.all([
    (await db
      .prepare("SELECT COUNT(*) AS cnt FROM followers WHERE following_id = ?")
      .get(userId)) as Promise<{ cnt: number }>,
    (await db
      .prepare("SELECT COUNT(*) AS cnt FROM followers WHERE follower_id = ?")
      .get(userId)) as Promise<{ cnt: number }>,
  ]);
  let isFollowing = false;
  let followsMe = false;
  if (viewerId && viewerId !== userId) {
    [isFollowing, followsMe] = await Promise.all([
      await db
        .prepare("SELECT 1 FROM followers WHERE follower_id = ? AND following_id = ? LIMIT 1")
        .get(viewerId, userId)
        .then(Boolean),
      await db
        .prepare("SELECT 1 FROM followers WHERE follower_id = ? AND following_id = ? LIMIT 1")
        .get(userId, viewerId)
        .then(Boolean),
    ]);
  }
  return {
    followerCount: Number(followersRow.cnt),
    followingCount: Number(followingRow.cnt),
    isFollowing,
    followsMe,
  };
}

export async function toPublicUser(
  u: DbUser,
  onlineOverride?: boolean,
  viewerId?: string,
): Promise<PublicUser> {
  const stats = await getFollowStats(u.id, viewerId);
  return {
    id: u.id,
    fullName: u.full_name,
    displayHandle: u.display_handle,
    bio: u.bio,
    avatarUrl: u.avatar_media_id
      ? `/api/media/${u.avatar_media_id}`
      : (u.avatar_external_url ?? null),
    theme: u.theme === "emerald" || u.theme === "dark" ? u.theme : "instagram",
    phoneVerified: u.phone_verified === 1,
    lastActiveAt: u.last_active_at,
    online: onlineOverride ?? isOnlineActive(u.last_active_at),
    ...stats,
  };
}

export async function createNfcTokenForUser(
  userId: string,
): Promise<{ token: string; version: number }> {
  const token = `rc_${crypto.randomBytes(24).toString("base64url")}`;
  const tokenHash = sha256(token);
  const ciphertext = encryptToken(token);
  const now = new Date().toISOString();
  const existing = (await await db
    .prepare("SELECT id, version FROM nfc_links WHERE user_id = ?")
    .get(userId)) as { id: string; version: number } | undefined;
  if (existing) {
    const version = existing.version + 1;
    await await db
      .prepare(
        "UPDATE nfc_links SET token_ciphertext = ?, token_hash = ?, revoked = 0, version = ?, updated_at = ? WHERE user_id = ?",
      )
      .run(ciphertext, tokenHash, version, now, userId);
    return { token, version };
  }
  await await db
    .prepare(
      "INSERT INTO nfc_links (id, user_id, token_ciphertext, token_hash, revoked, version, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, ?, ?)",
    )
    .run(`nfc_${crypto.randomUUID()}`, userId, ciphertext, tokenHash, now, now);
  return { token, version: 1 };
}

export async function createFirebaseNfcToken(
  uid: string,
  fullName = "Reader",
  displayHandle = "",
): Promise<{ token: string; version: number }> {
  const token = `rc_${crypto.randomBytes(24).toString("base64url")}`;
  const tokenHash = sha256(token);
  const ciphertext = encryptToken(token);
  const now = new Date().toISOString();
  const safeName = fullName.trim().slice(0, 60) || "Reader";
  const safeHandle = displayHandle.trim().slice(0, 32) || `@reader.${uid.slice(-4).toLowerCase()}`;
  const existing = (await await db
    .prepare("SELECT id, version FROM firebase_nfc_links WHERE uid = ?")
    .get(uid)) as { id: string; version: number } | undefined;
  if (existing) {
    const version = existing.version + 1;
    await await db
      .prepare(
        "UPDATE firebase_nfc_links SET full_name = ?, display_handle = ?, token_ciphertext = ?, token_hash = ?, revoked = 0, version = ?, updated_at = ? WHERE uid = ?",
      )
      .run(safeName, safeHandle, ciphertext, tokenHash, version, now, uid);
    return { token, version };
  }
  await await db
    .prepare(
      "INSERT INTO firebase_nfc_links (id, uid, full_name, display_handle, token_ciphertext, token_hash, revoked, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)",
    )
    .run(
      `fbnfc_${crypto.randomUUID()}`,
      uid,
      safeName,
      safeHandle,
      ciphertext,
      tokenHash,
      now,
      now,
    );
  return { token, version: 1 };
}

export async function isBlockedBetween(userA: string, userB: string): Promise<boolean> {
  return Boolean(
    await await db
      .prepare(
        "SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1",
      )
      .get(userA, userB, userB, userA),
  );
}
export async function didUserBlock(blockerId: string, blockedId: string): Promise<boolean> {
  return Boolean(
    await await db
      .prepare("SELECT 1 FROM blocked_users WHERE blocker_id = ? AND blocked_id = ? LIMIT 1")
      .get(blockerId, blockedId),
  );
}
export function isAdminUser(user: DbUser | null | undefined): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  return Boolean(
    user.email && user.email_verified === 1 && getAdminEmailSet().has(user.email.toLowerCase()),
  );
}
export async function countAccountsByEmail(email: string): Promise<number> {
  const row = (await await db
    .prepare("SELECT COUNT(*) AS cnt FROM users WHERE LOWER(email) = LOWER(?)")
    .get(email)) as { cnt: number };
  return Number(row.cnt);
}
export async function countAccountsByPhone(phoneE164: string): Promise<number> {
  const row = (await await db
    .prepare("SELECT COUNT(*) AS cnt FROM users WHERE phone_e164 = ?")
    .get(phoneE164)) as { cnt: number };
  return Number(row.cnt);
}
export async function getLinkedSiblingAccounts(user: DbUser): Promise<DbUser[]> {
  const clauses = ["id = ?"];
  const params: unknown[] = [user.id];
  if (user.email && user.email_verified === 1) {
    clauses.push("(LOWER(email) = LOWER(?) AND email_verified = 1)");
    params.push(user.email);
  }
  if (user.phone_e164 && user.phone_verified === 1) {
    clauses.push("(phone_e164 = ? AND phone_verified = 1)");
    params.push(user.phone_e164);
  }
  const rows = (await await db
    .prepare(`SELECT * FROM users WHERE ${clauses.join(" OR ")} ORDER BY created_at ASC`)
    .all(...params)) as DbUser[];
  const byId = new Map<string, DbUser>();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return Array.from(byId.values());
}

export async function checkRateLimit(
  rateKey: string,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const row = (await await db
    .prepare(
      "SELECT failures, first_failure_at, locked_until FROM auth_rate_limits WHERE rate_key = ? LIMIT 1",
    )
    .get(rateKey)) as
    { failures: number; first_failure_at: string; locked_until: string | null } | undefined;
  if (!row?.locked_until) return { allowed: true, retryAfterSeconds: 0 };
  const lockMs = Date.parse(row.locked_until);
  if (Number.isNaN(lockMs) || lockMs <= Date.now()) return { allowed: true, retryAfterSeconds: 0 };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((lockMs - Date.now()) / 1000)),
  };
}
export async function recordRateLimitFailure(
  rateKey: string,
  maxFailures = 5,
  windowMs = 15 * 60 * 1000,
  lockMs = 15 * 60 * 1000,
): Promise<{ locked: boolean; retryAfterSeconds: number }> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const row = (await await db
    .prepare("SELECT failures, first_failure_at FROM auth_rate_limits WHERE rate_key = ? LIMIT 1")
    .get(rateKey)) as { failures: number; first_failure_at: string } | undefined;
  const firstMs = row ? Date.parse(row.first_failure_at) : 0;
  const expiredWindow = !row || Number.isNaN(firstMs) || now - firstMs > windowMs;
  const failures = expiredWindow ? 1 : row.failures + 1;
  const locked = failures >= maxFailures;
  const lockedUntil = locked ? new Date(now + lockMs).toISOString() : null;
  await await db
    .prepare(
      "INSERT INTO auth_rate_limits (rate_key, failures, first_failure_at, locked_until) VALUES (?, ?, ?, ?) ON CONFLICT(rate_key) DO UPDATE SET failures = excluded.failures, first_failure_at = excluded.first_failure_at, locked_until = excluded.locked_until",
    )
    .run(rateKey, failures, expiredWindow ? nowIso : row.first_failure_at, lockedUntil);
  return { locked, retryAfterSeconds: locked ? Math.ceil(lockMs / 1000) : 0 };
}
export async function clearRateLimit(rateKey: string): Promise<void> {
  await await db.prepare("DELETE FROM auth_rate_limits WHERE rate_key = ?").run(rateKey);
}
