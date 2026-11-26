export type AppPermissionKind = "microphone" | "camera" | "notifications";

/** Call directly from a user gesture immediately before using the protected feature. */
export async function requestFeatureMediaPermission(
  kind: "microphone" | "camera",
): Promise<AppPermissionState> {
  const existing = await queryBrowserMediaPermission(kind);
  if (existing === "granted") return "granted";
  // Let Android Chrome/PWA display its native permission prompt; window.confirm creates a
  // second, confusing browser-owned alert that looks like an error and is not a permission.
  return requestSingleAppPermission(kind);
}

export type AppPermissionState = "granted" | "denied" | "prompt" | "unsupported";
export type PermissionStateValue = AppPermissionState;

export type PermissionSnapshot = Record<AppPermissionKind, AppPermissionState>;

export const APP_PERMISSION_ITEMS: ReadonlyArray<{
  kind: AppPermissionKind;
  title: string;
  description: string;
}> = [
  {
    kind: "microphone",
    title: "Microphone",
    description: "Required for voice notes, audio calls, and video calls in chat.",
  },
  {
    kind: "camera",
    title: "Camera",
    description: "Required for live video calls and capturing photos or videos.",
  },
  {
    kind: "notifications",
    title: "Notifications",
    description: "Alerts you for incoming calls and real-time direct messages.",
  },
];

const STARTUP_PROMPTED_KEY = "rc_permissions_prompted_v1";

export function normalizePermissionState(raw: string | null | undefined): AppPermissionState {
  if (raw === "granted") return "granted";
  if (raw === "denied") return "denied";
  if (raw === "prompt" || raw === "default") return "prompt";
  return "unsupported";
}

export function shouldShowStartupPermissions(
  snapshot: PermissionSnapshot,
  alreadyPrompted: boolean,
): boolean {
  if (alreadyPrompted) return false;
  return (
    snapshot.microphone === "prompt" ||
    snapshot.camera === "prompt" ||
    snapshot.notifications === "prompt"
  );
}

export type DevicePlatform = "android" | "ios" | "desktop";

export function detectDevicePlatform(userAgent?: string): DevicePlatform {
  const ua = userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  return "desktop";
}

export function getMobilePermissionSettingsGuide(platform: DevicePlatform): {
  title: string;
  subtitle: string;
  steps: string[];
} {
  if (platform === "android") {
    return {
      title: "Android Mobile & Chrome Settings",
      subtitle: "Turn permissions on whenever you need microphone, camera, or notifications.",
      steps: [
        "Open Chrome or your mobile browser menu (⋮) → Settings → Site settings (or tap the lock/tune icon beside the address bar).",
        "Select Permissions → Microphone, Camera, and Notifications, then switch each one to Allow.",
        "If blocked at the system level, open Android Settings → Apps → your browser (or Reading Corner) → Permissions and set Microphone, Camera, and Notifications to Allow.",
      ],
    };
  }
  if (platform === "ios") {
    return {
      title: "iPhone & iPad Settings",
      subtitle: "Allow Reading Corner to access microphone, camera, and alerts on iOS.",
      steps: [
        "Open iPhone Settings → Apps → Safari (or your installed browser) to verify Camera & Microphone access is set to Ask or Allow.",
        "Inside Safari, tap the page menu (AA / puzzle icon in the address bar) → Website Settings and set Camera and Microphone to Allow.",
        "For call/message notifications on iPhone, add Reading Corner to your Home Screen (Share → Add to Home Screen) and allow Notifications in iPhone Settings → Notifications.",
      ],
    };
  }
  return {
    title: "Browser Site Settings",
    subtitle: "Manage microphone, camera, and notification permissions for Reading Corner.",
    steps: [
      "Click the site-info / tune icon on the left side of your browser address bar.",
      "Toggle Microphone, Camera, and Notifications to Allow whenever you need them.",
      "If a permission stays Blocked, open your browser Settings → Privacy & security → Site settings and clear the block for this site, then tap Re-check Permissions below.",
    ],
  };
}

export function countGrantedPermissions(snapshot: PermissionSnapshot): number {
  return APP_PERMISSION_ITEMS.reduce(
    (count, item) => count + (snapshot[item.kind] === "granted" ? 1 : 0),
    0,
  );
}

export function hasPromptedStartupPermissions(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STARTUP_PROMPTED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markStartupPermissionsPrompted(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STARTUP_PROMPTED_KEY, "1");
  } catch {
    /* ignore storage failures */
  }
}

async function queryBrowserMediaPermission(
  name: "microphone" | "camera",
): Promise<AppPermissionState> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return "unsupported";
  }
  if (!navigator.permissions?.query) {
    return "prompt";
  }
  try {
    const status = await navigator.permissions.query({ name: name as PermissionName });
    return normalizePermissionState(status.state);
  } catch {
    return "prompt";
  }
}

function queryNotificationPermission(): AppPermissionState {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  return normalizePermissionState(Notification.permission);
}

export async function queryAllAppPermissions(): Promise<PermissionSnapshot> {
  const [microphone, camera] = await Promise.all([
    queryBrowserMediaPermission("microphone"),
    queryBrowserMediaPermission("camera"),
  ]);
  const notifications = queryNotificationPermission();
  return { microphone, camera, notifications };
}

function stopMediaStream(stream: MediaStream | null | undefined) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* ignore track stop failures */
    }
  }
}

export async function requestSingleAppPermission(
  kind: AppPermissionKind,
): Promise<AppPermissionState> {
  if (kind === "notifications") {
    if (typeof window === "undefined" || typeof Notification === "undefined") {
      return "unsupported";
    }
    try {
      const result = await Notification.requestPermission();
      return normalizePermissionState(result);
    } catch {
      return queryNotificationPermission();
    }
  }

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return "unsupported";
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === "microphone" ? { audio: true } : { video: true },
    );
    stopMediaStream(stream);
    return "granted";
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "denied";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "unsupported";
    }
    return queryBrowserMediaPermission(kind);
  }
}

export async function requestAllAppPermissions(): Promise<PermissionSnapshot> {
  let microphone: AppPermissionState = "unsupported";
  let camera: AppPermissionState = "unsupported";

  if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
    try {
      const combined = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stopMediaStream(combined);
      microphone = "granted";
      camera = "granted";
    } catch {
      // Request audio and video separately so one missing or denied device doesn't block the other.
      microphone = await requestSingleAppPermission("microphone");
      camera = await requestSingleAppPermission("camera");
    }
  }

  const notifications = await requestSingleAppPermission("notifications");
  return { microphone, camera, notifications };
}
