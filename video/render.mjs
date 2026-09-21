#!/usr/bin/env node
// Renders video/promo.html to deepwell-promo.mp4/.webm/-15s.mp4 + poster.jpg
// + a 30-frame contact sheet. Deterministic: every frame is produced by
// calling window.__seek(ms) on the page and screenshotting it — no reliance
// on real-time animation, so the same frame comes out every run regardless
// of machine speed.
//
// Usage:
//   node video/render.mjs                 # 1920x1080, 30fps, everything
//   node video/render.mjs --sd            # 1280x720, 30fps (fast review copy)
//   node video/render.mjs --skip-cut      # skip the 15s social cut
//   node video/render.mjs --skip-main     # only render the 15s cut
//   node video/render.mjs --skip-contact  # skip the contact sheet
//   node video/render.mjs --skip-audio    # silent output (no ambient bed)
//   node video/render.mjs --skip-webm     # skip the .webm encode
//   node video/render.mjs --contact-out <path>  # where to save the contact sheet
//   node video/render.mjs --src <file.html> --out <basename>
//       # reuse this driver for a different scene file, e.g.
//       # --src promo-v3.html --out deepwell-promo-v3 — output names,
//       # frame-cache dirs, the poster name and the 15s cut segments all
//       # follow --out/--src (see CUT_SEGMENTS_V3/IS_V3 below); an
//       # "-v3"-suffixed --out also switches the synthesized audio bed to
//       # the richer v3 profile (--audio-profile classic|v3 to override)
//   node video/render.mjs --crf 17        # encoder quality (default 18)
//   node video/render.mjs --blur          # cheap temporal-blend motion blur
//       # (ffmpeg tmix, see MOTION_BLUR_VF below) + a small filmic grade
//
// Requires: chromium at /opt/pw-browsers/chromium-1194/chrome-linux/chrome
// (Playwright, from node_modules) and the system ffmpeg
// (/usr/bin/ffmpeg — the Playwright-bundled one has no libx264).

import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FFMPEG = '/usr/bin/ffmpeg';
const FPS = 30;
const TOTAL_MS = 60000;

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const sd = argv.includes('--sd');
const skipCut = argv.includes('--skip-cut');
const skipMain = argv.includes('--skip-main');
const skipContact = argv.includes('--skip-contact');
const skipAudio = argv.includes('--skip-audio');
const skipWebm = argv.includes('--skip-webm');
const blur = argv.includes('--blur');
const encodeOnly = argv.includes('--encode-only');
const framesOnly = argv.includes('--frames-only');
const frameStart = parseInt(arg('--frame-start', '0'), 10);
const frameCountArg = arg('--frame-count', null);
const frameCount = frameCountArg == null ? null : parseInt(frameCountArg, 10);
const WIDTH = sd ? 1280 : 1920;
const HEIGHT = sd ? 720 : 1080;
const CRF = parseInt(arg('--crf', '18'), 10);

const SRC_NAME = arg('--src', 'promo.html');
const OUT_BASE = arg('--out', 'deepwell-promo');
const AUDIO_PROFILE = arg('--audio-profile', OUT_BASE.endsWith('-v3') ? 'v3' : 'classic');
const SRC_STEM = SRC_NAME.replace(/\.html$/, '');
// poster name mirrors the OUT_BASE pattern: "deepwell-promo" -> "poster",
// "deepwell-promo-v3" -> "poster-v3" (falls back to "<out>-poster" otherwise).
const POSTER_NAME = OUT_BASE.startsWith('deepwell-promo')
  ? OUT_BASE.replace('deepwell-promo', 'poster')
  : `${OUT_BASE}-poster`;

const PROMO_PATH = path.join(__dirname, SRC_NAME);
const FRAMES_MAIN = path.join(__dirname, `.frames-main-${OUT_BASE}`);
const FRAMES_CUT = path.join(__dirname, `.frames-cut-${OUT_BASE}`);
const FRAMES_CONTACT = path.join(__dirname, `.frames-contact-${OUT_BASE}`);
const OUT_MP4 = path.join(__dirname, `${OUT_BASE}.mp4`);
const OUT_WEBM = path.join(__dirname, `${OUT_BASE}.webm`);
const OUT_15S = path.join(__dirname, `${OUT_BASE}-15s.mp4`);
const OUT_POSTER = path.join(__dirname, `${POSTER_NAME}.jpg`);
const OUT_CONTACT = path.resolve(arg('--contact-out', path.join(__dirname, `${SRC_STEM}-contact.png`)));
const SILENT_MAIN = path.join(__dirname, `.silent-main-${OUT_BASE}.mp4`);
const SILENT_15S = path.join(__dirname, `.silent-15s-${OUT_BASE}.mp4`);
const AUDIO_MAIN = path.join(__dirname, `.ambient-60s-${OUT_BASE}.wav`);
const AUDIO_15S = path.join(__dirname, `.ambient-15s-${OUT_BASE}.wav`);

// 15s cut: three beats sampled from the 60s timeline (logo -> one full Q&A
// -> closing URL), each stretched/compressed linearly onto its own slice of
// the 15s output. Still calls the exact same deterministic __seek(ms).
// v2 (promo.html) scene table: logo 6-14s, ask 30-44s, close 52-60s.
const CUT_SEGMENTS_V2 = [
  { outStart: 0, outEnd: 4.0, srcStart: 7000, srcEnd: 13400 },     // logo draw-on + tagline
  { outStart: 4.0, outEnd: 11.5, srcStart: 30000, srcEnd: 37914 }, // type -> read -> answer (Q1)
  { outStart: 11.5, outEnd: 15.0, srcStart: 52000, srcEnd: 55600 }, // tagline + price + url
];
// v3 (promo-v3.html) scene table: logo 9.5-17s, ask (centerpiece) 33-53s,
// close 57-60s — see promo-v3.html's SCENES array.
const CUT_SEGMENTS_V3 = [
  { outStart: 0, outEnd: 4.0, srcStart: 9700, srcEnd: 16000 },      // logo draw-on + tagline
  { outStart: 4.0, outEnd: 10.0, srcStart: 33000, srcEnd: 38948 },  // type -> read -> answer (Q1)
  { outStart: 10.0, outEnd: 15.0, srcStart: 57000, srcEnd: 60000 }, // tagline + price + url
];
const IS_V3 = OUT_BASE.endsWith('-v3') || SRC_STEM.endsWith('-v3');
const CUT_SEGMENTS = IS_V3 ? CUT_SEGMENTS_V3 : CUT_SEGMENTS_V2;
const CUT_TOTAL_S = 15.0;

// The poster/best-Ask-frame: mid-hold on the second Q&A (Desert Ridge
// Dental), well fully risen with its bronze answer bar, outreach card
// visible — computed from promo.html's own Q1/Q2 cycle timing so it moves
// automatically if that copy is edited (see buildCycle() there).
const POSTER_T_S = IS_V3 ? 45.5 : 42.5;

function pad(n) { return String(n).padStart(5, '0'); }

async function renderFrames(page, framesDir, mapT, totalFrames, startIdx = 0, count = null) {
  await mkdir(framesDir, { recursive: true });
  const end = count == null ? totalFrames : Math.min(totalFrames, startIdx + count);
  for (let i = startIdx; i < end; i++) {
    const t = mapT(i);
    await page.evaluate((ms) => window.__seek(ms), t);
    await page.screenshot({ path: path.join(framesDir, `frame-${pad(i)}.png`) });
  }
}

// ---------------------------------------------------------------- audio bed
// A restrained ambient bed: a low two-tone drone with a slow amplitude LFO
// (tremolo) plus a soft periodic click every 2s (a "beat"), synthesized
// entirely with ffmpeg's lavfi sources — no samples, no licensing concerns.
// Loudness is brought to roughly -18 LUFS with loudnorm.
async function synthAmbient(outPath, durationS) {
  await run(FFMPEG, ['-y',
    '-f', 'lavfi', '-i', `sine=frequency=55:sample_rate=48000:duration=${durationS}`,
    '-f', 'lavfi', '-i', `sine=frequency=110:sample_rate=48000:duration=${durationS}`,
    '-f', 'lavfi', '-i', `aevalsrc=0.5*sin(2*PI*950*t)*exp(-10*mod(t\\,2)):s=48000:d=${durationS}`,
    '-filter_complex',
    '[0]tremolo=f=0.15:d=0.6,volume=0.11[a];' +
    '[1]volume=0.035[b];' +
    '[2]volume=0.05[c];' +
    '[a][b][c]amix=inputs=3:normalize=0:duration=longest[mix];' +
    '[mix]alimiter=limit=0.5,loudnorm=I=-18:TP=-2:LRA=7[aout]',
    '-map', '[aout]', outPath]);
}

// ------------------------------------------------------------ v3 audio bed
// Six layers, all synthesized with ffmpeg lavfi/aevalsrc (no samples):
//   1. sub drone   - 55Hz sine with a slow LFO on amplitude (tremolo)
//   2. soft pad    - detuned sines (220/221/330Hz) summed, lowpassed, with
//                    a slow tremolo standing in for a "filter sweep" (see
//                    handoff note: a true swept-cutoff automation isn't
//                    reliably available across ffmpeg's stock audio
//                    filters, so the sweep is approximated as a slow
//                    brightness/amplitude breathing on the lowpassed pad)
//   3. tick        - a short bandpassed noise burst once per beat (72bpm =
//                    0.8333s), built from aevalsrc's random() generator
//   4. riser       - a highpassed noise swoosh with a linear volume ramp,
//                    timed into the logo-scene cut (~9.5s)
//   5. thuds       - a handful of low decaying sine hits timed to this
//                    scene's headline landings
// Mixed and brought to about -16 LUFS with loudnorm; alimiter guards against
// clipping from the mix.
const V3_THUD_TIMES = [0.6, 5.3, 10.7, 17.4, 33.4, 53.4, 57.6];
function v3ThudExpr() {
  return V3_THUD_TIMES.map((ti) => (
    `if(between(t\\,${ti}\\,${(ti + 0.35).toFixed(2)})\\,sin(2*PI*85*(t-${ti}))*exp(-16*(t-${ti}))\\,0)`
  )).join('+');
}
async function synthAmbientV3(outPath, durationS) {
  const thudExpr = `0.5*(${v3ThudExpr()})`;
  await run(FFMPEG, ['-y',
    // 0: sub drone
    '-f', 'lavfi', '-i', `sine=frequency=55:sample_rate=48000:duration=${durationS}`,
    // 1/2/3: detuned pad partials
    '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${durationS}`,
    '-f', 'lavfi', '-i', `sine=frequency=221:sample_rate=48000:duration=${durationS}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=48000:duration=${durationS}`,
    // 4: beat tick - bandpassed decaying noise burst every 0.8333s (72bpm)
    '-f', 'lavfi', '-i', `aevalsrc=0.9*(2*random(0)-1)*exp(-45*mod(t\\,0.8333)):s=48000:d=${durationS}`,
    // 5: riser - highpassed noise with a rising gain ramp into the logo cut (~9.5s)
    '-f', 'lavfi', '-i', `aevalsrc=(2*random(1)-1):s=48000:d=${durationS}`,
    // 6: thuds - low decaying sine hits at headline landings
    '-f', 'lavfi', '-i', `aevalsrc=${thudExpr}:s=48000:d=${durationS}`,
    '-filter_complex',
    '[0]tremolo=f=0.1:d=0.5,volume=0.16[drone];' +
    '[1][2][3]amix=inputs=3:normalize=0,lowpass=f=1100,tremolo=f=0.1:d=0.55,volume=0.085[pad];' +
    '[4]bandpass=f=2600:width_type=h:w=1800,volume=0.16[tick];' +
    '[5]atrim=6.5:9.6,asetpts=PTS-STARTPTS,highpass=f=900,afade=t=in:st=0:d=2.5,volume=0.35,adelay=6500:all=1[riser];' +
    '[6]volume=0.5[thud];' +
    '[drone][pad][tick][riser][thud]amix=inputs=5:normalize=0:duration=first[mix];' +
    '[mix]alimiter=limit=0.7,loudnorm=I=-16:TP=-1.5:LRA=8[aout]',
    '-map', '[aout]', outPath]);
}

async function main() {
  if (!encodeOnly) {
    console.log(`Launching chromium (${WIDTH}x${HEIGHT})…`);
    var browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    var page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    const url = `file://${PROMO_PATH}?w=${WIDTH}&h=${HEIGHT}`;
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    // Give the Google Fonts request a moment; non-fatal if it never resolves
    // (no network) — the page falls back to system serif/mono either way.
    try { await page.waitForLoadState('networkidle', { timeout: 4000 }); } catch { /* fine */ }
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});

    if (errors.length) {
      console.error('pageerror(s) detected — aborting:', errors);
      await browser.close();
      process.exit(1);
    }

    if (!skipContact) {
      console.log('Rendering 30-frame contact sheet (every 2s)…');
      const t0 = Date.now();
      await renderFrames(page, FRAMES_CONTACT, (i) => i * 2000, 30);
      await run(FFMPEG, ['-y', '-i', path.join(FRAMES_CONTACT, 'frame-%05d.png'),
        '-filter_complex', 'tile=6x5', OUT_CONTACT]);
      await rm(FRAMES_CONTACT, { recursive: true, force: true });
      console.log(`Contact sheet done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT_CONTACT}`);
    }

    if (!skipMain) {
      const totalFrames = Math.round((TOTAL_MS / 1000) * FPS);
      const cStart = frameStart, cCount = frameCount == null ? totalFrames - frameStart : frameCount;
      console.log(`Rendering main frames ${cStart}..${cStart + cCount} of ${totalFrames}…`);
      const t0 = Date.now();
      await renderFrames(page, FRAMES_MAIN, (i) => (i / FPS) * 1000, totalFrames, cStart, cCount);
      console.log(`Main frames done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    if (!skipCut) {
      const cutFrames = Math.round(CUT_TOTAL_S * FPS);
      const cStart = frameStart, cCount = frameCount == null ? cutFrames - frameStart : frameCount;
      console.log(`Rendering 15s-cut frames ${cStart}..${cStart + cCount} of ${cutFrames}…`);
      const t0 = Date.now();
      await renderFrames(page, FRAMES_CUT, (i) => {
        const outS = i / FPS;
        const seg = CUT_SEGMENTS.find((s) => outS >= s.outStart && outS <= s.outEnd) || CUT_SEGMENTS[CUT_SEGMENTS.length - 1];
        const localX = (outS - seg.outStart) / (seg.outEnd - seg.outStart || 1);
        return seg.srcStart + (seg.srcEnd - seg.srcStart) * Math.min(Math.max(localX, 0), 1);
      }, cutFrames, cStart, cCount);
      console.log(`Cut frames done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    await browser.close();
  } else {
    console.log('--encode-only: skipping browser/rendering, using existing frame caches.');
  }

  if (framesOnly) { console.log('--frames-only: skipping encode step.'); return; }

  // Cheap 24fps-style motion blur substitute: rather than rendering 2-3
  // WebGL sub-samples per output frame in __seek (which would roughly
  // double/triple the Playwright render time and blow the render-time
  // budget), a light temporal blend of adjacent already-rendered frames
  // (ffmpeg `tmix`) plus a small filmic contrast/saturation trim is applied
  // at encode time when --blur is passed. Noted here and in the handoff so
  // the trade-off isn't silent.
  const MOTION_BLUR_VF = 'tmix=frames=2:weights=\'2 1\',eq=contrast=1.03:saturation=0.96';

  if (!skipMain) {
    console.log('Encoding video (silent)…');
    const vf = ['-r', String(FPS)];
    if (blur) vf.push('-vf', MOTION_BLUR_VF);
    await run(FFMPEG, ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES_MAIN, 'frame-%05d.png'),
      '-c:v', 'libx264', '-crf', String(CRF), '-pix_fmt', 'yuv420p', ...vf, SILENT_MAIN]);

    console.log(`Extracting ${path.basename(OUT_POSTER)}…`);
    const posterFrame = pad(Math.round(POSTER_T_S * FPS));
    await run(FFMPEG, ['-y', '-i', path.join(FRAMES_MAIN, `frame-${posterFrame}.png`), '-q:v', '3', OUT_POSTER]);

    await rm(FRAMES_MAIN, { recursive: true, force: true });

    const synth = AUDIO_PROFILE === 'v3' ? synthAmbientV3 : synthAmbient;
    if (skipAudio) {
      await run(FFMPEG, ['-y', '-i', SILENT_MAIN, '-c', 'copy', OUT_MP4]);
      if (!skipWebm) {
        console.log(`Encoding ${path.basename(OUT_WEBM)} (vp9, silent)…`);
        await run(FFMPEG, ['-y', '-i', SILENT_MAIN, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-pix_fmt', 'yuv420p', OUT_WEBM]);
      }
    } else {
      console.log(`Synthesizing 60s ambient bed (${AUDIO_PROFILE})…`);
      await synth(AUDIO_MAIN, 60);
      console.log(`Muxing ${path.basename(OUT_MP4)} (h264 + aac)…`);
      await run(FFMPEG, ['-y', '-i', SILENT_MAIN, '-i', AUDIO_MAIN,
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', OUT_MP4]);
      if (!skipWebm) {
        console.log(`Encoding ${path.basename(OUT_WEBM)} (vp9 + opus)…`);
        await run(FFMPEG, ['-y', '-i', SILENT_MAIN, '-i', AUDIO_MAIN,
          '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-pix_fmt', 'yuv420p',
          '-c:a', 'libopus', '-b:a', '96k', '-shortest', OUT_WEBM]);
      }
      await rm(AUDIO_MAIN, { force: true });
    }
    await rm(SILENT_MAIN, { force: true });
  }

  if (!skipCut) {
    console.log('Encoding 15s-cut video (silent)…');
    const vfCut = ['-r', String(FPS)];
    if (blur) vfCut.push('-vf', MOTION_BLUR_VF);
    await run(FFMPEG, ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES_CUT, 'frame-%05d.png'),
      '-c:v', 'libx264', '-crf', String(CRF), '-pix_fmt', 'yuv420p', ...vfCut, SILENT_15S]);
    await rm(FRAMES_CUT, { recursive: true, force: true });

    if (skipAudio) {
      await run(FFMPEG, ['-y', '-i', SILENT_15S, '-c', 'copy', OUT_15S]);
    } else {
      console.log('Synthesizing 15s ambient bed…');
      await synthAmbient(AUDIO_15S, 15);
      console.log('Muxing deepwell-promo-15s.mp4…');
      await run(FFMPEG, ['-y', '-i', SILENT_15S, '-i', AUDIO_15S,
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', OUT_15S]);
      await rm(AUDIO_15S, { force: true });
    }
    await rm(SILENT_15S, { force: true });
  }

  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
