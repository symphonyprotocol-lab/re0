'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { VIDEO_FRAMES, VIDEO_SHOT_SECONDS } from '@/lib/constants';
import { clock, shotAt, shotWindows, type IntroProps } from '@/lib/domain/video';
import { introComposition } from '@/video/intro';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';

/**
 * Expands the player node itself, so leaving fullscreen keeps the position
 * (prototype inline-video.js): native fullscreen when the host allows it, a
 * fixed full-page layout otherwise (embedded browsers deny the API).
 */
async function toggleFullscreen(node: HTMLElement, expanded: boolean): Promise<boolean> {
  if (expanded) {
    if (document.fullscreenElement === node) await document.exitFullscreen().catch(() => undefined);
    return false;
  }
  try {
    await node.requestFullscreen?.();
  } catch {
    /* The page-level layout below still applies. */
  }
  return true;
}

/**
 * The Remotion Player with the prototype's controls (suite.js
 * `playerControls`): play / pause, clock, seek, replay at the end,
 * fullscreen, and -- in the editor -- the shot timeline. Playback is free
 * and nothing is rendered to a file. `autoPlay` starts muted, since a
 * browser only lets a page start sound after a click.
 */
export function IntroPlayer({
  props,
  name,
  autoPlay = false,
  timeline = false,
  fullscreen = true,
  muted: startMuted = false,
}: {
  props: IntroProps;
  name: string;
  autoPlay?: boolean;
  timeline?: boolean;
  fullscreen?: boolean;
  muted?: boolean;
}) {
  const { t } = useI18n();
  const p = t.video.player;
  const ref = useRef<PlayerRef>(null);
  const shell = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(startMuted || autoPlay);
  const [expanded, setExpanded] = useState(false);
  const composition = introComposition(props.aspect);
  const portrait = props.aspect === '9:16';
  const ended = frame >= VIDEO_FRAMES - 1 && !playing;

  useEffect(() => {
    const player = ref.current;
    if (!player) return;
    const onFrame = (event: { detail: { frame: number } }) => setFrame(event.detail.frame);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setFrame(VIDEO_FRAMES - 1);
    };
    const onMute = (event: { detail: { isMuted: boolean } }) => setMuted(event.detail.isMuted);
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onEnded);
    player.addEventListener('mutechange', onMute);
    return () => {
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onEnded);
      player.removeEventListener('mutechange', onMute);
    };
  }, []);

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && shell.current && expanded && document.fullscreenElement !== shell.current) {
        /* Native fullscreen was left with Escape: fold the page layout too. */
        setExpanded(false);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [expanded]);

  const toggle = useCallback(() => {
    const player = ref.current;
    if (!player) return;
    if (player.isPlaying()) {
      player.pause();
      return;
    }
    if (player.getCurrentFrame() >= VIDEO_FRAMES - 1) player.seekTo(0);
    player.play();
  }, []);

  const seek = (to: number) => {
    ref.current?.seekTo(to);
    setFrame(to);
  };

  const onFullscreen = async () => {
    if (!shell.current) return;
    setExpanded(await toggleFullscreen(shell.current, expanded));
  };

  const current = shotAt(frame);
  const windows = shotWindows();
  return (
    <div className="min-w-0">
      <div
        ref={shell}
        role="region"
        aria-label={fill(p.region, { name })}
        className={expanded ? 'fixed inset-0 z-[90] flex flex-col bg-[#050a1f] p-3 sm:p-6' : 'relative'}
      >
        <div className={`relative ${expanded ? 'flex min-h-0 flex-1 items-center justify-center' : portrait ? 'mx-auto w-full max-w-[min(100%,calc(min(72vh,640px)*9/16))]' : 'w-full'}`}>
          <Player
            ref={ref}
            component={composition.component}
            inputProps={props}
            durationInFrames={composition.durationInFrames}
            fps={composition.fps}
            compositionWidth={composition.width}
            compositionHeight={composition.height}
            acknowledgeRemotionLicense
            autoPlay={autoPlay}
            initiallyMuted={muted}
            clickToPlay={false}
            doubleClickToFullscreen={false}
            spaceKeyToPlayOrPause
            style={expanded ? { width: '100%', height: '100%' } : { width: '100%', aspectRatio: portrait ? '9 / 16' : '16 / 9', borderRadius: 10, overflow: 'hidden' }}
          />
          {!playing && (
            <button
              type="button"
              onClick={toggle}
              aria-label={ended ? p.replay : p.play}
              className="absolute top-1/2 left-1/2 inline-flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-ink/70 text-white shadow-lg backdrop-blur-sm transition hover:bg-blue"
            >
              <Icon name={ended ? 'refresh' : 'play'} className="size-7" />
            </button>
          )}
        </div>
        <div className={`flex items-center gap-2.5 px-1 pt-3 ${expanded ? 'text-white' : ''}`}>
          <button type="button" className={`icon-btn ${expanded ? 'text-white hover:bg-white/10 hover:text-white' : ''}`} onClick={toggle} aria-label={playing ? p.pause : ended ? p.replay : p.play} aria-pressed={playing}>
            <Icon name={playing ? 'pause' : ended ? 'refresh' : 'play'} />
          </button>
          <span className={`font-mono text-[11px] whitespace-nowrap ${expanded ? 'text-white/70' : 'text-muted'}`} aria-live="off">
            {clock(frame)} / {clock(VIDEO_FRAMES)}
          </span>
          <input
            type="range"
            min={0}
            max={VIDEO_FRAMES - 1}
            step={1}
            value={frame}
            onChange={(event) => seek(Number(event.target.value))}
            aria-label={p.seek}
            aria-valuetext={`${clock(frame)} / ${clock(VIDEO_FRAMES)}`}
            className="h-1 min-w-0 flex-1 accent-blue"
          />
          {props.music && (
            <button
              type="button"
              className={`icon-btn ${expanded ? 'text-white hover:bg-white/10 hover:text-white' : ''}`}
              onClick={() => (muted ? ref.current?.unmute() : ref.current?.mute())}
              aria-label={p.muted}
              aria-pressed={muted}
              title={p.muted}
            >
              <Icon name="audio" className={muted ? 'opacity-40' : ''} />
            </button>
          )}
          <span className="tag hidden sm:inline-flex">720p</span>
          {fullscreen && (
            <button
              type="button"
              className={`icon-btn ${expanded ? 'text-white hover:bg-white/10 hover:text-white' : ''}`}
              onClick={onFullscreen}
              aria-label={expanded ? p.exitFullscreen : p.fullscreen}
              aria-pressed={expanded}
              title={expanded ? p.exitFullscreen : p.fullscreen}
            >
              <Icon name={expanded ? 'shrink' : 'expand'} />
            </button>
          )}
        </div>
      </div>
      {timeline && (
        <div className="mt-3 grid grid-cols-[3fr_4fr_5fr_3fr] gap-1.5" role="group" aria-label={t.video.timeline}>
          {windows.map((window, index) => (
            <button
              key={index}
              type="button"
              onClick={() => seek(window.start)}
              aria-current={current === index ? 'step' : undefined}
              className={`min-w-0 rounded-lg border px-2 py-2 text-left transition ${current === index ? 'border-blue bg-soft' : 'border-line bg-white hover:border-[#c4cce0]'}`}
            >
              <span className="block font-mono text-[10px] text-muted">
                0{index + 1} <small>{fill(t.video.shotLength, { n: VIDEO_SHOT_SECONDS[index]! })}</small>
              </span>
              <strong className="block truncate text-[11px] sm:text-[12px]">{t.video.shots[index]}</strong>
              <i className="mt-1.5 block h-1 overflow-hidden rounded-full bg-line">
                <span
                  className="block h-full bg-blue"
                  style={{ width: `${Math.max(0, Math.min(100, ((frame - window.start) / (window.end - window.start)) * 100))}%` }}
                />
              </i>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

