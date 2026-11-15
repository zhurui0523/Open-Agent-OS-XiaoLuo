"use client";

import { Check, Pause, Play, Repeat, Volume2, VolumeX } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { claimPlayback, playbackRegistry } from "./audio-player";

interface VideoPlayerProps {
  src: string;
  title?: string;
  autoPlay?: boolean;
}

const SPEED_OPTIONS = [0.5, 1, 1.5, 2];

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// 自制视频播放器：画面为主角，控件浮于画面之上（底部渐变蒙层），
// 播放中自动隐藏、鼠标移回浮现。与音频播放器共享全局互斥播放注册表。
// 聚焦后 Space 播放暂停、左右方向键快退快进 5 秒
export function VideoPlayer({ src, title, autoPlay = false }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerId = useRef(Symbol("video-player"));
  const seekingRef = useRef(false);
  const speedRef = useRef<HTMLSpanElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(0.9);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  const [rate, setRate] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [speedUp, setSpeedUp] = useState(true);
  const [hovering, setHovering] = useState(false);
  const controlsVisible = !playing || hovering || speedOpen || seekingRef.current;

  useEffect(() => {
    const id = playerId.current;
    playbackRegistry.set(id, () => {
      const video = videoRef.current;
      if (video && !video.paused) video.pause();
    });
    return () => {
      playbackRegistry.delete(id);
      videoRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.volume = volume;
      video.muted = muted;
    }
  }, [volume, muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = rate;
  }, [rate]);

  // 切换视频源时重置播放状态
  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
    setBuffered(0);
  }, [src]);

  // 放大模态等场景自动起播；若被浏览器策略拦截则停在首帧等待手动播放
  useEffect(() => {
    if (!autoPlay) return;
    const video = videoRef.current;
    if (!video) return;
    claimPlayback(playerId.current);
    video.play().catch(() => setPlaying(false));
  }, [autoPlay, src]);

  // 倍速面板打开时点击外部收起
  useEffect(() => {
    if (!speedOpen) return;
    const handleOutside = (event: PointerEvent) => {
      if (!speedRef.current?.contains(event.target as Node)) {
        setSpeedOpen(false);
      }
    };
    document.addEventListener("pointerdown", handleOutside);
    return () => document.removeEventListener("pointerdown", handleOutside);
  }, [speedOpen]);

  // 倍速面板方向：卡片内下方空间不足（contain:paint 会裁剪）时向上弹出
  useLayoutEffect(() => {
    if (!speedOpen) return;
    const el = speedRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const host = el.closest(".canvas-node")?.getBoundingClientRect() ?? null;
    const bottomBound = host ? host.bottom : window.innerHeight;
    setSpeedUp(bottomBound - rect.bottom < 178);
  }, [speedOpen]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      video.pause();
      return;
    }
    claimPlayback(playerId.current);
    video.play().catch(() => setPlaying(false));
  };

  const updateBuffered = () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const ranges = video.buffered;
    const end = ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
    setBuffered(Math.min(1, end / video.duration));
  };

  const seekFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    );
    video.currentTime = ratio * video.duration;
    setCurrent(ratio * video.duration);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video) return;
    if (event.key === " ") {
      event.preventDefault();
      togglePlay();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      if (Number.isFinite(video.duration) && video.duration > 0) {
        const delta = event.key === "ArrowLeft" ? -5 : 5;
        video.currentTime = Math.min(
          video.duration,
          Math.max(0, video.currentTime + delta),
        );
      }
    }
  };

  const playedPct = duration > 0 ? (current / duration) * 100 : 0;
  const bufferedPct = Math.max(buffered * 100, playedPct);

  return (
    <div
      className={`video-player${playing ? " is-playing" : ""}${controlsVisible ? "" : " is-controls-hidden"}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      aria-label={title ? `视频播放器：${title}` : "视频播放器"}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        playsInline
        loop={loop}
        onClick={togglePlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onProgress={updateBuffered}
      />
      {!playing && (
        <div className="video-player-center">
          <button type="button" aria-label="播放" onClick={togglePlay}>
            <Play size={22} />
          </button>
        </div>
      )}
      <div
        className="video-player-controls"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="video-player-icon"
          aria-label={playing ? "暂停" : "播放"}
          onClick={togglePlay}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span className="video-player-time">
          {formatTime(current)} / {formatTime(duration)}
        </span>
        <div
          className="video-player-progress"
          onPointerDown={(event) => {
            seekingRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            seekFromPointer(event);
          }}
          onPointerMove={(event) => {
            if (seekingRef.current) seekFromPointer(event);
          }}
          onPointerUp={() => {
            seekingRef.current = false;
          }}
          onPointerCancel={() => {
            seekingRef.current = false;
          }}
        >
          <span className="video-player-track" />
          <span
            className="video-player-buffered"
            style={{ width: `${bufferedPct}%` }}
          />
          <span
            className="video-player-played"
            style={{ width: `${playedPct}%` }}
          />
          <span
            className="video-player-thumb"
            style={{ left: `${playedPct}%` }}
          />
        </div>
        <span className="video-player-group">
          <button
            type="button"
            className={`video-player-icon${loop ? " is-on" : ""}`}
            aria-label={loop ? "关闭单曲循环" : "开启单曲循环"}
            title={loop ? "单曲循环已开启" : "单曲循环已关闭"}
            onClick={() => setLoop((value) => !value)}
          >
            <Repeat size={14} />
          </button>
          <span className="video-player-volume-group">
            <button
              type="button"
              className="video-player-icon"
              aria-label={muted ? "取消静音" : "静音"}
              onClick={() => setMuted((value) => !value)}
            >
              {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
            <input
              className="video-player-volume"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              aria-label="音量"
              onChange={(event) => {
                const next = Number(event.target.value);
                setVolume(next);
                setMuted(next === 0);
              }}
            />
          </span>
          <span className="video-player-speed" ref={speedRef}>
            <button
              type="button"
              className="video-player-icon video-player-speed-btn"
              aria-label="倍速"
              aria-haspopup="listbox"
              aria-expanded={speedOpen}
              onClick={() => setSpeedOpen((value) => !value)}
            >
              {rate}x
            </button>
            {speedOpen && (
              <span className={`video-player-speed-panel${speedUp ? " is-up" : ""}`} role="listbox" aria-label="倍速选择">
                {SPEED_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="option"
                    aria-selected={option === rate}
                    className={`video-player-speed-item${option === rate ? " is-active" : ""}`}
                    onClick={() => {
                      setRate(option);
                      setSpeedOpen(false);
                    }}
                  >
                    <span>{option}x</span>
                    {option === rate && <Check size={14} className="video-player-speed-check" />}
                  </button>
                ))}
              </span>
            )}
          </span>
        </span>
      </div>
    </div>
  );
}
