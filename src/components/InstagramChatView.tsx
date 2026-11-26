import {
  AlertCircle,
  ArrowLeft,
  Ban,
  Bell,
  BellOff,
  BookOpen,
  Camera,
  Check,
  CheckCheck,
  Compass,
  CornerUpLeft,
  Download,
  Film,
  Flag,
  Grid3X3,
  ImagePlus,
  Lock,
  MessageCircle,
  Mic,
  Moon,
  MoreVertical,
  PenLine,
  Pencil,
  Phone,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Smile,
  Sparkles,
  Square,
  Sun,
  Trash2,
  User as UserIcon,
  Users,
  Video,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Logo } from "@/components/Logo";
import { MediaSaveOptionsDialog } from "@/components/MediaSaveOptionsDialog";
import { ProtectedAudio, ProtectedImage, ProtectedVideo } from "@/components/ProtectedMedia";
import { CopyPersonalLinkButton, GoToReadingButton } from "@/components/SecretPageActions";
import { UserProfileModal } from "@/components/UserProfileModal";
import { WaterGlowButton } from "@/components/WaterGlowButton";
import {
  blockUser,
  deleteChatMessage,
  dismissFailedMessage,
  downloadProtectedMedia,
  editChatMessage,
  fetchGallery,
  fetchNfcLink,
  formatRelative,
  formatTime,
  initialsOf,
  initiateCall,
  loadConversations,
  loadOlderMessages,
  openThread,
  reactToMessage,
  retryChatMessage,
  searchThreadMessages,
  searchUsers,
  saveMediaToGallery,
  sendChatMessage,
  sendTyping,
  setSecretTheme,
  setSoundEnabled,
  unblockUser,
  updateConversationSettings,
  uploadChatMedia,
  useChat,
  type ChatMessage,
  type MediaKind,
  type PublicAccount,
} from "@/lib/chat-store";
import { stopVibration } from "@/lib/alerts";
import { compressImageFile } from "@/lib/media-compress";
import { requestFeatureMediaPermission } from "@/lib/permissions";
import { computeChatKeyboardLayout, type ChatKeyboardLayout } from "@/lib/chat-viewport";
import { resolveWaterButtonVariant, type SecretThemeTokens } from "@/lib/secret-themes";
import {
  dedupeConversationsByPeerId,
  dedupeMessagesById,
  dedupeUsersById,
  filterConversationsByTab,
  groupMessagesWithDateSeparators,
  isControlSearchTrigger,
  resolveChatEscapeAction,
  splitChatSidebarUsers,
  validateMediaFile,
  type GalleryScope,
} from "@/lib/social-logic";
import { cn } from "@/lib/utils";
import { playWaterSound } from "@/lib/water-sound";

const EMOJIS = [
  "😀",
  "😂",
  "🥰",
  "😍",
  "🤔",
  "👍",
  "🙌",
  "🔥",
  "✨",
  "📚",
  "☕",
  "🌙",
  "❤️",
  "🎉",
  "😭",
  "👀",
];

const QUICK_REACTIONS = ["❤️", "😂", "😮", "😢", "🙏", "👍"];

function UserAvatar({
  user,
  theme,
  size = "md",
}: {
  user: PublicAccount;
  theme: SecretThemeTokens;
  size?: "sm" | "md" | "lg";
}) {
  const dim = size === "lg" ? "size-12" : size === "sm" ? "size-9" : "size-11";
  return (
    <span className="relative inline-flex shrink-0">
      <span className={cn("rounded-full p-[2px]", theme.ringGradient)}>
        <span
          className={cn(
            "grid place-items-center overflow-hidden rounded-full font-display font-bold",
            theme.surface,
            dim,
            size === "sm" ? "text-xs" : "text-sm",
          )}
        >
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.fullName}
              referrerPolicy="no-referrer"
              className="size-full object-cover"
            />
          ) : (
            initialsOf(user.fullName)
          )}
        </span>
      </span>
      {user.online && (
        <span className="absolute bottom-0 right-0 size-3 rounded-full border-2 border-white bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.75)]" />
      )}
    </span>
  );
}

export function MediaLightbox({
  media,
  canDelete = false,
  onDelete,
  onClose,
}: {
  media: { id?: string; url: string; kind: "image" | "video"; name: string } | null;
  canDelete?: boolean;
  onDelete?: (() => Promise<void> | void) | undefined;
  onClose: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveOptionsOpen, setSaveOptionsOpen] = useState(false);

  useEffect(() => {
    setConfirmDelete(false);
    setDeleting(false);
  }, [media?.url]);

  useEffect(() => {
    if (!media) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [media, onClose]);

  if (!media) return null;

  return (
    <>
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white backdrop-blur-md"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex items-center justify-between gap-3 px-4 py-3"
          >
            <p className="truncate text-sm font-semibold">{media.name}</p>
            <div className="flex items-center gap-2">
              {canDelete &&
                onDelete &&
                (confirmDelete ? (
                  <div className="flex items-center gap-1.5 rounded-full bg-rose-950/90 px-2 py-1 ring-1 ring-rose-500/60">
                    <button
                      type="button"
                      disabled={deleting}
                      onClick={async () => {
                        setDeleting(true);
                        try {
                          await onDelete();
                          onClose();
                        } finally {
                          setDeleting(false);
                        }
                      }}
                      className="min-h-[32px] rounded-full bg-rose-600 px-3 text-xs font-bold text-white transition hover:bg-rose-500 disabled:opacity-50"
                    >
                      {deleting ? "Deleting…" : "Confirm Delete"}
                    </button>
                    <button
                      type="button"
                      disabled={deleting}
                      onClick={() => setConfirmDelete(false)}
                      className="min-h-[32px] rounded-full px-2.5 text-xs font-semibold text-white/80 hover:text-white"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    aria-label="Delete media"
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full bg-rose-600/85 px-3.5 py-2 text-xs font-bold text-white transition hover:bg-rose-600"
                  >
                    <Trash2 className="size-4" /> Delete
                  </button>
                ))}
              <button
                type="button"
                onClick={() => setSaveOptionsOpen(true)}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full bg-white/15 px-3.5 py-2 text-xs font-bold text-white transition hover:bg-white/25"
              >
                <Download className="size-4" /> Save
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close preview"
                className="grid size-10 place-items-center rounded-full bg-white/15 text-white transition hover:bg-white/25"
              >
                <X className="size-5" />
              </button>
            </div>
          </div>
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex flex-1 items-center justify-center overflow-hidden p-4"
          >
            {media.kind === "image" ? (
              <ProtectedImage
                src={media.url}
                alt={media.name}
                className="max-h-full max-w-full rounded-2xl object-contain"
              />
            ) : (
              <ProtectedVideo
                src={media.url}
                controls
                autoPlay
                playsInline
                className="max-h-full max-w-full rounded-2xl"
              />
            )}
          </div>
        </motion.div>
      </AnimatePresence>
      <MediaSaveOptionsDialog
        open={saveOptionsOpen}
        name={media.name}
        saveable={media.kind === "image" || media.kind === "video"}
        onOpenChange={setSaveOptionsOpen}
        onSaveToGallery={(scope) => saveMediaToGallery(media.url, scope)}
        onDownloadToPhone={() => downloadProtectedMedia(media.url, media.name)}
      />
    </>
  );
}

export function InstagramChatView({
  theme,
  onOpenProfile,
  onOpenDiscover,
  onThreadOpenChange,
}: {
  theme: SecretThemeTokens;
  onOpenProfile?: () => void;
  onOpenDiscover?: () => void;
  onThreadOpenChange?: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const {
    me,
    conversations,
    discoveredUsers,
    activePeerId,
    threads,
    hasOlderMessages,
    loadingOlderMessages,
    typingByPeer,
    gallery,
    soundEnabled,
    wsConnected,
  } = useChat();

  const [query, setQuery] = useState("");
  const [chatFilterTab, setChatFilterTab] = useState<"all" | "unread">("all");
  const [searchResults, setSearchResults] = useState<PublicAccount[]>([]);
  const [searching, setSearching] = useState(false);

  const [draft, setDraft] = useState("");
  const [pendingMedia, setPendingMedia] = useState<{
    id: string;
    url: string;
    kind: MediaKind;
    name: string;
  } | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [editingMsg, setEditingMsg] = useState<ChatMessage | null>(null);
  const [reactionPickerForId, setReactionPickerForId] = useState<string | null>(null);
  const [galleryPickerOpen, setGalleryPickerOpen] = useState(false);

  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [threadSearchResults, setThreadSearchResults] = useState<ChatMessage[] | null>(null);

  const [profileModalUser, setProfileModalUser] = useState<PublicAccount | null>(null);
  const [profileModalReportOpen, setProfileModalReportOpen] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [lightbox, setLightbox] = useState<{
    url: string;
    kind: "image" | "video";
    name: string;
  } | null>(null);
  const [saveOptions, setSaveOptions] = useState<{
    url: string;
    kind: MediaKind;
    name: string;
  } | null>(null);
  const [pendingImageGalleryPrompt, setPendingImageGalleryPrompt] = useState<{
    file: File;
    previewUrl: string;
    peerId: string;
    compressed: boolean;
  } | null>(null);

  // Mobile keyboard viewport tracking so input & chat text are NEVER covered or jittering
  const [keyboardLayout, setKeyboardLayout] = useState<ChatKeyboardLayout>({
    isKeyboardOpen: false,
    viewportHeightPx: null,
    viewportOffsetTopPx: 0,
  });
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const draftInputRef = useRef<HTMLTextAreaElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const shouldStickToLatestRef = useRef(true);
  const previousPeerIdRef = useRef<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    onThreadOpenChange?.(Boolean(activePeerId));
  }, [activePeerId, onThreadOpenChange]);

  useEffect(() => {
    const syncActiveThread = () => {
      if (document.visibilityState === "visible" && activePeerId) {
        void openThread(activePeerId, { markSeen: false }).catch(() => {});
      }
    };

    const intervalMs = wsConnected ? 15_000 : 2_500;
    const intervalId = window.setInterval(syncActiveThread, intervalMs);
    document.addEventListener("visibilitychange", syncActiveThread);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", syncActiveThread);
    };
  }, [activePeerId, wsConnected]);

  useEffect(() => {
    const syncConversations = () => {
      if (document.visibilityState === "visible") {
        void loadConversations().catch(() => {});
      }
    };

    const intervalMs = wsConnected ? 20_000 : 6_000;
    const intervalId = window.setInterval(syncConversations, intervalMs);
    document.addEventListener("visibilitychange", syncConversations);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", syncConversations);
    };
  }, [wsConnected]);

  useEffect(() => {
    setReplyingTo(null);
    setEditingMsg(null);
    setReactionPickerForId(null);
    setThreadSearchOpen(false);
    setThreadSearchQuery("");
    setThreadSearchResults(null);
    setMenuOpen(false);
    setEmojiOpen(false);
  }, [activePeerId]);

  useEffect(() => {
    if (!menuOpen && !reactionPickerForId) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (menuOpen && menuContainerRef.current && !menuContainerRef.current.contains(target)) {
        setMenuOpen(false);
      }
      if (
        reactionPickerForId &&
        !(target instanceof Element && target.closest("[data-reaction-picker]"))
      ) {
        setReactionPickerForId(null);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen, reactionPickerForId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const action = resolveChatEscapeAction({
        lightboxOpen: Boolean(lightbox),
        profileModalOpen: Boolean(profileModalUser),
        galleryPickerOpen,
        menuOpen,
        reactionPickerOpen: Boolean(reactionPickerForId),
        emojiOpen,
        threadSearchOpen,
        replyOrEditOpen: Boolean(replyingTo || editingMsg),
        hasActivePeer: Boolean(activePeerId),
      });
      if (!action) return;
      e.preventDefault();
      switch (action) {
        case "closeLightbox":
          setLightbox(null);
          break;
        case "closeProfileModal":
          setProfileModalUser(null);
          setProfileModalReportOpen(false);
          break;
        case "closeGalleryPicker":
          setGalleryPickerOpen(false);
          break;
        case "closeMenu":
          setMenuOpen(false);
          break;
        case "closeReactionPicker":
          setReactionPickerForId(null);
          break;
        case "closeEmoji":
          setEmojiOpen(false);
          break;
        case "closeThreadSearch":
          setThreadSearchOpen(false);
          setThreadSearchQuery("");
          setThreadSearchResults(null);
          break;
        case "cancelReplyOrEdit":
          setReplyingTo(null);
          if (editingMsg) {
            setEditingMsg(null);
            setDraft("");
          }
          break;
        case "closeThread":
          void openThread(null);
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    lightbox,
    profileModalUser,
    galleryPickerOpen,
    menuOpen,
    reactionPickerForId,
    emojiOpen,
    threadSearchOpen,
    replyingTo,
    editingMsg,
    activePeerId,
  ]);

  useEffect(() => {
    if (!recording) {
      setRecordSeconds(0);
      return;
    }
    const id = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [recording]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let rafId = 0;
    const syncViewport = () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        const isMobile = window.innerWidth < 768;
        setIsMobileViewport(isMobile);
        const vv = window.visualViewport;
        const next = computeChatKeyboardLayout({
          layoutHeight: window.innerHeight,
          visualHeight: vv ? vv.height : window.innerHeight,
          visualOffsetTop: vv ? vv.offsetTop : 0,
          isMobile,
          isComposerFocused,
        });
        setKeyboardLayout((prev) =>
          prev.isKeyboardOpen === next.isKeyboardOpen &&
          prev.viewportHeightPx === next.viewportHeightPx &&
          prev.viewportOffsetTopPx === next.viewportOffsetTopPx
            ? prev
            : next,
        );
      });
    };

    syncViewport();
    window.addEventListener("resize", syncViewport);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", syncViewport);
    vv?.addEventListener("scroll", syncViewport);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", syncViewport);
      vv?.removeEventListener("resize", syncViewport);
      vv?.removeEventListener("scroll", syncViewport);
    };
  }, [isComposerFocused]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = window.setTimeout(() => {
      searchUsers(trimmed)
        .then((users) => {
          if (!cancelled) setSearchResults(users);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query]);

  useEffect(() => {
    if (!activePeerId || !threadSearchOpen) {
      setThreadSearchResults(null);
      return;
    }
    const q = threadSearchQuery.trim();
    if (!q) {
      setThreadSearchResults(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      searchThreadMessages(activePeerId, q)
        .then((msgs) => {
          if (!cancelled) setThreadSearchResults(msgs);
        })
        .catch(() => {
          if (!cancelled) setThreadSearchResults([]);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [activePeerId, threadSearchOpen, threadSearchQuery]);

  const uniqueConversations = useMemo(
    () => dedupeConversationsByPeerId(conversations, me?.id),
    [conversations, me?.id],
  );
  const convPeerIds = useMemo(
    () => new Set(uniqueConversations.map((c) => c.peer.id)),
    [uniqueConversations],
  );
  const unreadTotal = useMemo(
    () => uniqueConversations.reduce((acc, c) => acc + c.unreadCount, 0),
    [uniqueConversations],
  );
  const filteredConversations = useMemo(
    () => filterConversationsByTab(uniqueConversations, chatFilterTab),
    [uniqueConversations, chatFilterTab],
  );
  const uniqueDiscoveredUsers = useMemo(
    () => dedupeUsersById(discoveredUsers, me?.id),
    [discoveredUsers, me?.id],
  );
  const directoryPeers = useMemo(
    () => splitChatSidebarUsers(uniqueDiscoveredUsers, convPeerIds),
    [uniqueDiscoveredUsers, convPeerIds],
  );

  const activeConv = useMemo(
    () => uniqueConversations.find((c) => c.peer.id === activePeerId) ?? null,
    [uniqueConversations, activePeerId],
  );
  const activePeer = useMemo(
    () =>
      activeConv?.peer ??
      (activePeerId ? (uniqueDiscoveredUsers.find((u) => u.id === activePeerId) ?? null) : null),
    [activeConv, activePeerId, uniqueDiscoveredUsers],
  );
  const activeMessages: ChatMessage[] = useMemo(
    () => (activePeerId ? dedupeMessagesById(threads[activePeerId] ?? []) : []),
    [activePeerId, threads],
  );

  const visibleMessages = useMemo(() => {
    if (threadSearchOpen && threadSearchQuery.trim() && threadSearchResults !== null) {
      return dedupeMessagesById(threadSearchResults);
    }
    return activeMessages;
  }, [activeMessages, threadSearchOpen, threadSearchQuery, threadSearchResults]);

  const timelineEntries = useMemo(
    () => groupMessagesWithDateSeparators(visibleMessages),
    [visibleMessages],
  );

  const lastSeenOutgoingId = useMemo(() => {
    if (!me) return null;
    for (let i = activeMessages.length - 1; i >= 0; i -= 1) {
      const m = activeMessages[i];
      if (m && m.from === me.id && m.seenAt && !m.deletedAt) return m.id;
    }
    return null;
  }, [activeMessages, me]);

  useEffect(() => {
    if (previousPeerIdRef.current !== activePeerId) {
      previousPeerIdRef.current = activePeerId;
      shouldStickToLatestRef.current = true;
    }

    if (!threadSearchQuery.trim() && shouldStickToLatestRef.current) {
      const container = messagesScrollRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      } else {
        endRef.current?.scrollIntoView({ block: "end" });
      }
    }
  }, [
    activeMessages.length,
    activePeerId,
    threadSearchQuery,
    keyboardLayout.isKeyboardOpen,
    keyboardLayout.viewportHeightPx,
  ]);

  function handleDraftChange(val: string) {
    setDraft(val);
    if (!activePeerId || activeConv?.blockedByMe || activeConv?.blockedMe || editingMsg) return;
    sendTyping(activePeerId, true);
    if (typingTimeoutRef.current) window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => {
      sendTyping(activePeerId, false);
    }, 1500);
  }

  useEffect(() => {
    return () => {
      if (pendingImageGalleryPrompt?.previewUrl) {
        URL.revokeObjectURL(pendingImageGalleryPrompt.previewUrl);
      }
    };
  }, [pendingImageGalleryPrompt]);

  function closeImageGalleryPrompt() {
    if (pendingImageGalleryPrompt?.previewUrl) {
      URL.revokeObjectURL(pendingImageGalleryPrompt.previewUrl);
    }
    setPendingImageGalleryPrompt(null);
  }

  async function confirmImageGalleryUpload(scope: GalleryScope) {
    if (!pendingImageGalleryPrompt) return;
    const { file, peerId } = pendingImageGalleryPrompt;
    closeImageGalleryPrompt();
    setUploading(true);
    try {
      const uploaded = await uploadChatMedia(file, peerId, scope);
      setPendingMedia({
        id: uploaded.id,
        url: uploaded.url,
        kind: uploaded.kind,
        name: uploaded.originalName || file.name,
      });
      toast.success(
        scope === "secret"
          ? "Ready to send · saved to Secret Gallery"
          : "Ready to send · saved to Normal Gallery",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not upload media.");
    } finally {
      setUploading(false);
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !activePeerId) return;

    const validation = validateMediaFile({ size: file.size, type: file.type, name: file.name });
    if (!validation.ok) {
      toast.error(validation.error);
      return;
    }

    if (validation.kind === "image") {
      try {
        let targetFile = file;
        let wasCompressed = false;
        try {
          const compressed = await compressImageFile(file);
          if (compressed) {
            targetFile = compressed;
            wasCompressed = compressed !== file;
          }
        } catch {
          // If compression fails, use original file cleanly
        }
        const previewUrl = URL.createObjectURL(targetFile);
        setPendingImageGalleryPrompt({
          file: targetFile,
          previewUrl,
          peerId: activePeerId,
          compressed: wasCompressed,
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not prepare photo.");
      }
      return;
    }

    setUploading(true);
    try {
      const uploaded = await uploadChatMedia(file, activePeerId, "normal");
      setPendingMedia({
        id: uploaded.id,
        url: uploaded.url,
        kind: uploaded.kind,
        name: uploaded.originalName || file.name,
      });
      toast.success(
        uploaded.kind === "video"
          ? "Video attached · Add a caption or tap send"
          : "Media attached · Ready to send",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not upload media.");
    } finally {
      setUploading(false);
    }
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    if (!activePeerId) return;
    try {
      const permission = await requestFeatureMediaPermission("microphone");
      if (permission !== "granted") {
        toast.info(
          permission === "denied"
            ? "Microphone access is blocked. Enable it in Android Settings → Apps → Chrome → Permissions, then retry."
            : "Voice recording was not started. You can allow microphone access the next time you record.",
        );
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (ev) => chunks.push(ev.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: "audio/webm" });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" });
        setUploading(true);
        try {
          const uploaded = await uploadChatMedia(file, activePeerId);
          setPendingMedia({
            id: uploaded.id,
            url: uploaded.url,
            kind: "audio",
            name: uploaded.originalName,
          });
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Voice upload failed.");
        } finally {
          setUploading(false);
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      toast.error("Microphone permission required to record a voice note.");
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!activePeerId || sending) return;
    const text = draft.trim();

    if (editingMsg) {
      if (!text) {
        toast.error("Edited message cannot be empty.");
        return;
      }
      setSending(true);
      try {
        await editChatMessage(editingMsg.id, text);
        setEditingMsg(null);
        setDraft("");
        setEmojiOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not edit message.");
      } finally {
        setSending(false);
      }
      return;
    }

    if (!text && !pendingMedia) return;

    setSending(true);
    shouldStickToLatestRef.current = true;
    try {
      await sendChatMessage(activePeerId, text, pendingMedia?.id ?? null, replyingTo?.id ?? null);
      playWaterSound("droplet", soundEnabled);
      setDraft("");
      setPendingMedia(null);
      setReplyingTo(null);
      setEmojiOpen(false);
      sendTyping(activePeerId, false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Message could not be sent.");
    } finally {
      setSending(false);
    }
  }

  async function handleLoadOlderMessages() {
    if (!activePeerId) return;
    const container = messagesScrollRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    const previousTop = container?.scrollTop ?? 0;
    await loadOlderMessages(activePeerId);
    requestAnimationFrame(() => {
      if (container) {
        container.scrollTop = container.scrollHeight - previousHeight + previousTop;
      }
    });
  }

  async function handleReact(msgId: string, emoji: string) {
    setReactionPickerForId(null);
    try {
      await reactToMessage(msgId, emoji);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add reaction.");
    }
  }

  async function handleDeleteMessage(msgId: string) {
    try {
      await deleteChatMessage(msgId);
      if (editingMsg?.id === msgId) {
        setEditingMsg(null);
        setDraft("");
      }
      if (replyingTo?.id === msgId) {
        setReplyingTo(null);
      }
      toast.success("Message deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete message.");
    }
  }

  async function handleTogglePin() {
    if (!activePeer || !activeConv) return;
    setMenuOpen(false);
    try {
      const res = await updateConversationSettings(activePeer.id, { pinned: !activeConv.pinned });
      toast.success(res.pinned ? "Conversation pinned" : "Conversation unpinned");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update pin.");
    }
  }

  async function handleToggleMute() {
    if (!activePeer || !activeConv) return;
    setMenuOpen(false);
    try {
      const res = await updateConversationSettings(activePeer.id, { muted: !activeConv.muted });
      toast.success(res.muted ? "Notifications muted" : "Notifications unmuted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update mute.");
    }
  }

  async function handleBlockToggle() {
    if (!activePeer) return;
    setMenuOpen(false);
    try {
      if (activeConv?.blockedByMe) {
        await unblockUser(activePeer.id);
        toast.success(`Unblocked ${activePeer.fullName}`);
      } else {
        await blockUser(activePeer.id);
        toast.success(`Blocked ${activePeer.fullName}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed.");
    }
  }

  async function handleStartCall(callType: "audio" | "video") {
    if (!activePeer) return;
    try {
      await initiateCall(activePeer, callType);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cannot initiate call.");
    }
  }

  function handleOpenGalleryPicker() {
    void fetchGallery();
    setGalleryPickerOpen(true);
  }

  function scrollToMessage(msgId: string) {
    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  if (!me) return null;

  const isBlocked = Boolean(activeConv?.blockedByMe || activeConv?.blockedMe);
  const formatRec = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const mobilePinnedStyle =
    activePeerId && isMobileViewport && keyboardLayout.viewportHeightPx
      ? {
          top: `${keyboardLayout.viewportOffsetTopPx}px`,
          height: `${keyboardLayout.viewportHeightPx}px`,
        }
      : undefined;

  return (
    <div className="flex min-h-0 w-full flex-1 overflow-hidden">
      {/* Left Conversation List (Specular Glass Recent Chats Container) */}
      <aside
        className={cn(
          "relative flex w-full flex-col md:w-80 md:border-r lg:w-96",
          theme.border,
          activePeer && "hidden md:flex",
        )}
      >
        {/* Top Frosted Studio Header */}
        <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3.5 md:pt-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={cn(
                "glass-sheen grid size-10 shrink-0 place-items-center rounded-full p-1.5 md:hidden",
                theme.accentBg,
              )}
            >
              <Logo className="size-6" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-display text-lg font-extrabold">{me.fullName}</p>
              <p className={cn("truncate text-[11px] font-medium", theme.mutedText)}>
                {me.displayHandle}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <motion.button
              whileTap={{ scale: 0.9 }}
              type="button"
              onClick={() => {
                playWaterSound("pop", !soundEnabled);
                setSoundEnabled(!soundEnabled);
              }}
              aria-label={soundEnabled ? "Mute water sounds" : "Enable water sounds"}
              title={soundEnabled ? "Sound on" : "Sound muted"}
              className={cn(
                "grid size-9 place-items-center rounded-full border transition",
                theme.glassPill,
              )}
            >
              {soundEnabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.9 }}
              type="button"
              onClick={() => {
                playWaterSound("pop", soundEnabled);
                void setSecretTheme(theme.isDark ? "instagram" : "dark");
              }}
              aria-label={theme.isDark ? "Switch to light mode" : "Switch to dark mode"}
              title={theme.isDark ? "Light mode" : "Dark mode"}
              className={cn(
                "grid size-9 place-items-center rounded-full border transition",
                theme.glassPill,
              )}
            >
              {theme.isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </motion.button>
            {onOpenDiscover && (
              <motion.button
                whileTap={{ scale: 0.94 }}
                type="button"
                onClick={onOpenDiscover}
                aria-label="Discover users"
                title="Discover users"
                className={cn(
                  "grid size-9 place-items-center rounded-full border transition",
                  theme.glassPill,
                )}
              >
                <Compass className="size-4" />
              </motion.button>
            )}
            <motion.button
              whileTap={{ scale: 0.94 }}
              type="button"
              onClick={() => searchInputRef.current?.focus()}
              aria-label="Search chats"
              className={cn(
                "grid size-9 place-items-center rounded-full border transition",
                theme.glassPill,
              )}
            >
              <Search className="size-4" />
            </motion.button>
            {onOpenProfile && (
              <motion.button
                whileTap={{ scale: 0.94 }}
                type="button"
                onClick={onOpenProfile}
                aria-label="Open profile"
                className={cn("rounded-full p-[2px] md:hidden", theme.ringGradient)}
              >
                <span
                  className={cn(
                    "grid size-8 place-items-center overflow-hidden rounded-full text-xs font-bold",
                    theme.surface,
                  )}
                >
                  {me.avatarUrl ? (
                    <img src={me.avatarUrl} alt={me.fullName} className="size-full object-cover" />
                  ) : (
                    initialsOf(me.fullName)
                  )}
                </span>
              </motion.button>
            )}
          </div>
        </div>

        {/* Elevated Translucent Glass Recent Chats Sheet */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          className={cn(
            "relative mx-2.5 mb-20 mt-1 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[30px] border md:mx-3 md:mb-3",
            theme.id === "emerald" ? "liquid-glass-panel" : theme.glassSheet,
          )}
        >
          {/* 3D Segmented All | Unread Tabs + Recessed Search */}
          <div className="space-y-2.5 p-3.5 pb-2.5">
            <div
              className={cn(
                "grid grid-cols-2 gap-1.5 rounded-full p-1",
                theme.isDark
                  ? "neu-inset-dark"
                  : theme.id === "emerald"
                    ? "liquid-glass-inset"
                    : "neu-inset-light",
              )}
            >
              {(
                [
                  { id: "all", label: "All" },
                  { id: "unread", label: "Unread" },
                ] as const
              ).map(({ id, label }) => {
                const active = chatFilterTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      playWaterSound("pop", soundEnabled);
                      setChatFilterTab(id);
                    }}
                    className={cn(
                      "relative flex min-h-[36px] items-center justify-center gap-1.5 rounded-full text-xs font-bold transition",
                      active ? theme.text : theme.mutedText,
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId="chatSidebarFilterTab"
                        transition={{ type: "spring", stiffness: 420, damping: 26 }}
                        className={cn(
                          "absolute inset-0 rounded-full",
                          theme.isDark
                            ? "neu-raised-dark"
                            : theme.id === "emerald"
                              ? "liquid-glass-iridescent border border-white/85"
                              : "neu-raised-light",
                        )}
                      />
                    )}
                    <span className="relative z-10">{label}</span>
                    {id === "unread" && unreadTotal > 0 && (
                      <span
                        className={cn(
                          "relative z-10 grid min-w-[18px] place-items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums",
                          theme.badgeBg,
                        )}
                      >
                        {unreadTotal > 99 ? "99+" : unreadTotal}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="relative">
              <Search
                className={cn(
                  "pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2",
                  theme.accentText,
                )}
              />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(e) => {
                  const val = e.target.value;
                  if (isControlSearchTrigger(val)) {
                    setQuery("");
                    navigate({ to: "/control" });
                    return;
                  }
                  setQuery(val);
                }}
                placeholder="Search by name or @username"
                className={cn(
                  "w-full rounded-full py-2.5 pl-11 pr-9 text-sm outline-none transition focus:ring-2 focus:ring-sky-400/40",
                  theme.isDark
                    ? "neu-inset-dark text-white"
                    : theme.id === "emerald"
                      ? "liquid-glass-inset text-[#1f1b38]"
                      : "neu-inset-light text-[#1e293b]",
                )}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 pb-24">
            {query.trim() ? (
              <div className="space-y-2">
                <p className={cn("px-2 py-1 text-xs font-bold", theme.mutedText)}>
                  {searching ? "Searching…" : "People"}
                </p>
                {dedupeUsersById(searchResults, me.id).map((u, idx) => (
                  <motion.button
                    key={u.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.03, duration: 0.2 }}
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.98 }}
                    type="button"
                    onClick={() => {
                      setQuery("");
                      void openThread(u.id);
                    }}
                    className={cn(
                      "flex min-h-[62px] w-full items-center gap-3 rounded-full border px-3 py-2 text-left transition",
                      theme.glassRow,
                    )}
                  >
                    <UserAvatar user={u} theme={theme} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold">{u.fullName}</span>
                      <span className={cn("block truncate text-xs", theme.mutedText)}>
                        {u.displayHandle}
                      </span>
                    </span>
                  </motion.button>
                ))}
                {!searching && searchResults.length === 0 && (
                  <p className={cn("px-4 py-8 text-center text-xs", theme.mutedText)}>
                    No matching reader found. Try Discover Readers to browse everyone.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 px-1.5 py-1">
                  <span
                    className={cn("inline-flex items-center gap-1.5 text-xs font-bold", theme.text)}
                  >
                    <Users className={cn("size-3.5", theme.accentText)} /> Messages
                  </span>
                  <div className="flex items-center gap-2">
                    <CopyPersonalLinkButton theme={theme} size="sm" label="Copy Link" />
                    {onOpenDiscover && (
                      <button
                        type="button"
                        onClick={onOpenDiscover}
                        aria-label="Start new chat"
                        className={cn(
                          "inline-flex items-center gap-1 text-xs font-bold hover:underline",
                          theme.accentText,
                        )}
                      >
                        <PenLine className="size-3.5" />
                        <span>New</span>
                      </button>
                    )}
                  </div>
                </div>
                {filteredConversations.map((c, idx) => {
                  const selected = c.peer.id === activePeerId;
                  const isTyping = typingByPeer[c.peer.id];
                  const preview = c.lastMessage?.deletedAt
                    ? "Message deleted"
                    : c.lastMessage?.text
                      ? c.lastMessage.text
                      : c.lastMessage?.mediaKind
                        ? `Sent a ${c.lastMessage.mediaKind}`
                        : "";
                  return (
                    <motion.button
                      key={c.peer.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0, scale: selected ? 1.01 : 1 }}
                      transition={{
                        delay: Math.min(idx * 0.04, 0.24),
                        duration: 0.24,
                        ease: [0.16, 1, 0.3, 1],
                      }}
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.97 }}
                      type="button"
                      onClick={() => {
                        playWaterSound("pop", soundEnabled);
                        void openThread(c.peer.id);
                      }}
                      className={cn(
                        "flex min-h-[66px] w-full items-center gap-3 rounded-[24px] border px-3 py-2.5 text-left transition",
                        selected ? theme.glassRowSelected : theme.glassRow,
                      )}
                    >
                      <UserAvatar user={c.peer} theme={theme} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-1.5">
                          <span className="flex min-w-0 items-center gap-1">
                            <span className="truncate text-sm font-bold">{c.peer.fullName}</span>
                            {c.pinned && (
                              <Pin
                                aria-label="Pinned"
                                className={cn("size-3 shrink-0", theme.accentText)}
                              />
                            )}
                            {c.muted && (
                              <BellOff
                                aria-label="Muted"
                                className={cn("size-3 shrink-0", theme.mutedText)}
                              />
                            )}
                          </span>
                          {c.lastMessage && (
                            <span
                              className={cn("shrink-0 text-[11px] tabular-nums", theme.mutedText)}
                            >
                              {formatRelative(c.lastMessage.createdAt)}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5">
                          <span
                            className={cn(
                              "truncate text-xs",
                              c.unreadCount > 0 ? "font-bold" : theme.mutedText,
                            )}
                          >
                            {c.blockedByMe
                              ? "Blocked"
                              : isTyping
                                ? "Typing…"
                                : c.lastMessage
                                  ? `${c.lastMessage.from === me.id ? "You: " : ""}${preview}`
                                  : c.peer.displayHandle}
                          </span>
                          {c.unreadCount > 0 && (
                            <span
                              className={cn(
                                "ml-auto grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-bold tabular-nums shadow-sm",
                                theme.badgeBg,
                              )}
                            >
                              {c.unreadCount}
                            </span>
                          )}
                        </span>
                      </span>
                    </motion.button>
                  );
                })}

                {chatFilterTab === "all" && directoryPeers.length > 0 && (
                  <div className={cn(conversations.length > 0 ? "pt-3" : "pt-1", "space-y-2")}>
                    <div className="flex items-center justify-between px-2 py-1">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 text-xs font-bold",
                          theme.text,
                        )}
                      >
                        <Compass className={cn("size-3.5", theme.accentText)} /> Registered Readers
                        <span className={cn("font-semibold tabular-nums", theme.mutedText)}>
                          ({directoryPeers.length})
                        </span>
                      </span>
                    </div>
                    {directoryPeers.map((u, idx) => (
                      <motion.button
                        key={u.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          delay: Math.min(idx * 0.03, 0.2),
                          duration: 0.22,
                          ease: [0.16, 1, 0.3, 1],
                        }}
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.98 }}
                        type="button"
                        onClick={() => void openThread(u.id)}
                        className={cn(
                          "flex min-h-[62px] w-full items-center gap-3 rounded-[26px] border px-3 py-2 text-left transition",
                          u.id === activePeerId ? theme.glassRowSelected : theme.glassRow,
                        )}
                      >
                        <UserAvatar user={u} theme={theme} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-1.5">
                            <span className="truncate text-sm font-bold">{u.fullName}</span>
                            <span
                              className={cn(
                                "shrink-0 text-[10px] font-bold",
                                u.online ? "text-emerald-500" : theme.mutedText,
                              )}
                            >
                              {u.online ? "Online" : formatRelative(u.lastActiveAt)}
                            </span>
                          </span>
                          <span className={cn("block truncate text-xs", theme.mutedText)}>
                            {u.displayHandle} · Tap to chat
                          </span>
                        </span>
                      </motion.button>
                    ))}
                  </div>
                )}

                {chatFilterTab === "unread" &&
                  filteredConversations.length === 0 &&
                  (conversations.length > 0 || directoryPeers.length > 0) && (
                    <div className="px-4 py-8 text-center">
                      <p className="text-xs font-bold">All caught up</p>
                      <p className={cn("mt-1 text-xs", theme.mutedText)}>
                        You have no unread messages right now.
                      </p>
                    </div>
                  )}

                {conversations.length === 0 && directoryPeers.length === 0 && (
                  <div className="px-5 py-12 text-center">
                    <MessageCircle className={cn("mx-auto size-10 opacity-40", theme.mutedText)} />
                    <p className="mt-3 text-sm font-bold">No other registered readers yet</p>
                    <p className={cn("mt-1 text-xs leading-relaxed", theme.mutedText)}>
                      As soon as another reader creates an account, they will appear here
                      automatically so you can start chatting.
                    </p>
                    {onOpenDiscover && (
                      <WaterGlowButton
                        type="button"
                        variant={resolveWaterButtonVariant(theme.id, "primary")}
                        size="sm"
                        soundEnabled={soundEnabled}
                        onClick={onOpenDiscover}
                        className="mt-4"
                      >
                        <Compass className="size-3.5" /> Discover Readers
                      </WaterGlowButton>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      </aside>

      {/* Right Active Thread Panel */}
      <section
        style={mobilePinnedStyle}
        className={cn(
          "flex min-w-0 flex-1 flex-col overflow-hidden",
          activePeerId &&
            isMobileViewport &&
            "fixed inset-x-0 z-30 md:static md:inset-auto md:z-auto",
          !activePeer && "hidden md:flex",
        )}
      >
        {activePeer ? (
          <>
            {/* Floating Frosted Glass Header Pill */}
            <motion.header
              initial={{ y: -12, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.22 }}
              className={cn(
                "relative mx-2.5 mt-2.5 flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-2 md:mx-4 md:mt-3",
                menuOpen ? "z-40" : "z-20",
                theme.glassPill,
              )}
            >
              <button
                type="button"
                onClick={() => void openThread(null)}
                aria-label="Back to chats"
                className={cn(
                  "grid size-10 shrink-0 place-items-center rounded-full md:hidden",
                  theme.surfaceMuted,
                )}
              >
                <ArrowLeft className="size-5" />
              </button>

              <button
                type="button"
                onClick={() => {
                  setProfileModalReportOpen(false);
                  setProfileModalUser(activePeer);
                }}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left transition hover:opacity-85"
              >
                <UserAvatar user={activePeer} theme={theme} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-sm font-bold">{activePeer.fullName}</p>
                    {activeConv?.pinned && (
                      <Pin className={cn("size-3 shrink-0", theme.accentText)} />
                    )}
                    {activeConv?.muted && (
                      <BellOff className={cn("size-3 shrink-0", theme.mutedText)} />
                    )}
                  </div>
                  <p
                    className={cn(
                      "flex items-center gap-1.5 truncate text-[11px]",
                      theme.mutedText,
                    )}
                  >
                    {activePeer.online && (
                      <span className="inline-block size-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]" />
                    )}
                    <span>
                      {typingByPeer[activePeer.id]
                        ? "Typing…"
                        : activePeer.online
                          ? "Online"
                          : `Active ${formatRelative(activePeer.lastActiveAt)} ago`}
                    </span>
                  </p>
                </div>
              </button>

              <motion.button
                whileTap={{ scale: 0.92 }}
                type="button"
                onClick={() => setThreadSearchOpen((o) => !o)}
                aria-label="Search messages in conversation"
                title="Search messages"
                className={cn(
                  "grid size-9 shrink-0 place-items-center rounded-full transition hover:opacity-85",
                  threadSearchOpen ? theme.accentBg : theme.surfaceMuted,
                )}
              >
                <Search className="size-4" />
              </motion.button>

              <motion.button
                whileTap={{ scale: 0.92 }}
                type="button"
                disabled={isBlocked}
                onClick={() => void handleStartCall("video")}
                aria-label="Video call"
                className={cn(
                  "grid size-9 shrink-0 place-items-center rounded-full transition hover:opacity-85 disabled:opacity-40",
                  theme.surfaceMuted,
                )}
              >
                <Video className="size-4" />
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.92 }}
                type="button"
                disabled={isBlocked}
                onClick={() => void handleStartCall("audio")}
                aria-label="Audio call"
                className={cn(
                  "grid size-9 shrink-0 place-items-center rounded-full transition hover:opacity-85 disabled:opacity-40",
                  theme.surfaceMuted,
                )}
              >
                <Phone className="size-4" />
              </motion.button>

              <GoToReadingButton size="sm" className="hidden md:inline-flex" />

              <div ref={menuContainerRef} className="relative">
                <button
                  type="button"
                  onClick={() => setMenuOpen((o) => !o)}
                  aria-label="Conversation options"
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  title="Conversation options"
                  className={cn(
                    "grid size-9 place-items-center rounded-full transition",
                    menuOpen ? theme.accentBg : theme.surfaceMuted,
                  )}
                >
                  <MoreVertical className="size-4" />
                </button>
                <AnimatePresence>
                  {menuOpen && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.94, y: -6 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.94, y: -6 }}
                      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                      role="menu"
                      aria-label="Conversation options"
                      className={cn(
                        "absolute right-0 top-11 z-50 max-h-[calc(100dvh-5rem)] w-56 overflow-y-auto rounded-2xl border p-1.5 shadow-2xl backdrop-blur-2xl",
                        theme.surfaceGlass,
                        theme.border,
                      )}
                    >
                      <div
                        className={cn(
                          "mb-1 flex items-center justify-between border-b px-2.5 pb-1.5 pt-1",
                          theme.border,
                        )}
                      >
                        <span
                          className={cn(
                            "text-[11px] font-bold uppercase tracking-wider",
                            theme.mutedText,
                          )}
                        >
                          Options
                        </span>
                        <button
                          type="button"
                          onClick={() => setMenuOpen(false)}
                          aria-label="Close options menu"
                          className={cn(
                            "grid size-7 place-items-center rounded-full transition hover:opacity-80",
                            theme.surfaceMuted,
                          )}
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          setProfileModalReportOpen(false);
                          setProfileModalUser(activePeer);
                        }}
                        className="flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-3 text-left text-xs font-bold transition hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        <UserIcon className="size-4" /> View profile
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={async () => {
                          setMenuOpen(false);
                          const link = await fetchNfcLink().catch(() => null);
                          if (!link?.path || link.revoked) {
                            toast.error("Personal link unavailable or revoked.");
                            return;
                          }
                          try {
                            await navigator.clipboard.writeText(
                              `${window.location.origin}${link.path}`,
                            );
                            toast.success("Personal link copied");
                          } catch {
                            toast.error("Open Profile → NFC Card to copy your link.");
                          }
                        }}
                        className="flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-3 text-left text-xs font-bold transition hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        <Sparkles className="size-4" /> Copy personal link
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => void handleTogglePin()}
                        className="flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-3 text-left text-xs font-bold transition hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        {activeConv?.pinned ? (
                          <>
                            <PinOff className="size-4" /> Unpin conversation
                          </>
                        ) : (
                          <>
                            <Pin className="size-4" /> Pin conversation
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => void handleToggleMute()}
                        className="flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-3 text-left text-xs font-bold transition hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        {activeConv?.muted ? (
                          <>
                            <Bell className="size-4" /> Unmute notifications
                          </>
                        ) : (
                          <>
                            <BellOff className="size-4" /> Mute notifications
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          setProfileModalReportOpen(true);
                          setProfileModalUser(activePeer);
                        }}
                        className="flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-3 text-left text-xs font-bold text-amber-500 transition hover:bg-amber-500/10"
                      >
                        <Flag className="size-4" /> Report user
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => void handleBlockToggle()}
                        className="flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-3 text-left text-xs font-bold text-rose-500 transition hover:bg-rose-500/10"
                      >
                        <Ban className="size-4" />
                        {activeConv?.blockedByMe ? "Unblock user" : "Block user"}
                      </button>
                      <div className={cn("mt-1 border-t pt-1", theme.border)}>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            void openThread(null);
                          }}
                          className="flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-3 text-left text-xs font-bold transition hover:bg-black/5 dark:hover:bg-white/5"
                        >
                          <ArrowLeft className="size-4" /> Back to chats
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.header>

            {/* In-Thread Search Bar */}
            {threadSearchOpen && (
              <div className="mx-2.5 mt-2 flex items-center gap-2 md:mx-4">
                <div className="relative flex-1">
                  <Search
                    className={cn(
                      "pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2",
                      theme.accentText,
                    )}
                  />
                  <input
                    autoFocus
                    value={threadSearchQuery}
                    onChange={(e) => setThreadSearchQuery(e.target.value)}
                    placeholder="Search messages in this chat…"
                    className={cn(
                      "w-full rounded-full border py-2 pl-10 pr-9 text-xs outline-none",
                      theme.glassPill,
                    )}
                  />
                  {threadSearchQuery && (
                    <button
                      type="button"
                      onClick={() => setThreadSearchQuery("")}
                      aria-label="Clear message search"
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setThreadSearchOpen(false);
                    setThreadSearchQuery("");
                    setThreadSearchResults(null);
                  }}
                  className={cn("rounded-full border px-3 py-2 text-xs font-bold", theme.glassPill)}
                >
                  Done
                </button>
              </div>
            )}

            {/* Atmospheric Study Band Behind Rising Curved Glass Conversation Sheet */}
            <div className="relative flex min-h-0 flex-1 flex-col pt-2 md:px-4 md:pt-4">
              {!keyboardLayout.isKeyboardOpen && (
                <div className="mx-3 mb-4 flex items-center justify-between gap-2 md:hidden">
                  <CopyPersonalLinkButton
                    theme={theme}
                    size="sm"
                    label="Copy Link"
                    className="min-h-[34px] px-3 text-[11px]"
                  />
                  <GoToReadingButton size="sm" className="min-h-[34px] px-3.5 text-[11px]" />
                </div>
              )}
              <div className="pointer-events-none mx-6 mb-4 hidden items-center justify-center gap-2 text-[11px] font-semibold opacity-65 md:flex">
                <BookOpen className="size-3.5" />
                <span>Real-time direct messages &amp; shared media</span>
                <Sparkles className="size-3.5" />
              </div>

              {/* Curved Specular Frosted Glass Messages Sheet */}
              <div
                className={cn(
                  "relative flex min-h-0 flex-1 flex-col rounded-t-[32px] border-x border-t md:rounded-[32px] md:border",
                  theme.glassSheet,
                )}
              >
                {threadSearchQuery.trim() && (
                  <div className="pointer-events-none absolute inset-x-0 -top-3.5 z-10 flex justify-center">
                    <span
                      className={cn(
                        "rounded-full border px-4 py-1 text-[11px] font-bold tracking-wide",
                        theme.glassPill,
                      )}
                    >
                      {`${visibleMessages.length} ${visibleMessages.length === 1 ? "match" : "matches"}`}
                    </span>
                  </div>
                )}

                <div
                  ref={messagesScrollRef}
                  onScroll={(event) => {
                    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
                    shouldStickToLatestRef.current = scrollHeight - scrollTop - clientHeight < 96;
                  }}
                  className="flex-1 space-y-3 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3.5 pb-4 pt-6 sm:px-5"
                >
                  {hasOlderMessages && (
                    <div className="flex justify-center pb-2">
                      <button
                        type="button"
                        onClick={() => void handleLoadOlderMessages()}
                        disabled={loadingOlderMessages}
                        aria-label={
                          loadingOlderMessages ? "Loading older messages" : "Load older messages"
                        }
                        className={cn(
                          "min-h-10 rounded-full px-4 text-xs font-semibold transition disabled:opacity-60",
                          theme.surfaceMuted,
                        )}
                      >
                        {loadingOlderMessages ? "Loading older messages…" : "Load older messages"}
                      </button>
                    </div>
                  )}
                  {timelineEntries.map((entry) => {
                    if (entry.type === "date") {
                      return (
                        <div key={entry.key} className="flex justify-center py-1.5">
                          <span
                            className={cn(
                              "rounded-full border px-3.5 py-1 text-[11px] font-bold tracking-wide",
                              theme.glassPill,
                            )}
                          >
                            {entry.label}
                          </span>
                        </div>
                      );
                    }
                    const m = entry.message;
                    const mine = m.from === me.id;
                    const isLastSeen = mine && m.id === lastSeenOutgoingId;
                    const isDeleted = Boolean(m.deletedAt);
                    const pickerOpen = reactionPickerForId === m.id;
                    const isSending = mine && m.localStatus === "sending";
                    const isFailed = mine && m.localStatus === "failed";
                    return (
                      <motion.div
                        id={`msg-${m.id}`}
                        key={m.id}
                        initial={{ opacity: 0, y: 10, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                        className="group space-y-1"
                      >
                        <div
                          className={cn(
                            "flex items-end gap-2",
                            mine ? "justify-end" : "justify-start",
                          )}
                        >
                          {!mine && <UserAvatar user={activePeer} theme={theme} size="sm" />}

                          {/* Quick action buttons on left for outgoing messages */}
                          {mine && !isDeleted && (
                            <div className="flex shrink-0 items-center gap-0.5 opacity-75 transition md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                              <button
                                type="button"
                                data-reaction-picker
                                onClick={() => setReactionPickerForId(pickerOpen ? null : m.id)}
                                aria-label="React to message"
                                className={cn(
                                  "grid size-7 place-items-center rounded-full transition hover:scale-110",
                                  theme.surfaceMuted,
                                )}
                              >
                                <Smile className="size-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingMsg(null);
                                  setReplyingTo(m);
                                  draftInputRef.current?.focus();
                                }}
                                aria-label="Reply to message"
                                className={cn(
                                  "grid size-7 place-items-center rounded-full transition hover:scale-110",
                                  theme.surfaceMuted,
                                )}
                              >
                                <CornerUpLeft className="size-3.5" />
                              </button>
                              {m.text && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setReplyingTo(null);
                                    setEditingMsg(m);
                                    setDraft(m.text);
                                    draftInputRef.current?.focus();
                                  }}
                                  aria-label="Edit message"
                                  className={cn(
                                    "grid size-7 place-items-center rounded-full transition hover:scale-110",
                                    theme.surfaceMuted,
                                  )}
                                >
                                  <Pencil className="size-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void handleDeleteMessage(m.id)}
                                aria-label="Delete message"
                                className={cn(
                                  "grid size-7 place-items-center rounded-full text-rose-500 transition hover:scale-110",
                                  theme.surfaceMuted,
                                )}
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </div>
                          )}

                          <div
                            className={cn(
                              "max-w-[78%] rounded-[22px] px-3.5 py-2.5 text-sm sm:max-w-[64%]",
                              mine ? "rounded-br-md" : "rounded-bl-md",
                              isDeleted
                                ? cn("border italic opacity-70", theme.border, theme.surfaceMuted)
                                : mine
                                  ? theme.myBubble
                                  : theme.peerBubble,
                            )}
                          >
                            {/* Reply quote snippet */}
                            {m.replyTo && !isDeleted && (
                              <button
                                type="button"
                                onClick={() => scrollToMessage(m.replyTo!.id)}
                                className="mb-2 block w-full rounded-xl border-l-2 border-current/60 bg-black/10 px-2.5 py-1.5 text-left text-xs dark:bg-white/10"
                              >
                                <p className="font-bold opacity-90">{m.replyTo.senderName}</p>
                                <p className="truncate opacity-80">
                                  {m.replyTo.deleted
                                    ? "Message deleted"
                                    : m.replyTo.text ||
                                      (m.replyTo.mediaKind
                                        ? `Shared ${m.replyTo.mediaKind}`
                                        : "Attachment")}
                                </p>
                              </button>
                            )}

                            {!isDeleted && m.mediaUrl && m.mediaKind === "image" && (
                              <div className="group/img relative mb-2 overflow-hidden rounded-2xl">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setLightbox({
                                      url: m.mediaUrl!,
                                      kind: "image",
                                      name: m.mediaName || "photo.jpg",
                                    })
                                  }
                                  className="block w-full"
                                >
                                  <ProtectedImage
                                    src={m.mediaUrl}
                                    alt={m.mediaName || "Shared photo"}
                                    className="max-h-64 w-full rounded-2xl object-cover"
                                  />
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setSaveOptions({
                                      url: m.mediaUrl!,
                                      kind: "image",
                                      name: m.mediaName || "photo.jpg",
                                    })
                                  }
                                  aria-label="Download photo"
                                  className="absolute bottom-2 right-2 grid size-9 place-items-center rounded-full bg-black/65 text-white backdrop-blur-sm transition hover:bg-black/85"
                                >
                                  <Download className="size-4" />
                                </button>
                              </div>
                            )}

                            {!isDeleted && m.mediaUrl && m.mediaKind === "video" && (
                              <div className="relative mb-2 overflow-hidden rounded-2xl bg-black">
                                <ProtectedVideo
                                  src={m.mediaUrl}
                                  controls
                                  playsInline
                                  className="max-h-64 w-full rounded-2xl object-cover"
                                />
                                <div className="flex items-center justify-between bg-black/75 px-3 py-1.5 text-[11px] text-white">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setLightbox({
                                        url: m.mediaUrl!,
                                        kind: "video",
                                        name: m.mediaName || "video.mp4",
                                      })
                                    }
                                    className="inline-flex items-center gap-1 font-semibold"
                                  >
                                    <Film className="size-3.5" /> Fullscreen
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setSaveOptions({
                                        url: m.mediaUrl!,
                                        kind: "video",
                                        name: m.mediaName || "video.mp4",
                                      })
                                    }
                                    className="inline-flex items-center gap-1 font-semibold"
                                  >
                                    <Download className="size-3.5" /> Download
                                  </button>
                                </div>
                              </div>
                            )}

                            {!isDeleted && m.mediaUrl && m.mediaKind === "audio" && (
                              <div className="mb-2 space-y-1.5">
                                <ProtectedAudio
                                  src={m.mediaUrl}
                                  controls
                                  className="w-52 max-w-full"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    setSaveOptions({
                                      url: m.mediaUrl!,
                                      kind: "audio",
                                      name: m.mediaName || "voice.webm",
                                    })
                                  }
                                  className="inline-flex items-center gap-1 text-[11px] font-semibold underline opacity-90"
                                >
                                  <Download className="size-3" /> Save audio
                                </button>
                              </div>
                            )}

                            {isDeleted ? (
                              <p className="text-xs">Message deleted</p>
                            ) : (
                              m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>
                            )}

                            <div className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-80 tabular-nums">
                              {m.editedAt && !isDeleted && <span>(edited)</span>}
                              <span>{isSending ? "Sending…" : formatTime(m.createdAt)}</span>
                              {mine &&
                                !isDeleted &&
                                !isSending &&
                                !isFailed &&
                                (m.seenAt ? (
                                  <CheckCheck className="size-3.5 text-sky-300" aria-label="Seen" />
                                ) : m.deliveredAt ? (
                                  <CheckCheck
                                    className="size-3.5 opacity-80"
                                    aria-label="Delivered"
                                  />
                                ) : (
                                  <Check className="size-3.5 opacity-70" aria-label="Sent" />
                                ))}
                            </div>

                            {isFailed && (
                              <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5 border-t border-rose-300/30 pt-1.5 text-[11px]">
                                <span className="inline-flex items-center gap-1 font-semibold text-rose-200">
                                  <AlertCircle className="size-3.5" /> Failed to send
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (!activePeerId) return;
                                    void retryChatMessage(activePeerId, m.id).catch((err) =>
                                      toast.error(
                                        err instanceof Error ? err.message : "Retry failed.",
                                      ),
                                    );
                                  }}
                                  className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-0.5 font-bold text-white hover:bg-white/30"
                                >
                                  <RefreshCw className="size-3" /> Retry
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    activePeerId && dismissFailedMessage(activePeerId, m.id)
                                  }
                                  className="rounded-full bg-black/25 px-2.5 py-0.5 font-semibold text-white/85 hover:bg-black/40"
                                >
                                  Discard
                                </button>
                              </div>
                            )}
                          </div>

                          {/* Quick action buttons on right for incoming messages */}
                          {!mine && !isDeleted && (
                            <div className="flex shrink-0 items-center gap-0.5 opacity-75 transition md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                              <button
                                type="button"
                                data-reaction-picker
                                onClick={() => setReactionPickerForId(pickerOpen ? null : m.id)}
                                aria-label="React to message"
                                className={cn(
                                  "grid size-7 place-items-center rounded-full transition hover:scale-110",
                                  theme.surfaceMuted,
                                )}
                              >
                                <Smile className="size-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingMsg(null);
                                  setReplyingTo(m);
                                  draftInputRef.current?.focus();
                                }}
                                aria-label="Reply to message"
                                className={cn(
                                  "grid size-7 place-items-center rounded-full transition hover:scale-110",
                                  theme.surfaceMuted,
                                )}
                              >
                                <CornerUpLeft className="size-3.5" />
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Quick emoji reaction popover */}
                        {pickerOpen && !isDeleted && (
                          <div
                            data-reaction-picker
                            className={cn(
                              "flex",
                              mine ? "justify-end pr-2" : "justify-start pl-11",
                            )}
                          >
                            <div
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2 py-1 shadow-lg backdrop-blur-xl",
                                theme.glassPill,
                              )}
                            >
                              {QUICK_REACTIONS.map((emoji) => (
                                <button
                                  key={emoji}
                                  type="button"
                                  onClick={() => void handleReact(m.id, emoji)}
                                  className="rounded-full p-1 text-base transition hover:scale-125"
                                >
                                  {emoji}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Existing reaction pills */}
                        {m.reactions && m.reactions.length > 0 && !isDeleted && (
                          <div
                            className={cn(
                              "flex flex-wrap gap-1",
                              mine ? "justify-end pr-1" : "justify-start pl-11",
                            )}
                          >
                            {m.reactions.map((r) => (
                              <button
                                key={r.emoji}
                                type="button"
                                onClick={() => void handleReact(m.id, r.emoji)}
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold transition hover:scale-105",
                                  r.reactedByMe ? theme.accentBg : cn(theme.glassPill),
                                )}
                              >
                                <span>{r.emoji}</span>
                                <span className="tabular-nums">{r.count}</span>
                              </button>
                            ))}
                          </div>
                        )}

                        {isLastSeen && (
                          <p
                            className={cn(
                              "pr-1 text-right text-[10px] font-semibold",
                              theme.mutedText,
                            )}
                          >
                            Seen
                          </p>
                        )}
                      </motion.div>
                    );
                  })}

                  {threadSearchQuery.trim() && visibleMessages.length === 0 && (
                    <p className={cn("py-10 text-center text-xs", theme.mutedText)}>
                      No messages matched &ldquo;{threadSearchQuery.trim()}&rdquo;.
                    </p>
                  )}

                  <div ref={endRef} />
                </div>

                {/* Blocked Banner or Keyboard-Safe Frosted Pill Composer */}
                {isBlocked ? (
                  <div
                    className={cn(
                      "mx-2.5 mb-2.5 shrink-0 rounded-3xl border px-4 py-3.5 text-center",
                      theme.glassPill,
                    )}
                  >
                    <div className="flex items-center justify-center gap-2 text-xs font-bold text-rose-500">
                      <ShieldAlert className="size-4" />
                      <span>
                        {activeConv?.blockedByMe
                          ? `You blocked ${activePeer.fullName}. Unblock to message or call.`
                          : "You cannot message or call this user."}
                      </span>
                    </div>
                    {activeConv?.blockedByMe && (
                      <button
                        type="button"
                        onClick={() => void handleBlockToggle()}
                        className={cn(
                          "mt-2.5 rounded-full px-4 py-2 text-xs font-bold",
                          theme.accentBg,
                        )}
                      >
                        Unblock {activePeer.fullName}
                      </button>
                    )}
                  </div>
                ) : (
                  <div
                    className={cn(
                      "mx-2.5 mb-[max(0.5rem,env(safe-area-inset-bottom))] shrink-0 overflow-hidden rounded-[28px] border md:mx-3 md:mb-3",
                      theme.glassPill,
                    )}
                  >
                    {/* Reply or Editing preview banner */}
                    {(replyingTo || editingMsg) && (
                      <div
                        className={cn(
                          "flex items-center justify-between gap-2 border-b px-4 py-2 text-xs",
                          theme.border,
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <p className={cn("font-bold", theme.accentText)}>
                            {editingMsg
                              ? "Editing message"
                              : `Replying to ${replyingTo?.from === me.id ? "yourself" : activePeer.fullName}`}
                          </p>
                          <p className={cn("truncate", theme.mutedText)}>
                            {editingMsg
                              ? editingMsg.text
                              : replyingTo?.text ||
                                (replyingTo?.mediaKind
                                  ? `Shared ${replyingTo.mediaKind}`
                                  : "Attachment")}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setReplyingTo(null);
                            if (editingMsg) {
                              setEditingMsg(null);
                              setDraft("");
                            }
                          }}
                          aria-label="Cancel reply or edit"
                          className="grid size-7 shrink-0 place-items-center rounded-full"
                        >
                          <X className="size-4" />
                        </button>
                      </div>
                    )}

                    {emojiOpen && (
                      <div
                        className={cn("grid grid-cols-8 gap-1 border-b px-3 py-2", theme.border)}
                      >
                        {EMOJIS.map((em) => (
                          <button
                            key={em}
                            type="button"
                            onClick={() => setDraft((d) => d + em)}
                            className="rounded-xl py-1.5 text-lg transition hover:scale-110"
                          >
                            {em}
                          </button>
                        ))}
                      </div>
                    )}

                    {pendingMedia && (
                      <div
                        className={cn("flex items-center gap-3 border-b px-3.5 py-2", theme.border)}
                      >
                        {pendingMedia.kind === "image" ? (
                          <ProtectedImage
                            src={pendingMedia.url}
                            alt="Ready to send"
                            className="size-12 rounded-xl object-cover"
                          />
                        ) : pendingMedia.kind === "video" ? (
                          <ProtectedVideo
                            src={pendingMedia.url}
                            className="size-12 rounded-xl object-cover"
                          />
                        ) : (
                          <span
                            className={cn(
                              "grid size-12 place-items-center rounded-xl",
                              theme.surfaceMuted,
                            )}
                          >
                            <Mic className="size-5" />
                          </span>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold">{pendingMedia.name}</p>
                          <p className={cn("text-[11px]", theme.mutedText)}>Ready to send</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setPendingMedia(null)}
                          aria-label="Remove attachment"
                          className="grid size-8 place-items-center rounded-full"
                        >
                          <X className="size-4" />
                        </button>
                      </div>
                    )}

                    <form
                      onSubmit={handleSend}
                      className="flex flex-wrap items-end gap-1.5 px-2.5 py-2 sm:flex-nowrap"
                    >
                      <div className="order-2 flex w-full items-center gap-1.5 pt-0.5 sm:order-none sm:w-auto sm:pt-0">
                        {!editingMsg && (
                          <>
                            <button
                              type="button"
                              disabled={uploading}
                              onClick={() => cameraRef.current?.click()}
                              aria-label="Open camera"
                              title="Camera"
                              className={cn(
                                "grid size-8 shrink-0 place-items-center rounded-full transition hover:scale-105 disabled:opacity-50 sm:size-10",
                                theme.surfaceMuted,
                              )}
                            >
                              <Camera className="size-4 sm:size-5" />
                            </button>
                            <button
                              type="button"
                              disabled={uploading}
                              onClick={() => fileRef.current?.click()}
                              aria-label="Attach photo or video"
                              title="Photo or Video"
                              className={cn(
                                "grid size-8 shrink-0 place-items-center rounded-full transition hover:scale-105 disabled:opacity-50 sm:size-10",
                                theme.surfaceMuted,
                              )}
                            >
                              <ImagePlus className="size-4 sm:size-5" />
                            </button>
                            <button
                              type="button"
                              disabled={uploading}
                              onClick={handleOpenGalleryPicker}
                              aria-label="Share from gallery"
                              title="Share from Gallery"
                              className={cn(
                                "grid size-8 shrink-0 place-items-center rounded-full transition hover:scale-105 disabled:opacity-50 sm:size-10",
                                theme.surfaceMuted,
                              )}
                            >
                              <Grid3X3 className="size-4" />
                            </button>
                            <button
                              type="button"
                              disabled={uploading}
                              onClick={() => void toggleRecording()}
                              aria-label={recording ? "Stop recording" : "Voice note"}
                              title={recording ? "Stop recording" : "Voice note"}
                              className={cn(
                                "grid size-8 shrink-0 place-items-center rounded-full transition hover:scale-105 sm:size-10",
                                recording ? "bg-rose-600 text-white" : theme.surfaceMuted,
                              )}
                            >
                              {recording ? (
                                <Square className="size-3.5 sm:size-4" />
                              ) : (
                                <Mic className="size-4 sm:size-5" />
                              )}
                            </button>
                          </>
                        )}

                        <button
                          type="button"
                          onClick={() => setEmojiOpen((s) => !s)}
                          aria-label="Emoji"
                          className={cn(
                            "grid size-8 shrink-0 place-items-center rounded-full transition hover:scale-105 sm:size-10",
                            theme.surfaceMuted,
                          )}
                        >
                          <Smile className="size-4 sm:size-5" />
                        </button>
                      </div>

                      <input
                        ref={cameraRef}
                        type="file"
                        accept="image/*,video/*"
                        capture="environment"
                        onChange={(e) => void handleFileSelect(e)}
                        className="hidden"
                      />
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*,video/*"
                        onChange={(e) => void handleFileSelect(e)}
                        className="hidden"
                      />

                      <div className="order-1 flex w-full items-end gap-2 sm:order-none sm:w-auto sm:flex-1">
                        <textarea
                          ref={draftInputRef}
                          data-chat-composer="true"
                          value={draft}
                          onChange={(e) => {
                            handleDraftChange(e.target.value);
                            e.currentTarget.style.height = "auto";
                            e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 112)}px`;
                          }}
                          onPointerDown={() => {
                            stopVibration();
                          }}
                          onFocus={() => {
                            stopVibration();
                            setIsComposerFocused(true);
                          }}
                          onBlur={() => {
                            setIsComposerFocused(false);
                          }}
                          onKeyDown={(e) => {
                            if (
                              e.key === "Enter" &&
                              !e.shiftKey &&
                              !e.nativeEvent.isComposing &&
                              e.keyCode !== 229
                            ) {
                              e.preventDefault();
                              void handleSend(e);
                            }
                          }}
                          rows={1}
                          placeholder={
                            recording
                              ? `Recording voice note (${formatRec(recordSeconds)})…`
                              : uploading
                                ? "Uploading media…"
                                : editingMsg
                                  ? "Edit message…"
                                  : "Message…"
                          }
                          className={cn(
                            "max-h-28 min-h-[42px] flex-1 resize-none rounded-[22px] border px-4 py-2.5 text-base outline-none sm:rounded-full sm:text-sm",
                            theme.border,
                            theme.surfaceMuted,
                          )}
                        />
                        <WaterGlowButton
                          type="submit"
                          variant={resolveWaterButtonVariant(theme.id, "primary")}
                          size="icon"
                          sound="droplet"
                          soundEnabled={soundEnabled}
                          disabled={
                            sending || uploading || (!draft.trim() && !pendingMedia && !editingMsg)
                          }
                          aria-label={editingMsg ? "Save edited message" : "Send message"}
                          className="size-10 shrink-0"
                        >
                          {editingMsg ? <Check className="size-4" /> : <Send className="size-4" />}
                        </WaterGlowButton>
                      </div>
                    </form>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="hidden flex-1 flex-col items-center justify-center p-10 text-center md:flex">
            <motion.div
              animate={{ y: [0, -6, 0] }}
              transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
              className={cn(
                "glass-sheen grid size-16 place-items-center rounded-full",
                theme.accentBg,
              )}
            >
              <MessageCircle className="size-7" />
            </motion.div>
            <p className="mt-4 font-display text-xl font-bold">Your Messages</p>
            <p className={cn("mt-1.5 max-w-xs text-sm", theme.mutedText)}>
              Select a reader from the left sidebar or pick one below to message in real time.
            </p>
            {uniqueDiscoveredUsers.length > 0 && (
              <div className="mt-4 flex max-w-md flex-wrap justify-center gap-2">
                {uniqueDiscoveredUsers.slice(0, 6).map((u) => (
                  <WaterGlowButton
                    key={u.id}
                    type="button"
                    variant={resolveWaterButtonVariant(theme.id, "surface")}
                    size="sm"
                    sound="pop"
                    soundEnabled={soundEnabled}
                    onClick={() => void openThread(u.id)}
                  >
                    <span className="max-w-[140px] truncate">{u.fullName}</span>
                    {u.online && <span className="size-2 rounded-full bg-emerald-500" />}
                  </WaterGlowButton>
                ))}
              </div>
            )}
            {onOpenDiscover && (
              <WaterGlowButton
                type="button"
                variant={resolveWaterButtonVariant(theme.id, "primary")}
                size="md"
                sound="droplet"
                soundEnabled={soundEnabled}
                onClick={onOpenDiscover}
                className="mt-4"
              >
                <Compass className="size-4" /> Discover Users
              </WaterGlowButton>
            )}
          </div>
        )}
      </section>

      {/* Share from Private Gallery Modal */}
      <AnimatePresence>
        {galleryPickerOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setGalleryPickerOpen(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.94, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-[28px] border p-5 backdrop-blur-2xl",
                theme.surfaceGlass,
                theme.border,
              )}
            >
              <div className="flex items-center justify-between gap-2 pb-3">
                <div>
                  <h3 className="font-display text-base font-extrabold">Share from Gallery</h3>
                  <p className={cn("text-xs", theme.mutedText)}>
                    Pick an existing photo or video to attach
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setGalleryPickerOpen(false)}
                  aria-label="Close gallery picker"
                  className={cn("grid size-8 place-items-center rounded-full", theme.surfaceMuted)}
                >
                  <X className="size-4" />
                </button>
              </div>
              {gallery.length > 0 ? (
                <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto pr-1">
                  {gallery.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setPendingMedia({
                          id: item.id,
                          url: item.url,
                          kind: item.kind,
                          name: item.originalName,
                        });
                        setGalleryPickerOpen(false);
                      }}
                      className="group relative aspect-square overflow-hidden rounded-xl bg-black/10"
                    >
                      {item.kind === "image" ? (
                        <ProtectedImage
                          src={item.url}
                          alt={item.originalName}
                          className="size-full object-cover transition group-hover:scale-105"
                        />
                      ) : (
                        <>
                          <ProtectedVideo src={item.url} className="size-full object-cover" />
                          <span className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/70 text-white">
                            <Film className="size-3" />
                          </span>
                        </>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <div className={cn("rounded-2xl p-6 text-center text-xs", theme.surfaceMuted)}>
                  Your gallery has no photos or videos yet. Upload one using the photo button.
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <UserProfileModal
        user={profileModalUser}
        theme={theme}
        initialReportOpen={profileModalReportOpen}
        onClose={() => {
          setProfileModalUser(null);
          setProfileModalReportOpen(false);
        }}
        onStartMessage={(userId) => void openThread(userId)}
      />

      {/* Prompt user when sending a photo: 1. Secret Gallery vs 2. Normal Gallery */}
      <AnimatePresence>
        {pendingImageGalleryPrompt && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeImageGalleryPrompt}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.94, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label="Choose gallery destination for photo"
              className={cn(
                "w-full max-w-sm space-y-4 rounded-[28px] border p-5 backdrop-blur-2xl",
                theme.surfaceGlass,
                theme.border,
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-display text-base font-extrabold">Save photo to gallery</h3>
                  <p className={cn("mt-0.5 text-xs", theme.mutedText)}>
                    Choose where this photo is organized before sending.
                    {pendingImageGalleryPrompt.compressed
                      ? " Compressed for fast mobile delivery."
                      : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeImageGalleryPrompt}
                  aria-label="Cancel photo upload"
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-full",
                    theme.surfaceMuted,
                  )}
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="overflow-hidden rounded-2xl bg-black/15">
                <img
                  src={pendingImageGalleryPrompt.previewUrl}
                  alt={pendingImageGalleryPrompt.file.name}
                  className="max-h-52 w-full object-contain"
                />
              </div>

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => void confirmImageGalleryUpload("secret")}
                  className={cn(
                    "flex min-h-[46px] w-full items-center gap-2.5 rounded-2xl border px-4 text-left text-xs font-bold transition hover:scale-[1.01]",
                    theme.glassRow,
                  )}
                >
                  <Lock className="size-4 shrink-0 text-amber-500" />
                  <span className="flex-1">
                    <span className="block">1. Secret Gallery</span>
                    <span className={cn("block text-[11px] font-normal", theme.mutedText)}>
                      Saved under your Secret Gallery filter
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void confirmImageGalleryUpload("normal")}
                  className={cn(
                    "flex min-h-[46px] w-full items-center gap-2.5 rounded-2xl px-4 text-left text-xs font-bold shadow-sm transition hover:scale-[1.01]",
                    theme.accentBg,
                  )}
                >
                  <Grid3X3 className="size-4 shrink-0" />
                  <span className="flex-1">
                    <span className="block">2. Normal Gallery</span>
                    <span className="block text-[11px] font-normal opacity-85">
                      Saved under your standard personal gallery
                    </span>
                  </span>
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <MediaLightbox media={lightbox} onClose={() => setLightbox(null)} />
      <MediaSaveOptionsDialog
        open={Boolean(saveOptions)}
        name={saveOptions?.name ?? "media"}
        saveable={saveOptions?.kind === "image" || saveOptions?.kind === "video"}
        onOpenChange={(open) => !open && setSaveOptions(null)}
        onSaveToGallery={(scope) => saveMediaToGallery(saveOptions?.url ?? "", scope)}
        onDownloadToPhone={() =>
          downloadProtectedMedia(saveOptions?.url ?? "", saveOptions?.name ?? "media")
        }
      />
    </div>
  );
}
