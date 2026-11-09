'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { VIDEO_FPS, VIDEO_FRAMES } from '@/lib/constants';
import { clock, hasVideoAudio, type IntroProps } from '@/lib/domain/video';
import { demoTimeline } from '@/lib/domain/product-demo';
import { introComposition } from '@/video/intro';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { PIcon } from '@/components/rees/proto-icon';

/**
 * Expands the player node itself, so leaving fullscreen keeps the position
 * (prototype inline-video.js): the page-level layout at once, native
 * fullscreen on top when the host allows it. Embedded browsers may deny the
 * request or never answer it, so nothing waits for it, and a late grant
 * after the viewer already collapsed the player is undone.
 */
function requestNative(node: HTMLElement, stillWanted: () => boolean): void {
  try {
    node
      .requestFullscreen?.()
      .then(() => {
        if (!stillWanted() && document.fullscreenElement === node) void document.exitFullscreen().catch(() => undefined);
      })
      .catch(() => undefined);
  } catch {
    /* The page-level layout already applies. */
  }
}

/**
 * The Remotion Player with the prototype's controls (suite.js
 * `playerControls`): play / pause, clock, seek, replay at the end,
 * fullscreen, and -- in the editor -- the shot timeline. Playback is free
 * and nothing is rendered to a file. `autoPlay` starts without the music:
 * a browser starts audio only after a click, and the Player would wait on
 * the music's clock and never move. The sound button (a click) adds it.
 */
export function IntroPlayer({
  props,
  name,
  autoPlay = false,
  timeline = false,
  fullscreen = true,
}: {
  props: IntroProps;
  name: string;
  autoPlay?: boolean;
  timeline?: boolean;
  fullscreen?: boolean;
}) {
  const { t } = useI18n();
  const p = t.video.player;
  const ref = useRef<PlayerRef | null>(null);
  /* The Player hands its controls over after it mounts; the listeners wait for them. */
  const [player, setPlayer] = useState<PlayerRef | null>(null);
  const attach = useCallback((handle: PlayerRef | null) => {
    ref.current = handle;
    setPlayer(handle);
  }, []);
  const shell = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [soundOn, setSoundOn] = useState(!autoPlay);
  const hasSound = hasVideoAudio(props);
  const shownProps = hasSound && !soundOn ? { ...props, music: false, narrationUrl: undefined } : props;
  const [expanded, setExpanded] = useState(false);
  const composition = introComposition(props.aspect);
  const portrait = props.aspect === '9:16';
  const ended = frame >= VIDEO_FRAMES - 1 && !playing;

  useEffect(() => {
    if (!player) return;
    /* An autoplay may have started before the listeners were attached. */
    setPlaying(player.isPlaying());
    setFrame(player.getCurrentFrame());
    const onFrame = (event: { detail: { frame: number } }) => setFrame(event.detail.frame);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setFrame(VIDEO_FRAMES - 1);
    };
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onEnded);
    return () => {
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onEnded);
    };
  }, [player]);

  useEffect(() => {
    if (!player) return;
    /* A hidden tab pauses the introduction (prototype README "隐藏标签页后暂停"). */
    const onVisibility = () => {
      if (document.hidden && player.isPlaying()) player.pause();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [player]);

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && expanded && wanted.current) {
        /* Native fullscreen was left with Escape: fold the page layout too. */
        wanted.current = false;
        setExpanded(false);
        fullscreenButton.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      const node = shell.current;
      if (event.key === 'Tab' && node) {
        /* Page fullscreen keeps focus inside the player (prototype suite.js inline fullscreen). */
        const controls = [...node.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]:not([tabindex="-1"])')].filter(
          (element) => !(element as HTMLButtonElement).disabled && element.getClientRects().length > 0,
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !last) return;
        const inside = node.contains(document.activeElement);
        if (event.shiftKey && (!inside || document.activeElement === first)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key !== 'Escape') return;
      /* Inside a dialog, Escape folds the player first and leaves the dialog open. */
      event.preventDefault();
      event.stopPropagation();
      wanted.current = false;
      setExpanded(false);
      if (node && document.fullscreenElement === node) void document.exitFullscreen().catch(() => undefined);
      fullscreenButton.current?.focus({ preventScroll: true });
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey, true);
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

  const wanted = useRef(false);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const onFullscreen = () => {
    const node = shell.current;
    if (!node) return;
    wanted.current = !expanded;
    setExpanded(!expanded);
    if (expanded) {
      if (document.fullscreenElement === node) void document.exitFullscreen().catch(() => undefined);
      return;
    }
    requestNative(node, () => wanted.current);
    /* Entering fullscreen plays, from the start once it has ended (prototype suite.js `inline-video-fullscreen`). */
    const player = ref.current;
    if (player && !player.isPlaying()) {
      if (player.getCurrentFrame() >= VIDEO_FRAMES - 1) player.seekTo(0);
      player.play();
    }
  };

  const demo = props.scenes.demo;
  const windows = demo ? demoTimeline(demo) : [];
  const current = Math.max(0, windows.findIndex((window) => frame < window.end));
  /* The editor (prototype suite.js `videoEditor`): the stage in its card with the controls, then the shot timeline. */
  if (timeline)
    return (
      <>
        <div className="card video-player-card" role="region" aria-label={fill(p.region, { name })}>
          <div className={`video-stage template-${props.template}${portrait ? ' portrait' : ''}`}>
            <Player
              ref={attach}
              component={composition.component}
              inputProps={shownProps}
              durationInFrames={composition.durationInFrames}
              fps={composition.fps}
              compositionWidth={composition.width}
              compositionHeight={composition.height}
              acknowledgeRemotionLicense
              autoPlay={autoPlay}
              clickToPlay={false}
              moveToBeginningWhenEnded={false}
              doubleClickToFullscreen={false}
              spaceKeyToPlayOrPause
              style={{ width: '100%', height: '100%' }}
            />
          </div>
          <div className="player-controls">
            <button type="button" className="icon-btn" onClick={toggle} aria-label={playing ? p.pause : ended ? p.replay : p.play} title={playing ? p.pause : ended ? p.replay : p.play} aria-pressed={playing}>
              <PIcon name={playing ? 'pause' : ended ? 'refresh' : 'play'} />
            </button>
            <span className="mono" aria-live="off">
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
            />
            {hasSound && (
              <button type="button" className="icon-btn" onClick={() => setSoundOn((on) => !on)} aria-label={p.muted} aria-pressed={!soundOn} title={p.muted}>
                <PIcon name="audio" />
              </button>
            )}
            <span className="tag">720p</span>
          </div>
        </div>
        <div className="video-timeline" role="group" aria-label={t.video.timeline}>
          {windows.map((window, index) => (
            <button key={index} type="button" className={current === index ? 'active' : ''} onClick={() => seek(window.start)} aria-current={current === index ? 'step' : undefined}>
              <span className="mono">
                0{index + 1} <small>{fill(t.video.shotLength, { n: Math.round((window.end - window.start) / VIDEO_FPS * 10) / 10 })}</small>
              </span>
              <strong>{index === 0 ? t.video.opening : demo?.steps[index - 1]}</strong>
              <i />
            </button>
          ))}
        </div>
      </>
    );

  return (
    <div className="min-w-0">
      <div
        ref={shell}
        role="region"
        aria-label={fill(p.region, { name })}
        className={expanded ? 'fixed inset-0 z-[90] flex flex-col bg-[#050a1f] p-3 sm:p-6' : 'relative'}
      >
        <div className={`relative ${expanded ? 'flex min-h-0 flex-1 items-center justify-center' : portrait ? 'mx-auto w-full max-w-[min(100%,calc(min(60vh,640px)*9/16))]' : 'w-full'}`}>
          <Player
            ref={attach}
            component={composition.component}
            inputProps={shownProps}
            durationInFrames={composition.durationInFrames}
            fps={composition.fps}
            compositionWidth={composition.width}
            compositionHeight={composition.height}
            acknowledgeRemotionLicense
            autoPlay={autoPlay}
            clickToPlay={false}
            moveToBeginningWhenEnded={false}
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
          {hasSound && (
            <button
              type="button"
              className={`icon-btn ${expanded ? 'text-white hover:bg-white/10 hover:text-white' : ''}`}
              onClick={() => setSoundOn((on) => !on)}
              aria-label={p.muted}
              aria-pressed={!soundOn}
              title={p.muted}
            >
              <Icon name="audio" className={soundOn ? '' : 'opacity-40'} />
            </button>
          )}
          <span className="tag hidden sm:inline-flex">720p</span>
          {fullscreen && (
            <button
              ref={fullscreenButton}
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
    </div>
  );
}

