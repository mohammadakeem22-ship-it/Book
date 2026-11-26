import { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";

import { cn } from "@/lib/utils";

let sharedAudioCtx: AudioContext | null = null;

/**
 * Unlock audio output on Android Chrome / iOS Safari synchronously inside a user tap
 * before async getUserMedia or WebRTC signaling resolves.
 */
export function warmUpCallAudio() {
  if (typeof window === "undefined") return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!sharedAudioCtx) {
      sharedAudioCtx = new AudioCtx();
    }
    if (sharedAudioCtx.state === "suspended") {
      void sharedAudioCtx.resume().catch(() => {});
    }
    const buf = sharedAudioCtx.createBuffer(1, 1, 22050);
    const src = sharedAudioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(sharedAudioCtx.destination);
    src.start(0);
  } catch {
    // Non-fatal if browser denies audio context initialization
  }
}

export function RemoteCallAudio({
  stream,
  streamVersion = 0,
  speakerOn = true,
}: {
  stream: MediaStream | null;
  streamVersion?: number;
  speakerOn?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const attachedTrackKeyRef = useRef<string>("");
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    if (!stream) {
      attachedTrackKeyRef.current = "";
      el.srcObject = null;
      setAutoplayBlocked(false);
      return;
    }

    const audioTracks = stream.getAudioTracks().filter((t) => t.readyState !== "ended");
    if (audioTracks.length === 0) {
      attachedTrackKeyRef.current = "";
      el.srcObject = null;
      return;
    }

    const trackKey = audioTracks
      .map((t) => t.id)
      .sort()
      .join(",");
    if (attachedTrackKeyRef.current !== trackKey) {
      attachedTrackKeyRef.current = trackKey;
      el.srcObject = new MediaStream(audioTracks);
    }

    el.muted = !speakerOn;
    el.volume = speakerOn ? 1 : 0;

    const tryPlay = () => {
      warmUpCallAudio();
      void el
        .play()
        .then(() => {
          setAutoplayBlocked(false);
        })
        .catch(() => {
          setAutoplayBlocked(true);
        });
    };

    tryPlay();

    const onAddOrUnmute = () => tryPlay();
    audioTracks.forEach((t) => t.addEventListener("unmute", onAddOrUnmute));

    return () => {
      audioTracks.forEach((t) => t.removeEventListener("unmute", onAddOrUnmute));
    };
  }, [stream, streamVersion, speakerOn]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = !speakerOn;
    el.volume = speakerOn ? 1 : 0;
    if (speakerOn && el.srcObject && el.paused) {
      void el.play().catch(() => setAutoplayBlocked(true));
    }
  }, [speakerOn]);

  useEffect(() => {
    const el = audioRef.current;
    return () => {
      if (el) {
        el.srcObject = null;
      }
      attachedTrackKeyRef.current = "";
    };
  }, []);

  const resumeAudio = () => {
    const el = audioRef.current;
    if (!el || !speakerOn || !el.srcObject) return;
    el.muted = false;
    el.volume = 1;
    void el
      .play()
      .then(() => setAutoplayBlocked(false))
      .catch(() => setAutoplayBlocked(true));
  };

  return (
    <>
      <audio
        ref={audioRef}
        aria-label="Remote call audio"
        className="sr-only pointer-events-none"
        autoPlay
        playsInline
        onLoadedMetadata={resumeAudio}
        onCanPlay={resumeAudio}
        onPlaying={() => setAutoplayBlocked(false)}
      />
      {autoplayBlocked && stream && stream.getAudioTracks().length > 0 && (
        <button
          type="button"
          onClick={() => {
            warmUpCallAudio();
            const el = audioRef.current;
            if (!el) return;
            el.muted = !speakerOn;
            el.volume = speakerOn ? 1 : 0;
            void el
              .play()
              .then(() => setAutoplayBlocked(false))
              .catch(() => setAutoplayBlocked(true));
          }}
          className="fixed left-1/2 top-20 z-[90] inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-amber-500 px-4 py-2 text-xs font-extrabold text-zinc-950 shadow-2xl transition hover:bg-amber-400"
        >
          <Volume2 className="size-4" />
          <span>Tap to enable call audio</span>
        </button>
      )}
    </>
  );
}

export function RemoteCallVideo({
  stream,
  streamVersion = 0,
  remoteCameraEnabled = true,
  className,
  onHasVideoChange,
}: {
  stream: MediaStream | null;
  streamVersion?: number;
  remoteCameraEnabled?: boolean;
  className?: string;
  onHasVideoChange?: (hasVideo: boolean) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const attachedTrackKeyRef = useRef<string>("");
  const [hasLiveVideo, setHasLiveVideo] = useState(false);

  const hasVideoTrack = Boolean(
    stream &&
    remoteCameraEnabled !== false &&
    stream.getVideoTracks().some((t) => t.readyState !== "ended"),
  );

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !stream || remoteCameraEnabled === false) {
      if (el && !stream) {
        attachedTrackKeyRef.current = "";
        el.srcObject = null;
      }
      setHasLiveVideo(false);
      onHasVideoChange?.(false);
      return;
    }

    const videoTracks = stream.getVideoTracks().filter((t) => t.readyState !== "ended");
    if (videoTracks.length === 0) {
      attachedTrackKeyRef.current = "";
      el.srcObject = null;
      setHasLiveVideo(false);
      onHasVideoChange?.(false);
      return;
    }

    const trackKey = videoTracks
      .map((t) => t.id)
      .sort()
      .join(",");
    if (attachedTrackKeyRef.current !== trackKey) {
      attachedTrackKeyRef.current = trackKey;
      el.srcObject = new MediaStream(videoTracks);
    }

    el.muted = true;
    let pollTimer: number | null = null;

    const syncState = () => {
      const trackActive = videoTracks.some((t) => t.readyState === "live" && t.enabled);
      const hasFrames = el.videoWidth > 0 || el.readyState >= 2;
      const active = trackActive && (hasFrames || !videoTracks.every((t) => t.muted));
      setHasLiveVideo(active);
      onHasVideoChange?.(active);
      if (active && pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const ensurePlay = () => {
      void el.play().catch(() => {});
      syncState();
    };
    ensurePlay();

    pollTimer = window.setInterval(() => {
      if (el.paused) {
        void el.play().catch(() => {});
      }
      syncState();
    }, 300);

    videoTracks.forEach((t) => {
      t.addEventListener("unmute", ensurePlay);
      t.addEventListener("mute", syncState);
      t.addEventListener("ended", syncState);
    });

    return () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
      }
      videoTracks.forEach((t) => {
        t.removeEventListener("unmute", ensurePlay);
        t.removeEventListener("mute", syncState);
        t.removeEventListener("ended", syncState);
      });
    };
  }, [stream, streamVersion, remoteCameraEnabled, onHasVideoChange]);

  useEffect(() => {
    const el = videoRef.current;
    return () => {
      if (el) el.srcObject = null;
      attachedTrackKeyRef.current = "";
    };
  }, []);

  return (
    <video
      ref={videoRef}
      aria-label="Remote video"
      playsInline
      autoPlay
      muted
      onLoadedMetadata={() => {
        const el = videoRef.current;
        if (el) void el.play().catch(() => {});
      }}
      onCanPlay={() => {
        const el = videoRef.current;
        if (el) void el.play().catch(() => {});
        if (remoteCameraEnabled !== false) {
          setHasLiveVideo(true);
          onHasVideoChange?.(true);
        }
      }}
      onLoadedData={() => {
        if (remoteCameraEnabled !== false) {
          setHasLiveVideo(true);
          onHasVideoChange?.(true);
        }
      }}
      onPlaying={() => {
        if (remoteCameraEnabled !== false) {
          setHasLiveVideo(true);
          onHasVideoChange?.(true);
        }
      }}
      onResize={() => {
        const el = videoRef.current;
        if (el && el.videoWidth > 0 && remoteCameraEnabled !== false) {
          setHasLiveVideo(true);
          onHasVideoChange?.(true);
        }
      }}
      className={cn(
        "size-full bg-black object-contain md:object-cover transition-opacity duration-300",
        hasLiveVideo && remoteCameraEnabled !== false
          ? "opacity-100"
          : hasVideoTrack
            ? "opacity-[0.01] pointer-events-none"
            : "opacity-0 pointer-events-none",
        className,
      )}
    />
  );
}

export function LocalCallPreview({
  stream,
  streamVersion = 0,
  cameraEnabled = true,
  facingMode = "user",
  className,
}: {
  stream: MediaStream | null;
  streamVersion?: number;
  cameraEnabled?: boolean;
  facingMode?: "user" | "environment";
  className?: string;
}) {
  const localRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = localRef.current;
    if (!el || !stream || !cameraEnabled || stream.getVideoTracks().length === 0) {
      if (el) el.srcObject = null;
      return;
    }

    const videoOnly = new MediaStream(stream.getVideoTracks());
    el.srcObject = videoOnly;
    el.muted = true;
    void el.play().catch(() => {});

    return () => {
      el.srcObject = null;
    };
  }, [stream, streamVersion, cameraEnabled]);

  if (!stream || !cameraEnabled || stream.getVideoTracks().length === 0) {
    return null;
  }

  return (
    <video
      ref={localRef}
      aria-label="Your camera preview"
      playsInline
      autoPlay
      muted
      className={cn(
        "size-full bg-zinc-900 object-cover",
        facingMode === "user" && "-scale-x-100",
        className,
      )}
    />
  );
}

export function CallMedia({
  stream,
  video,
  streamVersion = 0,
  speakerOn = true,
  remoteCameraEnabled = true,
}: {
  stream: MediaStream | null;
  video: boolean;
  streamVersion?: number;
  speakerOn?: boolean;
  remoteCameraEnabled?: boolean;
}) {
  return (
    <>
      <RemoteCallAudio stream={stream} streamVersion={streamVersion} speakerOn={speakerOn} />
      {video && (
        <RemoteCallVideo
          stream={stream}
          streamVersion={streamVersion}
          remoteCameraEnabled={remoteCameraEnabled}
        />
      )}
    </>
  );
}
