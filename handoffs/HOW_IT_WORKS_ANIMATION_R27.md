# How it works — chain-reaction animation (R27)

Section: `#how-it-works` in `index.html`. Rebuilt in the style of a reference clip
(10 s, 1920x1080, 60 fps; 60 frames @ 6 fps dissected in /tmp/vid/hi).

## 1. Dissection of the reference

Canvas: near-black (#0b0c0e) with a faint dot grid (~28 px pitch, dots ~1.5 px, ~8% white).
The grid belongs to the world: it pans/zooms with the camera (parallax cue).
Single accent (iOS blue #0a84ff) on charcoal UI (#2a2a2d cards, #3a3a3d keys). White ball.
Type: SF-like grotesque, bold titles, regular subtitles, tiny grey "now".

| t (s) | what happens | motion notes |
|---|---|---|
| 0.0–0.5 | Close-up on a toggle (dim blue = pressed, ~0.3 s), macOS cursor on it, slider track + 3 tick marks visible at the right edge | cursor black w/ white outline, ~2.5% frame width |
| 0.5–1.0 | Toggle turns bright blue; white knob pops OUT of the toggle as a free ball, rises up-right | spring overshoot on the pop, ball ~4.5% of frame width; cursor stays behind, then drifts away and fades |
| 1.0–1.6 | Camera pans right/down; ball lands on left end of slider; blue fill grows, ticks light up left→right, tooltip above the ball counts 7, 24, 40, 53, 66, 76, 84, 91, 96, 99, 100 | count is ease-OUT (fast then slow), tooltip = dark rounded pill with caret; camera locked on ball with slight lead |
| 1.6–2.4 | At 100 a "Slider — Reached 100" notification (blue icon square, bold title, grey subtitle, "now") drops in; ball leaves the slider and falls; camera follows down | cards spring in; ball squashes/stretches along velocity |
| 2.4–3.5 | "Gravity — Something is falling", then "Messages — What now?" stack in below; a "Reply" pill sits left; older cards fade behind the ball as it descends | 0.15–0.2 s stagger, ~0.4 s springs |
| 3.5–4.2 | Ball lands on the Reply pill; pill becomes a text field with a blue send arrow; QWERTY keyboard rises from below | expand = width spring; keyboard rises with ease-out |
| 4.2–7.0 | Ball hops key to key (R, E, T, R, Y); each key depresses when touched; field text grows r, re, ret, retr, retry with a blue caret; send arrow activates after first char | ~0.5 s per letter in the clip; ball squash on each key, key dips ~3 px, lighter fill |
| 7.0–7.8 | Ball travels right along the keys to the tall "return" key (L-shaped, arrow + "return" label) and hits it; return dips | camera follows, ease-in-out |
| 7.8–8.6 | Camera swings back and up (zoom out), text becomes a blue "retry" bubble, ball flies up and away | strong motion blur on camera and ball (streaks) |
| 8.6–9.5 | Overview: toggle + slider top-left, cards stack right, Reply + bubble left, keyboard below | overview is ~40% scale; text tiny, shapes readable |
| 9.5–10.0 | Camera pans back up; everything resets (toggle off, grey, cursor comes in) | seamless loop, first frame == last frame |

Camera: continuous tracking of the ball with a smoothed lead; a few keyed moves (hold on
toggle, hold on keyboard, pull-back). Ease: cubic in-out for keyed moves, spring/overshoot for
UI pops, ease-in for falls (gravity), ease-out for the slider fill. Motion blur = ball stretch
along velocity + ghost trail; whole-frame blur only on the pull-back.

## 2. DeepWell version (what was built)

Same choreography, DeepWell's story, brand tokens (dark ground / surface, brass accent, Plex + Newsreader).
The traveling object is a brass token carrying a document glyph. Loop = 12.0 s.

| t (s) | beat | motion |
|---|---|---|
| 0.00–0.50 | cursor glides to the "Scan a record" button; camera close on it | out-cubic glide |
| 0.50–0.62 | click: button presses (0.94), fills brass, label -> "Scanned", ripple | spring back |
| 0.62–1.00 | token pops out of the button with a spring; "Invoice_1042.pdf" tag rises | out-back |
| 1.00–1.30 | token arcs to the slider start; squash on landing; camera pans | arc + ease |
| 1.30–2.75 | token slides the "Reading" slider 0→100 % (ease-out), brass fill, 11 ticks light, tooltip counts | camera locked on token |
| 2.85–3.85 | token hops down a staircase of 3 cards: each landing pops a card in — "The vault · page stored", "The index · 6 facts", "Linked · Smith · Trane XR16"; last hop lands on the "Ask Donovan" pill | landing squash, card dip, 0.2 s hops |
| 3.85–4.30 | pill expands into the field (send arrow), keyboard rises | scaleX spring, ease-out rise |
| 4.05–6.20 | question types itself, "smith warranty", token hops key to key, keys depress | 0.15 s per key |
| 6.30–6.70 | token hops onto the tall return key, key dips, send pulses | arc |
| 6.70–7.45 | field text flies to the chat area as a brass bubble; token flies into the answer and becomes the citation chip | camera follows |
| 7.15–7.60 | answer card springs up: "March 14, 2027 · Trane XR16 at 118 Oak St. · Source: Invoice_1042.pdf, p. 1" | spring |
| 7.6–8.6 | hold on the answer (readable) | |
| 8.6–9.6 | camera pulls back to overview; captions 01 Capture · 02 Link · 03 Ask fade in | in-out cubic |
| 9.6–11.2 | hold overview (1.6 s) | |
| 11.2–11.95 | everything fades, camera glides back to the button; wraps to t=0 | |

## 3. Engineering

- One deterministic `render(t)` (pure function of loop time) drives every element; a single rAF
  controller with a run token, IntersectionObserver + visibilitychange pause, dt clamp.
- World (grid + UI) is one layer moved by a single camera transform; all animation is transform + opacity.
- Camera = keyed moves blended with a time-smoothed (look-ahead) follow of the token.
- Two layouts (wide / tall) chosen by stage aspect; phones use a vertical chain.
- Reduced motion: static overview state (t = 10.4), captions visible, no rAF.
- Test hooks: `#how-it-works.__hiw` = `{seek(t), resume(), T}`; `.hiw-stage[data-loops]` counts loops.
