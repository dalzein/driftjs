/* =============================================================================
 * drift.js — a 2D arcade drifting game
 *
 * Architecture
 *   - Fixed-timestep physics (frame-rate independent: identical feel on 60/120/144Hz)
 *   - Velocity-vector grip model: the car body points one way (heading) while its
 *     velocity vector slides another. Lateral grip slowly pulls the two together.
 *     Steer hard on the throttle and the rear breaks loose → drift.
 *   - Two stacked canvases:
 *       .trails  persistent skid marks (only ever drawn onto, never cleared except
 *                by the user) so marks build up over time.
 *       .game    cleared every frame: the car, tire smoke, score popups, glow.
 *   - CSS transform on .viewport for cheap screen-shake of both canvases at once.
 * ========================================================================== */

/* ----------------------------------------------------------------------------
 * DOM references
 * ------------------------------------------------------------------------- */
const trailsCanvas = document.querySelector("canvas.trails");
const gameCanvas = document.querySelector("canvas.game");
const tctx = trailsCanvas.getContext("2d");
const gctx = gameCanvas.getContext("2d");

const viewportRef = document.querySelector(".viewport");
const headerRef = document.querySelector("header");
const instructionsRef = document.querySelector(".instructions");
const mobileControlsRef = document.querySelector(".mobile-controls");
const clearTireMarksRef = document.querySelector(".clear-tire-marks");
const muteToggleRef = document.querySelector(".mute-toggle");

const speedValueRef = document.querySelector(".speed-value");
const scoreValueRef = document.querySelector(".score-value");
const bestValueRef = document.querySelector(".best-value");
const driftMeterRef = document.querySelector(".drift-meter");
const driftPointsRef = document.querySelector(".drift-points");
const driftMultiplierRef = document.querySelector(".drift-multiplier");
const boostRef = document.querySelector(".boost");
const boostFillRef = document.querySelector(".boost-fill");

const carAsset = document.getElementById("car-asset");

/* ----------------------------------------------------------------------------
 * Tuning — everything you'd want to tweak to change how the car feels.
 * Forces are expressed per-second so they are independent of the timestep.
 * ------------------------------------------------------------------------- */
const TUNING = {
  // Car body (world pixels)
  carLength: 44,
  carWidth: 22,
  rearAxle: 14, // distance from centre to rear wheels
  frontAxle: 14, // distance from centre to front wheels
  trackHalf: 9, // distance from centreline to each wheel

  // Longitudinal (forward/back)
  enginePower: 900, // forward acceleration (px/s^2)
  brakePower: 1400, // braking when moving forward
  reversePower: 500, // acceleration when reversing
  maxSpeed: 620, // forward terminal speed (px/s)
  maxReverse: 180, // reverse terminal speed (px/s)
  dragRetainPerSec: 0.32, // air drag: fraction of forward speed kept per second
  rollingResist: 90, // constant rolling resistance (px/s^2) when coasting

  // Wheelspin on launch — flooring it from low speed spins the rears: tires
  // slip (less bite, so they smoke & lay rubber) then "hook up" and surge.
  wheelspinSpeed: 175, // speed (px/s) below which the tires can break loose
  wheelspinSlip: 0.4, // how much launch traction is lost at full wheelspin (0..1)

  // Burnout — flooring it with the brake on (down+up) from low speed.
  burnoutMaxSpeed: 60, // only engages below this speed (px/s)
  burnoutCreep: 0.1, // fraction of engine power that leaks past the brake (slow crawl)
  burnoutHoldPerSec: 0.05, // forward-speed retained per second while braked (holds it near rest)
  burnoutTurnRate: 2.6, // pivot rate (rad/s) from the spinning tires while burning out

  // Lateral grip — how quickly sideways velocity is killed (fraction kept / sec).
  // Lower = grippier (drift recovers fast). Higher = slidier.
  gripBaseRetainPerSec: 0.12,
  gripPowerOversteer: 0.18, // grip lost on throttle / wheelspin to break the rear loose

  // Steering
  maxTurnRate: 3.1, // rad/s at full lock & full grip-speed
  turnResponse: 12, // how fast steering ramps to target (1/s)
  steerSpeedRef: 160, // speed (px/s) at which steering reaches full authority
  slipYawAssist: 1.0, // self-stabilising yaw from the slide (forgiving arcade feel)

  // Feel thresholds
  driftSlipThreshold: 0.28, // slip angle (rad) above which we count as "drifting"
  skidSlipThreshold: 0.16, // slip above which tires leave marks
  smokeSlipThreshold: 0.35, // slip above which we emit smoke

  // Scoring
  driftScoreRate: 1.0, // base points per (slip·speed·second)
  driftTierSeconds: 1.4, // each tier of held drift adds +1 to the multiplier
  driftMaxMultiplier: 10, // multiplier cap
  driftGraceSeconds: 1.2, // window to re-enter a drift before the chain banks
  linkSlideSpeed: 70, // lateral speed (px/s) that confirms a slide direction (for switchback LINKs)

  // Boost (charged by drifting, spent with Shift)
  boostPower: 850, // extra forward acceleration while boosting (px/s^2)
  boostMaxSpeedFactor: 1.5, // boosting raises the speed ceiling by this factor
  boostDrainPerSec: 0.5, // charge spent per second while boosting (full ≈ 2s)
  boostFillRate: 0.22, // charge gained per (slip·second) of drifting

  // Dynamic camera — a gentle pull-OUT at speed/boost (sense of speed), plus a
  // brief zoom KICK on milestones. No continuous drift zoom-in (it felt queasy).
  camZoomSpeed: 0.05, // max zoom-OUT from raw speed
  camZoomBoost: 0.04, // extra zoom-OUT while boosting
  camZoomPunch: 0.05, // size of the brief zoom kick on tier-up / donut / link
  camEase: 4, // how fast the zoom eases toward its target (1/s)
};

/* ----------------------------------------------------------------------------
 * Car state (SI-ish: pixels and seconds, angles in radians)
 *   heading 0 = pointing right (+x). The car spawns pointing up.
 * ------------------------------------------------------------------------- */
const car = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  heading: -Math.PI / 2,
  angularVel: 0,
  // derived each step (exposed for rendering/audio)
  speed: 0,
  forwardV: 0,
  lateralV: 0,
  slip: 0,
  wheelspin: 0,
  boosting: false,
};

// Boost charge (0..1), filled by drifting, spent while Shift is held.
const nitro = { charge: 0, active: false };

// Juice state — tier-up slow-mo, shockwave rings, and boost afterimage ghosts.
let slowmo = 0; // seconds of tier-up slow motion remaining
let timeScale = 1; // eased sim time multiplier (dips on tier-up)
const rings = []; // expanding shockwaves burst from the car on milestones
const ghosts = []; // fading car silhouettes laid down while boosting
let ghostTimer = 0;

// Persisted best score / best single chain.
const STORE_KEY = "driftjs.best";
const best = { score: 0, chain: 0 };
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  if (saved) {
    best.score = saved.score || 0;
    best.chain = saved.chain || 0;
  }
} catch (e) {
  /* ignore unavailable/corrupt storage */
}
const initialBest = best.score; // for one-time "NEW BEST!" detection this run
let bestBeaten = false;
function saveBest() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(best));
  } catch (e) {
    /* ignore */
  }
}

/* ----------------------------------------------------------------------------
 * Input
 * ------------------------------------------------------------------------- */
const input = {
  up: false,
  down: false,
  left: false,
  right: false,
  boost: false,
};

const KEY_MAP = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  KeyW: "up",
  KeyS: "down",
  KeyA: "left",
  KeyD: "right",
  ShiftLeft: "boost",
  ShiftRight: "boost",
};

let hasStarted = false; // hide the title once the player does anything

function markStarted() {
  if (hasStarted) return;
  hasStarted = true;
  headerRef.classList.add("hidden");
  clearTireMarksRef.classList.add("visible");
}

window.addEventListener("keydown", (e) => {
  const action = KEY_MAP[e.code];
  if (action) {
    e.preventDefault();
    input[action] = true;
    markStarted();
    audio.resume();
  }
  if (e.code === "KeyM") toggleMute();
  if (e.code === "KeyR") resetCar();
  if (e.code === "KeyC") clearTrails();
});

window.addEventListener("keyup", (e) => {
  const action = KEY_MAP[e.code];
  if (action) {
    e.preventDefault();
    input[action] = false;
  }
});

/* ----------------------------------------------------------------------------
 * Sizing — keep the canvas backing store in sync with its CSS size, and account
 * for high-DPI screens so everything stays crisp.
 * ------------------------------------------------------------------------- */
let dpr = Math.max(1, window.devicePixelRatio || 1);
let viewW = 0;
let viewH = 0;

function resize() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  viewW = viewportRef.clientWidth;
  viewH = viewportRef.clientHeight;

  // Preserve existing trail art across a resize by copying to a temp canvas.
  const saved = document.createElement("canvas");
  saved.width = trailsCanvas.width;
  saved.height = trailsCanvas.height;
  if (trailsCanvas.width && trailsCanvas.height) {
    saved.getContext("2d").drawImage(trailsCanvas, 0, 0);
  }

  for (const c of [trailsCanvas, gameCanvas]) {
    c.width = Math.round(viewW * dpr);
    c.height = Math.round(viewH * dpr);
    c.style.width = viewW + "px";
    c.style.height = viewH + "px";
  }

  // Draw everything in CSS pixels; the context scales to device pixels.
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (saved.width && saved.height) {
    tctx.save();
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.drawImage(saved, 0, 0, saved.width, saved.height, 0, 0, trailsCanvas.width, trailsCanvas.height);
    tctx.restore();
  }
}

function resetCar() {
  car.x = viewW / 2;
  car.y = viewH / 2;
  car.vx = 0;
  car.vy = 0;
  car.heading = -Math.PI / 2;
  car.angularVel = 0;
  endDrift();
}

/* ----------------------------------------------------------------------------
 * Physics — fixed timestep. Everything here runs at exactly STEP seconds.
 * ------------------------------------------------------------------------- */
const STEP = 1 / 120;

// Convert a "fraction kept per second" into the fraction kept per physics step.
// These are constant, so resolve them once instead of calling pow() every step.
const retainStep = (perSec) => Math.pow(perSec, STEP);
const DRAG_RETAIN = retainStep(TUNING.dragRetainPerSec);
const GRIP_BASE = retainStep(TUNING.gripBaseRetainPerSec);
const GRIP_OVERSTEER = retainStep(TUNING.gripPowerOversteer);
const BURNOUT_HOLD = retainStep(TUNING.burnoutHoldPerSec);

function updatePhysics() {
  // Local unit vectors for the car body
  const cos = Math.cos(car.heading);
  const sin = Math.sin(car.heading);
  // forward = (cos, sin), right = (-sin, cos)

  // Decompose velocity into forward & lateral (relative to where the car points)
  let forwardV = car.vx * cos + car.vy * sin;
  let lateralV = -car.vx * sin + car.vy * cos;

  const throttle = input.up ? 1 : 0;
  const braking = input.down ? 1 : 0;

  // Burnout: flooring it with the brake on (down+up) from low speed. The brake
  // holds the car to a slow crawl while the rear tires spin freely. Release the
  // brake and the built-up spin launches you still slipping; steer to pivot on
  // the spot (handled in the steering section below).
  const speedNow = Math.hypot(forwardV, lateralV);
  const burnout = throttle && braking && speedNow < TUNING.burnoutMaxSpeed;

  // --- Longitudinal forces ---
  // Wheelspin: high when flooring it from low speed, fading to 0 as the tires
  // gain enough rolling speed to hook up. Drives traction loss + smoke + sound.
  let wheelspin =
    throttle && forwardV >= 0
      ? clamp(1 - forwardV / TUNING.wheelspinSpeed, 0, 1)
      : 0;
  if (burnout) wheelspin = 1; // tires fully alight while braked

  if (burnout) {
    forwardV += TUNING.enginePower * TUNING.burnoutCreep * STEP; // a little leaks past the brake
    forwardV *= BURNOUT_HOLD; // brake torque holds it near rest
  } else {
    if (throttle) {
      // Spinning tires put less power down, so the launch slips then surges.
      const traction = 1 - wheelspin * TUNING.wheelspinSlip;
      forwardV += TUNING.enginePower * traction * STEP;
    }
    if (braking) {
      if (forwardV > 1) {
        forwardV -= TUNING.brakePower * STEP;
      } else {
        forwardV -= TUNING.reversePower * STEP;
      }
    }
    // Coasting rolling resistance (pulls speed toward 0)
    if (!throttle && !braking) {
      const rr = TUNING.rollingResist * STEP;
      if (forwardV > rr) forwardV -= rr;
      else if (forwardV < -rr) forwardV += rr;
      else forwardV = 0;
    }
  }
  // Boost — drains charge for a forward surge and a raised speed ceiling.
  nitro.active = input.boost && nitro.charge > 0;
  if (nitro.active) {
    forwardV += TUNING.boostPower * STEP;
    nitro.charge = Math.max(0, nitro.charge - TUNING.boostDrainPerSec * STEP);
  }

  // Air drag + clamp. After a boost, overspeed bleeds off via drag rather than
  // snapping back, so the ceiling only ever limits while actually boosting.
  forwardV *= DRAG_RETAIN;
  const ceiling = nitro.active
    ? TUNING.maxSpeed * TUNING.boostMaxSpeedFactor
    : Math.max(TUNING.maxSpeed, forwardV);
  forwardV = clamp(forwardV, -TUNING.maxReverse, ceiling);

  // --- Lateral grip (the soul of the drift) ---
  let gripRetain = GRIP_BASE;
  // The rear steps out (lower grip) on throttle steer or wheelspin off the line.
  const powerOversteer = (throttle && Math.abs(forwardV) > 120) || wheelspin > 0.5;
  if (powerOversteer) gripRetain = Math.max(gripRetain, GRIP_OVERSTEER);
  lateralV *= gripRetain;

  // Recompose world velocity from the (modified) forward & lateral components
  car.vx = forwardV * cos - lateralV * sin;
  car.vy = forwardV * sin + lateralV * cos;

  // --- Steering ---
  const steerInput = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let targetTurn;
  if (burnout) {
    // Pivot on the spot — authority comes from the spinning tires, not speed.
    targetTurn = steerInput * TUNING.burnoutTurnRate;
  } else {
    // Steering authority grows with speed then saturates, and flips in reverse.
    const speedAuthority = clamp(Math.abs(forwardV) / TUNING.steerSpeedRef, 0, 1);
    const dir = forwardV >= 0 ? 1 : -1;
    targetTurn = steerInput * TUNING.maxTurnRate * speedAuthority * dir;
  }

  // Self-stabilising yaw: the slide nudges the nose toward the velocity vector,
  // which is what makes the drift catchable rather than a spin-out.
  // d(lateralV)/dθ = -forwardV, so to bleed a slide off we steer with
  // sign(forwardV) * lateralV. This auto-counter-steer is what keeps it forgiving.
  const stabilise =
    clamp(lateralV / (Math.abs(forwardV) + 80), -1, 1) *
    Math.sign(forwardV || 1) *
    TUNING.slipYawAssist;

  // Ease angular velocity toward the target (gives steering a little weight)
  const target = targetTurn + stabilise;
  car.angularVel += (target - car.angularVel) * clamp(TUNING.turnResponse * STEP, 0, 1);
  car.heading += car.angularVel * STEP;

  // --- Integrate position with screen wrap ---
  car.x += car.vx * STEP;
  car.y += car.vy * STEP;
  if (car.x < 0) car.x += viewW;
  else if (car.x > viewW) car.x -= viewW;
  if (car.y < 0) car.y += viewH;
  else if (car.y > viewH) car.y -= viewH;

  // --- Derived quantities for rendering / audio / scoring ---
  car.forwardV = forwardV;
  car.lateralV = lateralV;
  car.speed = Math.hypot(car.vx, car.vy);
  // Slip angle: how far the velocity vector points away from the heading.
  car.slip = car.speed > 20 ? Math.abs(Math.atan2(lateralV, Math.abs(forwardV))) : 0;
  car.wheelspin = wheelspin;
  car.boosting = nitro.active;

  updateScoring();
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ----------------------------------------------------------------------------
 * Wheels — world positions of the four contact patches, used for skids & smoke.
 * ------------------------------------------------------------------------- */
function wheelPositions() {
  const cos = Math.cos(car.heading);
  const sin = Math.sin(car.heading);
  const fx = cos,
    fy = sin; // forward
  const rx = -sin,
    ry = cos; // right
  const f = TUNING.frontAxle;
  const r = -TUNING.rearAxle;
  const t = TUNING.trackHalf;
  return [
    { x: car.x + fx * f + rx * t, y: car.y + fy * f + ry * t, rear: false }, // FR
    { x: car.x + fx * f - rx * t, y: car.y + fy * f - ry * t, rear: false }, // FL
    { x: car.x + fx * r + rx * t, y: car.y + fy * r + ry * t, rear: true }, // RR
    { x: car.x + fx * r - rx * t, y: car.y + fy * r - ry * t, rear: true }, // RL
  ];
}

/* ----------------------------------------------------------------------------
 * Skid marks — drawn as connected segments on the persistent trails canvas.
 * We remember each wheel's previous position and stroke a line to the new one,
 * so marks are smooth and continuous instead of dotty rectangles.
 * ------------------------------------------------------------------------- */
let prevWheels = null;

function drawSkids() {
  const wheels = wheelPositions();

  // Lay marks when sliding, spinning the tires off the line, or locking the brakes.
  const sliding = car.slip > TUNING.skidSlipThreshold && car.speed > 30;
  const burnout = car.wheelspin > 0.3;
  const lockup = input.down && car.forwardV > 30;

  if ((sliding || burnout || lockup) && prevWheels) {
    // Opacity scales with how hard we're sliding / spinning.
    const intensity = sliding
      ? clamp((car.slip - TUNING.skidSlipThreshold) / 0.6, 0.15, 1)
      : burnout
      ? clamp(car.wheelspin, 0.3, 0.9)
      : 0.5;

    // Rubber is always near-black — it's a clean record of the line you carved.
    tctx.lineCap = "round";
    tctx.strokeStyle = `hsl(0 0% 12% / ${(0.18 + intensity * 0.32).toFixed(3)})`;
    tctx.lineWidth = 3.2;
    tctx.beginPath();
    for (let i = 0; i < wheels.length; i++) {
      // Rear tires mark harder; fronts only when really sliding.
      if (!wheels[i].rear && car.slip < TUNING.skidSlipThreshold + 0.15) continue;
      const p = prevWheels[i];
      const c = wheels[i];
      // Skip the seam when the car wraps across an edge.
      if (Math.hypot(c.x - p.x, c.y - p.y) > 60) continue;
      tctx.moveTo(p.x, p.y);
      tctx.lineTo(c.x, c.y);
    }
    tctx.stroke();
  }

  prevWheels = wheels;
}

/* ----------------------------------------------------------------------------
 * Particles — tire smoke. Soft, growing, fading puffs from the rear wheels.
 * ------------------------------------------------------------------------- */
const smoke = [];
const MAX_SMOKE = 400;

function spawnEffects() {
  const sliding = car.slip > TUNING.smokeSlipThreshold && car.speed > 60;
  const spinning = car.wheelspin > 0.35;
  if (sliding || spinning) {
    const wheels = wheelPositions();
    const amount = sliding
      ? clamp(Math.round((car.slip - TUNING.smokeSlipThreshold) * 6), 1, 3)
      : clamp(Math.round(car.wheelspin * 3), 1, 3);
    for (const w of wheels) {
      if (!w.rear) continue;
      for (let i = 0; i < amount; i++) {
        if (smoke.length >= MAX_SMOKE) smoke.shift();
        smoke.push({
          x: w.x + rand(-3, 3),
          y: w.y + rand(-3, 3),
          vx: car.vx * 0.08 + rand(-18, 18),
          vy: car.vy * 0.08 + rand(-18, 18),
          life: 0,
          maxLife: rand(0.5, 1.1),
          size: rand(5, 9),
          grow: rand(28, 46),
          mult: score.chainActive ? score.multiplier : 1,
        });
      }
    }
  }
}

// A one-shot puff of extra smoke from the rear wheels — used to punch tier-ups
// and donuts so the moment feels like it kicks up dust.
function spawnSmokeBurst(n) {
  const wheels = wheelPositions();
  for (const w of wheels) {
    if (!w.rear) continue;
    for (let i = 0; i < n; i++) {
      if (smoke.length >= MAX_SMOKE) smoke.shift();
      smoke.push({
        x: w.x + rand(-4, 4),
        y: w.y + rand(-4, 4),
        vx: car.vx * 0.05 + rand(-42, 42),
        vy: car.vy * 0.05 + rand(-42, 42),
        life: 0,
        maxLife: rand(0.5, 1.2),
        size: rand(5, 10),
        grow: rand(34, 54),
        mult: score.chainActive ? score.multiplier : 1,
      });
    }
  }
}

function updateSmoke(dt) {
  for (let i = smoke.length - 1; i >= 0; i--) {
    const p = smoke[i];
    p.life += dt;
    if (p.life >= p.maxLife) {
      smoke.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.94;
    p.vy *= 0.94;
    p.size += p.grow * dt;
  }
}

// The combo "heat" ramp — shared by the smoke and the under-car glow so the
// whole scene reads in one cohesive palette. Colour is *earned*: a casual x1
// slide stays neutral grey (ordinary tire smoke), and once you bank a tier the
// hue sweeps a vibrant arc that pops on the white background — blue at x2 → cyan
// → green → yellow → orange → red → hot magenta at the cap. Returns whether the
// colour is active, the eased progress `ct` (0..1 across x2..max), and the hue.
function comboRamp(mult) {
  const colored = mult > 1;
  const ct = clamp((mult - 2) / (TUNING.driftMaxMultiplier - 2), 0, 1);
  const hue = (((210 - ct * 250) % 360) + 360) % 360;
  return { colored, ct, hue };
}

function drawSmoke() {
  for (const p of smoke) {
    const t = p.life / p.maxLife;
    const { colored, ct, hue } = comboRamp(p.mult);
    if (!colored) {
      // Neutral grey for casual / pre-tier slides — reads as ordinary smoke.
      const shade = Math.round(228 - t * 55);
      gctx.fillStyle = `rgba(${shade},${shade},${shade},${((1 - t) * 0.32).toFixed(3)})`;
    } else {
      // Higher combo = more saturated and a touch darker, so the colour really
      // pops against white. Fade only via alpha so it doesn't wash out with age.
      const sat = 45 + ct * 50;
      const light = 68 - ct * 16;
      const alpha = (1 - t) * (0.3 + ct * 0.15);
      gctx.fillStyle = `hsl(${hue.toFixed(1)} ${sat.toFixed(0)}% ${light.toFixed(0)}% / ${alpha.toFixed(3)})`;
    }
    gctx.beginPath();
    gctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    gctx.fill();
  }
}

/* ----------------------------------------------------------------------------
 * Speed lines — anime-style streaks from screen centre at high speed / on boost.
 * ------------------------------------------------------------------------- */
function drawSpeedLines() {
  const base = clamp((car.speed - 380) / 240, 0, 1);
  const intensity = clamp(base + (car.boosting ? 0.6 : 0), 0, 1.4);
  if (intensity < 0.05) return;

  const cx = viewW / 2;
  const cy = viewH / 2;
  const maxR = Math.hypot(cx, cy);
  const n = Math.round(8 + intensity * 26);
  gctx.lineCap = "round";
  for (let i = 0; i < n; i++) {
    const ang = rand(0, Math.PI * 2);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const r1 = maxR * rand(0.62, 0.95);
    const len = rand(30, 120) * intensity;
    const a = rand(0.04, 0.13) * Math.min(intensity, 1);
    // Boost tints the streaks orange; otherwise dark, for the light background.
    gctx.strokeStyle = car.boosting
      ? `hsl(32 100% 55% / ${a + 0.05})`
      : `hsl(0 0% 25% / ${a})`;
    gctx.lineWidth = rand(1.5, 3);
    gctx.beginPath();
    gctx.moveTo(cx + ca * r1, cy + sa * r1);
    gctx.lineTo(cx + ca * (r1 + len), cy + sa * (r1 + len));
    gctx.stroke();
  }
}

/* ----------------------------------------------------------------------------
 * Score popups — floating "+1,234" text.
 * ------------------------------------------------------------------------- */
const popups = [];

function addPopup(text, x, y, color) {
  popups.push({ text, x, y, life: 0, maxLife: 1.3, color });
}

function updatePopups(dt) {
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    p.life += dt;
    p.y -= 38 * dt;
    if (p.life >= p.maxLife) popups.splice(i, 1);
  }
}

function drawPopups() {
  gctx.textAlign = "center";
  gctx.textBaseline = "middle";
  for (const p of popups) {
    const t = p.life / p.maxLife;
    const alpha = 1 - t * t;
    const scale = 1 + t * 0.25;
    gctx.save();
    gctx.translate(p.x, p.y);
    gctx.scale(scale, scale);
    gctx.font = '700 22px "Google Sans", "Google Sans Text", system-ui, sans-serif';
    gctx.fillStyle = p.color.replace("ALPHA", alpha.toFixed(2));
    gctx.fillText(p.text, 0, 0);
    gctx.restore();
  }
}

/* ----------------------------------------------------------------------------
 * Drift scoring — points accrue while you hold a slide; the longer the chain
 * the higher the multiplier. Break the drift and the chain is banked.
 * ------------------------------------------------------------------------- */
const score = {
  total: 0,
  chainActive: false,
  chainPoints: 0, // points banked when the chain ends (already multiplied)
  driftTime: 0, // seconds spent actually sliding in this chain (drives multiplier)
  multiplier: 1,
  grace: 0, // countdown; the chain banks when this hits 0
  spin: 0, // accumulated signed heading rotation while drifting (drives donuts)
  donutCount: 0, // full 360s landed in this chain (escalates the reward)
  linkCount: 0, // switchback transitions landed in this chain
};

// Heading at the previous drift step, for accumulating donut rotation.
let lastSpinHeading = null;
// Last confirmed slide side (+1/-1); a flip while the chain is alive = a LINK.
let driftDir = 0;

function updateScoring() {
  const isDrifting = car.slip > TUNING.driftSlipThreshold && car.speed > 90;

  if (isDrifting) {
    if (!score.chainActive) {
      score.chainActive = true;
      driftMeterRef.classList.add("active");
    }
    score.grace = TUNING.driftGraceSeconds; // refresh the link window
    score.driftTime += STEP;

    // Multiplier climbs one tier per driftTierSeconds of held drift, capped.
    const tier = Math.min(
      TUNING.driftMaxMultiplier,
      1 + Math.floor(score.driftTime / TUNING.driftTierSeconds)
    );
    if (tier > score.multiplier) bumpMultiplier(tier); // tier-up feedback
    score.multiplier = tier;

    // Points accrue already multiplied, so long linked chains compound hard.
    const gain = car.slip * car.speed * TUNING.driftScoreRate * STEP;
    score.chainPoints += gain * score.multiplier;

    // Drifting charges the boost meter — but not while you're spending it, so
    // you can't hold Shift through a drift and boost forever on an empty meter.
    if (!input.boost) {
      nitro.charge = Math.min(1, nitro.charge + car.slip * TUNING.boostFillRate * STEP);
    }

    // Donut detection — accumulate signed heading rotation while sliding; every
    // full turn in one direction lands a donut. Flicking back and forth unwinds
    // the accumulator, so only sustained same-way spins pay out.
    if (lastSpinHeading === null) lastSpinHeading = car.heading;
    let dh = car.heading - lastSpinHeading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh)); // shortest signed delta
    score.spin += dh;
    lastSpinHeading = car.heading;
    if (Math.abs(score.spin) >= Math.PI * 2) {
      score.spin -= Math.sign(score.spin) * Math.PI * 2;
      awardDonut();
    }

    // Switchback LINK — once the car is clearly sliding one way, a flip to the
    // other side without dropping the chain is a transition (the heart of drift
    // flow). driftDir survives the brief straighten between flicks (we only
    // reset it when the chain banks), so the opposite slide reads as a link.
    const side = Math.sign(car.lateralV);
    if (Math.abs(car.lateralV) > TUNING.linkSlideSpeed && side !== 0) {
      if (driftDir !== 0 && side !== driftDir) awardLink();
      driftDir = side;
    }
  } else if (score.chainActive) {
    // Not sliding right now, but the chain survives through the grace window so
    // transitions (flick left↔right, brief straightens) keep the combo alive.
    lastSpinHeading = null; // resume rotation tracking cleanly on the next slide
    score.grace -= STEP;
    if (score.grace <= 0) endDrift();
  }
}

// A landed donut: escalating bonus, a puff, a vignette pop and a rising chime.
function awardDonut() {
  score.donutCount++;
  const tierBonus = Math.min(score.donutCount, 5); // first five donuts ramp the payout
  score.chainPoints += 750 * score.multiplier * tierBonus;
  nitro.charge = Math.min(1, nitro.charge + 0.15);
  const label = score.donutCount > 1 ? `DONUT x${score.donutCount}!` : "DONUT!";
  addPopup(label, car.x, car.y - 60, "hsl(280 70% 55% / ALPHA)");
  spawnSmokeBurst(14);
  spawnRing("hsl(280 70% 60% / ALPHA)", 115, 5);
  zoomPunch = Math.max(zoomPunch, 1);
  audio.chime(score.donutCount);
}

// A landed switchback: bonus, a quick shockwave and a snappy rising blip.
function awardLink() {
  score.linkCount++;
  const tierBonus = Math.min(score.linkCount, 6); // chained links ramp the payout
  score.chainPoints += 400 * score.multiplier * tierBonus;
  nitro.charge = Math.min(1, nitro.charge + 0.08);
  const label = score.linkCount > 1 ? `LINK x${score.linkCount}!` : "LINK!";
  addPopup(label, car.x, car.y - 46, "hsl(190 90% 45% / ALPHA)");
  spawnRing("hsl(190 90% 50% / ALPHA)", 70, 3);
  zoomPunch = Math.max(zoomPunch, 0.55);
  audio.link(score.linkCount);
}

// Pulse the multiplier readout and pop a callout whenever a new tier is reached.
function bumpMultiplier(tier) {
  driftMeterRef.classList.remove("bump");
  void driftMeterRef.offsetWidth; // restart the CSS animation
  driftMeterRef.classList.add("bump");
  if (tier >= 2) {
    addPopup(`x${tier}!`, car.x, car.y - 52, "hsl(35 100% 45% / ALPHA)");
    // Climbing a tier should *feel* like a level-up: a beat of slow motion, a
    // shockwave ring, a kick of dust and a bass thump that deepens with tier.
    slowmo = 0.16;
    spawnRing("hsl(35 100% 55% / ALPHA)", 95, 4);
    zoomPunch = Math.max(zoomPunch, 1);
    spawnSmokeBurst(10);
    audio.thump(clamp(tier / TUNING.driftMaxMultiplier, 0.35, 1));
  }
}

function endDrift() {
  if (!score.chainActive) return;
  const banked = Math.round(score.chainPoints);
  if (banked > 0) {
    score.total += banked;
    const label =
      banked > 12000 ? "INSANE!" : banked > 5000 ? "SICK DRIFT!" : banked > 1500 ? "NICE!" : "";
    addPopup(
      `+${banked.toLocaleString()}${label ? "  " + label : ""}`,
      car.x,
      car.y - 34,
      "rgba(20,20,20,ALPHA)"
    );
    audio.cashout(banked); // rising arpeggio that grows with the haul

    // Track best score / best single chain, and celebrate beating the record.
    if (banked > best.chain) best.chain = banked;
    if (score.total > best.score) best.score = score.total;
    saveBest();
    if (!bestBeaten && initialBest > 0 && score.total > initialBest) {
      bestBeaten = true;
      addPopup("NEW BEST!", car.x, car.y - 70, "hsl(140 65% 38% / ALPHA)");
    }
  }
  score.chainActive = false;
  score.chainPoints = 0;
  score.driftTime = 0;
  score.multiplier = 1;
  score.spin = 0;
  score.donutCount = 0;
  score.linkCount = 0;
  lastSpinHeading = null;
  driftDir = 0;
  driftMeterRef.classList.remove("active");
}

/* ----------------------------------------------------------------------------
 * Camera — screen shake (speed + drift driven) and a dynamic zoom that pushes in
 * on hard drifts and pulls out at speed / on boost. Both ride the same viewport
 * transform. Zoom scales about the viewport centre (the default origin): the car
 * roams freely and wraps across edges, so a car-anchored origin would jolt the
 * view on every wrap — centre-anchored stays smooth.
 * ------------------------------------------------------------------------- */
let shake = 0;
let zoom = 1;
let zoomPunch = 0; // 0..1 transient kick, fired on milestones, decays fast

function updateShake(dt) {
  const target =
    clamp(car.slip * car.speed * 0.006, 0, 7) +
    clamp(car.speed / 620, 0, 1) * 1.5 +
    (car.boosting ? 2.5 : 0);
  shake += (target - shake) * clamp(8 * dt, 0, 1);
}

function updateCamera(dt) {
  // Gentle pull-OUT at speed / on boost only — this pulls the off-centre car
  // inward (safe) and reads as speed. The "kick in" emphasis is the discrete
  // zoomPunch below, fired on tier-ups / donuts / links.
  const speedOut =
    clamp((car.speed - 380) / 240, 0, 1) * TUNING.camZoomSpeed +
    (car.boosting ? TUNING.camZoomBoost : 0);
  const target = 1 - speedOut;
  zoom += (target - zoom) * clamp(TUNING.camEase * dt, 0, 1);
  if (zoomPunch > 0) zoomPunch = Math.max(0, zoomPunch - dt / 0.22); // ~0.22s settle
}

function applyShake() {
  const z = zoom + zoomPunch * TUNING.camZoomPunch;
  const shaking = shake >= 0.15;
  const zooming = Math.abs(z - 1) > 0.002;
  if (!shaking && !zooming) {
    viewportRef.style.transform = "";
    return;
  }
  const dx = shaking ? rand(-shake, shake) : 0;
  const dy = shaking ? rand(-shake, shake) : 0;
  // Scale about the viewport centre (default origin) — robust to the car wrapping.
  viewportRef.style.transform = `translate(${dx}px, ${dy}px) scale(${z.toFixed(4)})`;
}

/* ----------------------------------------------------------------------------
 * Boost afterimages — while boosting, lay down fading silhouettes of the car so
 * the surge reads as a streak of speed.
 * ------------------------------------------------------------------------- */
function updateGhosts(dt) {
  if (car.boosting) {
    ghostTimer -= dt;
    if (ghostTimer <= 0) {
      ghostTimer = 0.035;
      ghosts.push({ x: car.x, y: car.y, heading: car.heading, life: 0, maxLife: 0.36 });
      if (ghosts.length > 40) ghosts.shift();
    }
  }
  for (let i = ghosts.length - 1; i >= 0; i--) {
    ghosts[i].life += dt;
    if (ghosts[i].life >= ghosts[i].maxLife) ghosts.splice(i, 1);
  }
}

function drawGhosts() {
  if (!carAsset.complete || !carAsset.naturalWidth) return;
  for (const g of ghosts) {
    const a = (1 - g.life / g.maxLife) * 0.32;
    gctx.save();
    gctx.globalAlpha = a;
    gctx.translate(g.x, g.y);
    gctx.rotate(g.heading);
    gctx.drawImage(
      carAsset,
      -TUNING.carLength / 2,
      -TUNING.carWidth / 2,
      TUNING.carLength,
      TUNING.carWidth
    );
    gctx.restore();
  }
}

// Shockwave rings — a milestone bursts a coloured ring outward from the car. It
// stays put in the world (like a real shockwave) and expands as it fades, which
// reads as a celebratory pop rather than a "damage" edge vignette closing in.
function spawnRing(color, maxRadius, lineWidth) {
  rings.push({ x: car.x, y: car.y, life: 0, maxLife: 0.45, color, maxRadius, lineWidth });
}

function updateRings(dt) {
  for (let i = rings.length - 1; i >= 0; i--) {
    rings[i].life += dt;
    if (rings[i].life >= rings[i].maxLife) rings.splice(i, 1);
  }
}

function drawRings() {
  for (const r of rings) {
    const t = r.life / r.maxLife;
    const e = 1 - (1 - t) * (1 - t); // ease-out: fast then settling
    const radius = 6 + r.maxRadius * e;
    const a = (1 - t) * 0.65;
    gctx.strokeStyle = r.color.replace("ALPHA", a.toFixed(3));
    gctx.lineWidth = r.lineWidth * (1 - t * 0.7);
    gctx.beginPath();
    gctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
    gctx.stroke();
  }
}

/* ----------------------------------------------------------------------------
 * Car rendering — the original car.png drawn on the canvas, with a drift glow.
 * ------------------------------------------------------------------------- */
function drawCar() {
  // Helper to draw the car centred at a given point (used for wrap-around ghosts)
  const paint = (x, y) => {
    gctx.save();
    gctx.translate(x, y);
    gctx.rotate(car.heading);

    // Drift glow under the car — stronger the harder you slide, and tinted by the
    // same earned combo ramp as the smoke so the car sits inside its own colour.
    // Casual x1 slides get a neutral warm glow rather than an odd cool tint.
    if (car.slip > TUNING.skidSlipThreshold) {
      const g = clamp(car.slip, 0, 1.2);
      const { colored, hue } = comboRamp(score.chainActive ? score.multiplier : 1);
      const gh = colored ? hue : 40; // neutral warm at x1
      const gs = colored ? 100 : 55; // less saturated when neutral
      const grad = gctx.createRadialGradient(0, 0, 2, 0, 0, 38);
      grad.addColorStop(0, `hsl(${gh.toFixed(1)} ${gs}% 60% / ${0.25 * g})`);
      grad.addColorStop(1, `hsl(${gh.toFixed(1)} ${gs}% 60% / 0)`);
      gctx.fillStyle = grad;
      gctx.beginPath();
      gctx.arc(0, 0, 38, 0, Math.PI * 2);
      gctx.fill();
    }

    if (carAsset.complete && carAsset.naturalWidth) {
      // A soft drop shadow cast from the car's actual silhouette (not its
      // bounding box) — the canvas blurs the image's non-transparent pixels.
      gctx.shadowColor = "rgba(0, 0, 0, 0.35)";
      gctx.shadowBlur = 8;
      gctx.shadowOffsetX = 0;
      gctx.shadowOffsetY = 3;
      // car.png is drawn pointing along +x (the heading direction)
      gctx.drawImage(
        carAsset,
        -TUNING.carLength / 2,
        -TUNING.carWidth / 2,
        TUNING.carLength,
        TUNING.carWidth
      );
      gctx.shadowColor = "transparent";
      gctx.shadowBlur = 0;
      gctx.shadowOffsetY = 0;
    } else {
      gctx.fillStyle = "#111";
      roundRect(gctx, -TUNING.carLength / 2, -TUNING.carWidth / 2, TUNING.carLength, TUNING.carWidth, 5);
      gctx.fill();
    }
    gctx.restore();
  };

  paint(car.x, car.y);
  // Draw wrap-around ghosts near edges so the car never visually pops.
  const m = 50;
  if (car.x < m) paint(car.x + viewW, car.y);
  else if (car.x > viewW - m) paint(car.x - viewW, car.y);
  if (car.y < m) paint(car.x, car.y + viewH);
  else if (car.y > viewH - m) paint(car.x, car.y - viewH);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ----------------------------------------------------------------------------
 * Audio — fully synthesized with the Web Audio API. No asset files.
 *   - Engine: two sawtooths (one a fifth up) through a low-pass; pitch follows
 *     speed, and wheelspin flares the revs off the line.
 *   - Screech: looping noise through three resonant bands (roar / squeal /
 *     shriek) plus a fast amplitude tremolo for grit; gain tracks the slip.
 * Muted until the first input (browsers block audio before a gesture anyway).
 * ------------------------------------------------------------------------- */
const audio = {
  ctx: null,
  enabled: true,
  started: false,

  resume() {
    if (!this.enabled) return;
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  },

  init() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      this.ctx = ctx;

      // Master
      this.master = ctx.createGain();
      this.master.gain.value = this.enabled ? 0.5 : 0;
      this.master.connect(ctx.destination);

      // --- Engine ---
      this.engineGain = ctx.createGain();
      this.engineGain.gain.value = 0.0;
      this.engineFilter = ctx.createBiquadFilter();
      this.engineFilter.type = "lowpass";
      this.engineFilter.frequency.value = 700;
      this.engineGain.connect(this.engineFilter);
      this.engineFilter.connect(this.master);

      this.osc1 = ctx.createOscillator();
      this.osc1.type = "sawtooth";
      this.osc2 = ctx.createOscillator();
      this.osc2.type = "sawtooth";
      this.osc2.detune.value = 12;
      this.osc1.connect(this.engineGain);
      this.osc2.connect(this.engineGain);
      this.osc1.start();
      this.osc2.start();

      // --- Tire screech ---
      // A skid is *resonant noise*, not a tone (a tone sounds like an RC motor)
      // and not broadband hiss (that sounds like an extinguisher). We run looping
      // noise through three resonant bandpasses — a low "roar", a mid "squeal",
      // and a bright "shriek" — plus a fast amplitude tremolo for the grit.
      this.screechGain = ctx.createGain();
      this.screechGain.gain.value = 0; // gate, driven by slip in update()
      this.screechGain.connect(this.master);

      // Inner bus carries the always-on roughness tremolo; the gate above
      // silences it when we're not sliding.
      this.screechBus = ctx.createGain();
      this.screechBus.gain.value = 0.6;
      this.screechBus.connect(this.screechGain);

      // Grit tremolo — a *subtle, fast* amplitude shimmer for rubber texture.
      // Keep it shallow & high-rate so it reads as roughness, not a putt-putt.
      this.gritLFO = ctx.createOscillator();
      this.gritLFO.type = "sine";
      this.gritLFO.frequency.value = 62;
      this.gritDepth = ctx.createGain();
      this.gritDepth.gain.value = 0.1;
      this.gritLFO.connect(this.gritDepth);
      this.gritDepth.connect(this.screechBus.gain);
      this.gritLFO.start();

      // Looping white noise — the raw material for the skid.
      const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.noise = ctx.createBufferSource();
      this.noise.buffer = noiseBuf;
      this.noise.loop = true;

      // Low "roar" resonance
      this.roarFilter = ctx.createBiquadFilter();
      this.roarFilter.type = "bandpass";
      this.roarFilter.frequency.value = 520;
      this.roarFilter.Q.value = 5;
      const roarGain = ctx.createGain();
      roarGain.gain.value = 0.8; // low body so it isn't all high "sss"
      this.noise.connect(this.roarFilter);
      this.roarFilter.connect(roarGain);
      roarGain.connect(this.screechBus);

      // Mid "squeal" resonance — the main body of the screech, kept in the
      // low-mids so it reads as rubber, not sibilance.
      this.screechFilter = ctx.createBiquadFilter();
      this.screechFilter.type = "bandpass";
      this.screechFilter.frequency.value = 1150;
      this.screechFilter.Q.value = 8;
      const squealGain = ctx.createGain();
      squealGain.gain.value = 1.0;
      this.noise.connect(this.screechFilter);
      this.screechFilter.connect(squealGain);
      squealGain.connect(this.screechBus);

      // A little brightness on top — just enough bite, not a whistle/"sss".
      this.shriekFilter = ctx.createBiquadFilter();
      this.shriekFilter.type = "bandpass";
      this.shriekFilter.frequency.value = 1900;
      this.shriekFilter.Q.value = 8;
      const shriekGain = ctx.createGain();
      shriekGain.gain.value = 0.28;
      this.noise.connect(this.shriekFilter);
      this.shriekFilter.connect(shriekGain);
      shriekGain.connect(this.screechBus);

      // Boost "wind" — low-passed noise that swells while boosting.
      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = "lowpass";
      this.windFilter.frequency.value = 650;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      this.noise.connect(this.windFilter);
      this.windFilter.connect(this.windGain);
      this.windGain.connect(this.master);

      this.noise.start();

      this.started = true;
    } catch (e) {
      this.enabled = false;
    }
  },

  update() {
    if (!this.started || !this.ctx) return;
    const now = this.ctx.currentTime;
    const speedN = clamp(Math.abs(car.forwardV) / TUNING.maxSpeed, 0, 1);
    const revving = input.up || input.down;

    // Engine "rpm": rises with speed, but wheelspin flares the revs without the
    // car actually moving — that's the off-the-line scream. Spin reacts faster.
    const rpm = clamp(speedN + car.wheelspin * 0.4, 0, 1);
    const freq = 55 + rpm * 165;
    this.osc1.frequency.setTargetAtTime(freq, now, car.wheelspin > 0.3 ? 0.02 : 0.05);
    this.osc2.frequency.setTargetAtTime(freq * 1.5, now, 0.05);
    this.engineFilter.frequency.setTargetAtTime(500 + rpm * 1800, now, 0.05);
    const engVol = 0.06 + rpm * 0.16 + (revving ? 0.05 : 0);
    this.engineGain.gain.setTargetAtTime(engVol, now, 0.08);

    // Screech tracks both lateral slip and wheelspin off the line.
    const slipN = clamp((car.slip - TUNING.skidSlipThreshold) / 0.6, 0, 1) * clamp(car.speed / 120, 0, 1);
    const screechN = Math.max(slipN, car.wheelspin * 0.7);
    // Snappy attack the instant the tires break loose; short release so it cuts
    // off promptly when you straighten out.
    const atk = screechN > 0.05 ? 0.012 : 0.022;
    this.screechGain.gain.setTargetAtTime(screechN * 0.5, now, atk);
    // Resonances climb the harder you slide (brighter, more frantic).
    this.roarFilter.frequency.setTargetAtTime(480 + screechN * 220, now, 0.05);
    this.screechFilter.frequency.setTargetAtTime(1050 + screechN * 700, now, 0.05);
    this.shriekFilter.frequency.setTargetAtTime(1750 + screechN * 900, now, 0.05);

    // Boost wind swells in while boosting.
    this.windGain.gain.setTargetAtTime(car.boosting ? 0.18 : 0, now, 0.06);
  },

  // --- One-shot juice cues (no-ops until the engine has started) ---

  // Deep bass drop for tier-ups — deepens as the multiplier climbs.
  thump(intensity = 1) {
    if (!this.started || !this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(150, now);
    o.frequency.exponentialRampToValueAtTime(46, now + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.5 * intensity, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    o.connect(g);
    g.connect(this.master);
    o.start(now);
    o.stop(now + 0.34);
  },

  // Bright bell triad for donuts — pitch climbs with consecutive donuts.
  chime(step = 1) {
    if (!this.started || !this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const base = 520 * Math.pow(2, Math.min(step - 1, 6) / 12);
    [0, 4, 7].forEach((semi, k) => {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = base * Math.pow(2, semi / 12);
      const g = ctx.createGain();
      const t0 = now + k * 0.05;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.24, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      o.connect(g);
      g.connect(this.master);
      o.start(t0);
      o.stop(t0 + 0.4);
    });
  },

  // Rising arpeggio when a chain banks — longer & higher the bigger the haul.
  cashout(banked) {
    if (!this.started || !this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const notes = banked > 5000 ? [0, 4, 7, 12, 16] : banked > 1500 ? [0, 4, 7, 12] : [0, 7];
    notes.forEach((semi, k) => {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = 440 * Math.pow(2, semi / 12);
      const g = ctx.createGain();
      const t0 = now + k * 0.06;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
      o.connect(g);
      g.connect(this.master);
      o.start(t0);
      o.stop(t0 + 0.34);
    });
  },

  // Snappy rising blip for switchback links — pitch climbs with the link count.
  link(step = 1) {
    if (!this.started || !this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const base = 600 * Math.pow(2, Math.min(step - 1, 8) / 12);
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(base, now);
    o.frequency.exponentialRampToValueAtTime(base * 1.5, now + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.2, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    o.connect(g);
    g.connect(this.master);
    o.start(now);
    o.stop(now + 0.2);
  },

  setEnabled(on) {
    this.enabled = on;
    if (this.master) {
      this.master.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.02);
    }
  },
};

function toggleMute() {
  audio.resume();
  audio.setEnabled(!audio.enabled);
  muteToggleRef.classList.toggle("muted", !audio.enabled);
}

/* ----------------------------------------------------------------------------
 * HUD
 * ------------------------------------------------------------------------- */
let hudAccumulator = 0;
function updateHud(dt) {
  hudAccumulator += dt;
  if (hudAccumulator < 0.05) return; // ~20Hz is plenty for text
  hudAccumulator = 0;

  speedValueRef.textContent = Math.round((Math.abs(car.forwardV) / TUNING.maxSpeed) * 240);
  scoreValueRef.textContent = score.total.toLocaleString();
  bestValueRef.textContent = best.score.toLocaleString();

  boostFillRef.style.width = (nitro.charge * 100).toFixed(0) + "%";
  boostRef.classList.toggle("ready", nitro.charge >= 1);
  boostRef.classList.toggle("active", nitro.active);

  if (score.chainActive) {
    driftPointsRef.textContent = Math.round(score.chainPoints).toLocaleString();
    driftMultiplierRef.textContent = "x" + score.multiplier;
  }
}

/* ----------------------------------------------------------------------------
 * Main loop — fixed-timestep physics, render once per frame.
 * ------------------------------------------------------------------------- */
let acc = 0;
let last;

function frame(now) {
  if (last === undefined) last = now;
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1; // avoid spiral of death after a tab is backgrounded

  // Tier-up slow motion: ease the sim's time scale down for a beat, then back.
  if (slowmo > 0) slowmo = Math.max(0, slowmo - dt);
  const targetScale = slowmo > 0 ? 0.78 : 1;
  timeScale += (targetScale - timeScale) * clamp(12 * dt, 0, 1);
  const sdt = dt * timeScale;

  acc += sdt;
  while (acc >= STEP) {
    updatePhysics();
    drawSkids(); // sampled at physics rate for smooth continuous marks
    acc -= STEP;
  }

  // Per-frame updates (slowed effects use sdt; visual decays use real dt)
  spawnEffects();
  updateSmoke(sdt);
  updatePopups(sdt);
  updateShake(sdt);
  updateCamera(dt);
  updateGhosts(dt);
  updateRings(dt);
  updateHud(dt);
  audio.update();

  // Render the dynamic layer
  gctx.clearRect(0, 0, viewW, viewH);
  drawSmoke();
  drawGhosts(); // boost afterimages behind the car
  drawCar();
  drawRings(); // shockwave bursts on tier-ups / donuts / links
  drawSpeedLines();
  drawPopups();
  applyShake();

  requestAnimationFrame(frame);
}

/* ----------------------------------------------------------------------------
 * Buttons & touch controls
 * ------------------------------------------------------------------------- */
function clearTrails() {
  tctx.save();
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, trailsCanvas.width, trailsCanvas.height);
  tctx.restore();
}

clearTireMarksRef.addEventListener("click", clearTrails);
muteToggleRef.addEventListener("click", toggleMute);

function bindHold(selector, action) {
  const el = document.querySelector(selector);
  if (!el) return;
  const press = (e) => {
    e.preventDefault();
    input[action] = true;
    markStarted();
    audio.resume();
  };
  const release = (e) => {
    e.preventDefault();
    input[action] = false;
  };
  el.addEventListener("touchstart", press, { passive: false });
  el.addEventListener("touchend", release);
  el.addEventListener("touchcancel", release);
  el.addEventListener("mousedown", press);
  el.addEventListener("mouseup", release);
  el.addEventListener("mouseleave", release);
}

// Mobile detection / setup
let hasTouchScreen = false;
if ("maxTouchPoints" in navigator) hasTouchScreen = navigator.maxTouchPoints > 0;

if (hasTouchScreen) {
  instructionsRef.textContent = "Use the touch controls to drift!";
  mobileControlsRef.style.display = "flex";
  window.oncontextmenu = (e) => {
    e.preventDefault();
    return false;
  };
  bindHold(".arrow-up", "up");
  bindHold(".arrow-down", "down");
  bindHold(".arrow-left", "left");
  bindHold(".arrow-right", "right");
  bindHold(".boost-btn", "boost");
} else {
  instructionsRef.innerHTML =
    "WASD / arrows to drive &middot; Shift to boost &middot; M mute &middot; R reset &middot; C clear";
}

/* ----------------------------------------------------------------------------
 * Utilities
 * ------------------------------------------------------------------------- */
function rand(min, max) {
  return min + Math.random() * (max - min);
}

/* ----------------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------------- */
window.addEventListener("resize", resize);
resize();
resetCar();
requestAnimationFrame(frame);
