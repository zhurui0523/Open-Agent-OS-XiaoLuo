"use client";

import { Pause, Play, Repeat, Volume2, VolumeX } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

interface AudioPlayerProps {
  src: string;
  title?: string;
  tags?: string;
}

// 全局互斥播放：画布上同一时间只允许一个播放器发声，
// 新的播放器开始播放时自动暂停其余播放器
export const playbackRegistry = new Map<symbol, () => void>();

export function claimPlayback(id: symbol) {
  playbackRegistry.forEach((pause, key) => {
    if (key !== id) pause();
  });
}

function hashSeed(input: string) {
  let seed = 0;
  for (let i = 0; i < input.length; i += 1) {
    seed = (seed * 31 + input.charCodeAt(i)) % 2147483647;
  }
  return seed || 1;
}

// 确定性伪波形：条高由音频 URL 散列生成，同一首歌每次渲染一致，
// 避免解码音频文件（OSS 跨域读取有风险）
function buildWaveBars(src: string, count = 48) {
  let seed = hashSeed(src);
  const bars: number[] = [];
  for (let i = 0; i < count; i += 1) {
    seed = (seed * 9301 + 49297) % 233280;
    bars.push(0.3 + (seed / 233280) * 0.7);
  }
  return bars;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function parseTagList(tags?: string) {
  if (!tags) return [];
  return tags
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 4);
}

// 自制音频播放器：信息头（标题+风格标签）+ 律动波形（兼作进度条，可点击拖动定位）
// + 控制条（播放/时间/单曲循环/音量）。聚焦后 Space 播放暂停、左右方向键快退快进 5 秒
export function AudioPlayer({ src, title, tags }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playerId = useRef(Symbol("audio-player"));
  const seekingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.9);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  const bars = useMemo(() => buildWaveBars(src), [src]);
  const tagList = useMemo(() => parseTagList(tags), [tags]);

  useEffect(() => {
    const id = playerId.current;
    playbackRegistry.set(id, () => {
      const audio = audioRef.current;
      if (audio && !audio.paused) audio.pause();
    });
    return () => {
      playbackRegistry.delete(id);
      audioRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = volume;
      audio.muted = muted;
    }
  }, [volume, muted]);

  // 切换音源时重置播放状态
  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
  }, [src]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      return;
    }
    claimPlayback(playerId.current);
    audio.play().catch(() => setPlaying(false));
  };

  const seekFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    );
    audio.currentTime = ratio * audio.duration;
    setCurrent(ratio * audio.duration);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (event.key === " ") {
      event.preventDefault();
      togglePlay();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const delta = event.key === "ArrowLeft" ? -5 : 5;
        audio.currentTime = Math.min(
          audio.duration,
          Math.max(0, audio.currentTime + delta),
        );
      }
    }
  };

  const playedBars =
    duration > 0 ? Math.round((current / duration) * bars.length) : 0;

  return (
    <div
      className={`audio-player${playing ? " is-playing" : ""}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label={title ? `音频播放器：${title}` : "音频播放器"}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        loop={loop}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) =>
          setDuration(event.currentTarget.duration)
        }
      />
      {(title || tagList.length > 0) && (
        <div className="audio-player-header">
          {title && (
            <span className="audio-player-title" title={title}>
              {title}
            </span>
          )}
          {tagList.length > 0 && (
            <span className="audio-player-tags">
              {tagList.map((tag) => (
                <span className="audio-player-tag" key={tag}>
                  {tag}
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      <div
        className="audio-player-wave"
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
        {bars.map((height, index) => (
          <span
            key={index}
            className={index < playedBars ? "is-played" : ""}
            style={{
              height: `${Math.round(height * 100)}%`,
              animationDelay: `${(index % 7) * 0.13}s`,
            }}
          />
        ))}
      </div>
      <div className="audio-player-controls">
        <button
          type="button"
          className="audio-player-play"
          aria-label={playing ? "暂停" : "播放"}
          onClick={togglePlay}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span className="audio-player-time">
          {formatTime(current)} / {formatTime(duration)}
        </span>
        <span className="audio-player-right">
          <button
            type="button"
            className={`audio-player-mini${loop ? " is-on" : ""}`}
            aria-label={loop ? "关闭单曲循环" : "开启单曲循环"}
            title={loop ? "单曲循环已开启" : "单曲循环已关闭"}
            onClick={() => setLoop((value) => !value)}
          >
            <Repeat size={14} />
          </button>
          <button
            type="button"
            className="audio-player-mini"
            aria-label={muted ? "取消静音" : "静音"}
            onClick={() => setMuted((value) => !value)}
          >
            {muted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <input
            className="audio-player-volume"
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
      </div>
    </div>
  );
}