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
//   node video/render.mjs --contact-out <path>  # where to save the contact sheet
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
const WIDTH = sd ? 1280 : 1920;
const HEIGHT = sd ? 720 : 1080;

const PROMO_PATH = path.join(__dirname, 'promo.html');
const FRAMES_MAIN = path.join(__dirname, '.frames-main');
const FRAMES_CUT = path.join(__dirname, '.frames-cut');
const FRAMES_CONTACT = path.join(__dirname, '.frames-contact');
const OUT_MP4 = path.join(__dirname, 'deepwell-promo.mp4');
const OUT_WEBM = path.join(__dirname, 'deepwell-promo.webm');
const OUT_15S = path.join(__dirname, 'deepwell-promo-15s.mp4');
const OUT_POSTER = path.join(__dirname, 'poster.jpg');
const OUT_CONTACT = path.resolve(arg('--contact-out', path.join(__dirname, 'promo-contact.png')));
const SILENT_MAIN = path.join(__dirname, '.silent-main.mp4');
const SILENT_15S = path.join(__dirname, '.silent-15s.mp4');
const AUDIO_MAIN = path.join(__dirname, '.ambient-60s.wav');
const AUDIO_15S = path.join(__dirname, '.ambient-15s.wav');

// 15s cut: three beats sampled from the 60s timeline (logo -> one full Q&A
// -> closing URL), each stretched/compressed linearly onto its own slice of
// the 15s output. Still calls the exact same deterministic __seek(ms).
const CUT_SEGMENTS = [
  { outStart: 0, outEnd: 4.0, srcStart: 7000, srcEnd: 13400 },     // logo draw-on + tagline
  { outStart: 4.0, outEnd: 11.5, srcStart: 30000, srcEnd: 37914 }, // type -> read -> answer (Q1)
  { outStart: 11.5, outEnd: 15.0, srcStart: 52000, srcEnd: 55600 }, // tagline + price + url
];
const CUT_TOTAL_S = 15.0;

// The poster/best-Ask-frame: mid-hold on the second Q&A (Desert Ridge
// Dental), well fully risen with its bronze answer bar, outreach card
// visible — computed from promo.html's own Q1/Q2 cycle timing so it moves
// automatically if that copy is edited (see buildCycle() there).
const POSTER_T_S = 42.5;

function pad(n) { return String(n).padStart(5, '0'); }

async function renderFrames(page, framesDir, mapT, totalFrames) {
  await mkdir(framesDir, { recursive: true });
  for (let i = 0; i < totalFrames; i++) {
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

async function main() {
  console.log(`Launching chromium (${WIDTH}x${HEIGHT})…`);
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const page = await context.newPage();
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
    console.log(`Rendering ${totalFrames} main frames…`);
    const t0 = Date.now();
    await renderFrames(page, FRAMES_MAIN, (i) => (i / FPS) * 1000, totalFrames);
    console.log(`Main frames done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  if (!skipCut) {
    const cutFrames = Math.round(CUT_TOTAL_S * FPS);
    console.log(`Rendering ${cutFrames} 15s-cut frames…`);
    const t0 = Date.now();
    await renderFrames(page, FRAMES_CUT, (i) => {
      const outS = i / FPS;
      const seg = CUT_SEGMENTS.find((s) => outS >= s.outStart && outS <= s.outEnd) || CUT_SEGMENTS[CUT_SEGMENTS.length - 1];
      const localX = (outS - seg.outStart) / (seg.outEnd - seg.outStart || 1);
      return seg.srcStart + (seg.srcEnd - seg.srcStart) * Math.min(Math.max(localX, 0), 1);
    }, cutFrames);
    console.log(`Cut frames done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  await browser.close();

  if (!skipMain) {
    console.log('Encoding video (silent)…');
    await run(FFMPEG, ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES_MAIN, 'frame-%05d.png'),
      '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), SILENT_MAIN]);

    console.log('Extracting poster.jpg…');
    const posterFrame = pad(Math.round(POSTER_T_S * FPS));
    await run(FFMPEG, ['-y', '-i', path.join(FRAMES_MAIN, `frame-${posterFrame}.png`), '-q:v', '3', OUT_POSTER]);

    await rm(FRAMES_MAIN, { recursive: true, force: true });

    if (skipAudio) {
      await run(FFMPEG, ['-y', '-i', SILENT_MAIN, '-c', 'copy', OUT_MP4]);
      console.log('Encoding deepwell-promo.webm (vp9, silent)…');
      await run(FFMPEG, ['-y', '-i', SILENT_MAIN, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-pix_fmt', 'yuv420p', OUT_WEBM]);
    } else {
      console.log('Synthesizing 60s ambient bed (drone + soft click)…');
      await synthAmbient(AUDIO_MAIN, 60);
      console.log('Muxing deepwell-promo.mp4 (h264 + aac)…');
      await run(FFMPEG, ['-y', '-i', SILENT_MAIN, '-i', AUDIO_MAIN,
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', OUT_MP4]);
      console.log('Encoding deepwell-promo.webm (vp9 + opus)…');
      await run(FFMPEG, ['-y', '-i', SILENT_MAIN, '-i', AUDIO_MAIN,
        '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-pix_fmt', 'yuv420p',
        '-c:a', 'libopus', '-b:a', '96k', '-shortest', OUT_WEBM]);
      await rm(AUDIO_MAIN, { force: true });
    }
    await rm(SILENT_MAIN, { force: true });
  }

  if (!skipCut) {
    console.log('Encoding 15s-cut video (silent)…');
    await run(FFMPEG, ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES_CUT, 'frame-%05d.png'),
      '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), SILENT_15S]);
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
