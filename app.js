/* ============================================================
   360° Cylindrical Panorama Viewer — Phase 2
   Flat "on the floor" navigation arrows.
   ============================================================ */

/* ---------- Panorama graph ----------
   Add each new panorama here.
   - image:  path to the strip
   - name:   shown in the arrows' tooltip
   - yaw:    starting direction when this panorama loads (radians)
   - links:  array of { target, atYaw }
             atYaw is the direction (radians) in THIS panorama
             where the arrow to the target should sit.
   ----------------------------------- */
const panoramas = {
  pano1: {
    id: "pano1",
    name: "Bedroom — Doorway",
    image: "panoramas/pano1.jpg",
    yaw: 0,
    links: [
      { target: "pano2", atYaw: Math.PI },   // arrow behind you
    ],
  },
  pano2: {
    id: "pano2",
    name: "Bedroom — Window",
    image: "panoramas/pano2.jpg",
    yaw: Math.PI,
    links: [
      { target: "pano1", atYaw: 0 },         // arrow in front
    ],
  },
};

const START_PANO = "pano1";

/* ---------- Config ---------- */

let yaw = 0;
let pitch = 0;
const BASE_FOV = 75;

const CYLINDER_HEIGHT_RATIO = 0.85;

const DRAG_SENSITIVITY = 0.0025;
const DAMPING = 0.88;

const MIN_FOV = 30;
const MAX_FOV = 100;

const MAX_PITCH = Math.PI * 0.28;

const CAP_COLOR = 0x1a1a1a;

// Radial distance from the camera where arrows sit.
const ARROW_DISTANCE = 300;

// How far below the camera the arrows sit (so they lie on the floor).
const ARROW_FLOOR_Y = -180;

// Arrow visual size (world units).
const ARROW_SIZE = 90;

// Fade duration when switching panoramas (seconds).
const FADE_DURATION = 0.35;

/* ---------- State ---------- */

let scene, camera, renderer, cylinder;
let currentPanoId = null;
let arrowGroup = null;
let isDragging = false;
let pointerStart = { x: 0, y: 0 };
let yawAtDragStart = 0;
let pitchAtDragStart = 0;

let targetYaw = yaw;
let targetPitch = pitch;
let targetFov = BASE_FOV;

const activePointers = new Map();
let pinchStartDistance = 0;
let pinchStartFov = BASE_FOV;

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
let hoveredArrow = null;

let fadeEl = null;

/* ---------- Init ---------- */

function init() {
  const container = document.getElementById("viewer");

  scene = new THREE.Scene();
  scene.background = new THREE.Color(CAP_COLOR);

  camera = new THREE.PerspectiveCamera(
    BASE_FOV,
    window.innerWidth / window.innerHeight,
    0.1,
    2000
  );
  camera.position.set(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  // --- Cylinder (the panorama surface) ---
  const radius = 500;
  const height = radius * CYLINDER_HEIGHT_RATIO * 2;
  const geometry = new THREE.CylinderGeometry(
    radius, radius, height, 64, 1, true
  );
  geometry.scale(-1, 1, 1);

  const material = new THREE.MeshBasicMaterial({
    color: 0x111111,
    side: THREE.DoubleSide,
  });
  cylinder = new THREE.Mesh(geometry, material);
  scene.add(cylinder);

  // --- Arrow group ---
  arrowGroup = new THREE.Group();
  scene.add(arrowGroup);

  createFadeOverlay();

  setupPointerEvents(container);
  setupWheelZoom(container);
  setupResize();
  setupFullscreen();
  setupKeyboard();

  switchTo(START_PANO, { instant: true });

  animate();
}

/* ---------- Panorama switching ---------- */

function switchTo(id, opts = {}) {
  const pano = panoramas[id];
  if (!pano) {
    console.warn("Unknown panorama id:", id);
    return;
  }
  if (id === currentPanoId) return;

  const doSwap = () => {
    const loader = new THREE.TextureLoader();
    loader.load(
      pano.image,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;

        if (cylinder.material.map) cylinder.material.map.dispose();

        cylinder.material.map = texture;
        cylinder.material.color.set(0xffffff);
        cylinder.material.needsUpdate = true;

        currentPanoId = id;

        yaw = targetYaw = pano.yaw || 0;
        pitch = targetPitch = 0;

        buildArrows(pano);

        document.getElementById("loader").classList.add("hidden");

        fadeIn();
      },
      undefined,
      (err) => {
        console.error("Failed to load", pano.image, err);
        fadeIn();
      }
    );
  };

  if (opts.instant) {
    doSwap();
  } else {
    fadeOut(doSwap);
  }
}

/* ---------- Arrows ---------- */

function buildArrows(pano) {
  // Clear old arrows
  while (arrowGroup.children.length) {
    const c = arrowGroup.children.pop();
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      if (c.material.map) c.material.map.dispose();
      c.material.dispose();
    }
  }

  const links = pano.links || [];

  links.forEach((link) => {
    const mesh = makeArrowMesh();
    const angle = link.atYaw;

    // Position: radial distance from camera, dropped to floor level.
    mesh.position.set(
      Math.sin(angle) * ARROW_DISTANCE,
      ARROW_FLOOR_Y,
      Math.cos(angle) * ARROW_DISTANCE
    );

    // Lay flat, parallel to the floor.
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = angle;


    // Spin around the vertical axis so the arrow's tip points from the
    // camera toward the destination direction (atYaw).
    mesh.rotation.z = angle;

    mesh.userData.target = link.target;
    mesh.userData.isArrow = true;

    arrowGroup.add(mesh);
  });

  console.log(`Built ${arrowGroup.children.length} arrows for ${pano.id}`);
}

function makeArrowMesh() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");

  const cx = size / 2;
  const cy = size / 2;
  const discR = size * 0.36;

  // --- Soft drop shadow under the disc ---
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 6;
  ctx.beginPath();
  ctx.arc(cx, cy, discR, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();

  // --- White disc ---
  ctx.beginPath();
  ctx.arc(cx, cy, discR, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  // --- Thin grey border ring ---
  ctx.beginPath();
  ctx.arc(cx, cy, discR, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.15)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // --- Solid chevron (Google blue) ---
  const chevColor = "#1a73e8";

  ctx.beginPath();
  ctx.moveTo(cx, size * 0.30);
  ctx.lineTo(cx + size * 0.19, size * 0.60);
  ctx.lineTo(cx + size * 0.075, size * 0.60);
  ctx.lineTo(cx + size * 0.075, size * 0.75);
  ctx.lineTo(cx - size * 0.075, size * 0.75);
  ctx.lineTo(cx - size * 0.075, size * 0.60);
  ctx.lineTo(cx - size * 0.19, size * 0.60);
  ctx.closePath();
  ctx.fillStyle = chevColor;
  ctx.fill();

  // Rounded corners
  ctx.lineJoin = "round";
  ctx.lineWidth = 6;
  ctx.strokeStyle = chevColor;
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const geometry = new THREE.PlaneGeometry(ARROW_SIZE, ARROW_SIZE);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 999;
  return mesh;
}

/* ---------- Pointer events ---------- */

function setupPointerEvents(container) {
  const el = renderer.domElement;

  el.addEventListener("pointerdown", (e) => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 1) {
      if (tryClickArrow(e)) {
        activePointers.delete(e.pointerId);
        return;
      }
      isDragging = true;
      container.classList.add("dragging");
      pointerStart.x = e.clientX;
      pointerStart.y = e.clientY;
      yawAtDragStart = targetYaw;
      pitchAtDragStart = targetPitch;
    } else if (activePointers.size === 2) {
      isDragging = false;
      container.classList.remove("dragging");
      const pts = [...activePointers.values()];
      pinchStartDistance = distance(pts[0], pts[1]);
      pinchStartFov = targetFov;
    }

    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener("pointermove", (e) => {
    if (!activePointers.has(e.pointerId)) {
      updateHover(e);
      return;
    }
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 2) {
      const pts = [...activePointers.values()];
      const dist = distance(pts[0], pts[1]);
      if (pinchStartDistance > 0) {
        const ratio = pinchStartDistance / dist;
        targetFov = clamp(pinchStartFov * ratio, MIN_FOV, MAX_FOV);
      }
      return;
    }

    if (!isDragging) return;

    const dx = e.clientX - pointerStart.x;
    const dy = e.clientY - pointerStart.y;

    targetYaw = yawAtDragStart - dx * DRAG_SENSITIVITY;
    targetPitch = clamp(
      pitchAtDragStart + dy * DRAG_SENSITIVITY,
      -MAX_PITCH,
      MAX_PITCH
    );
  });

  const endPointer = (e) => {
    activePointers.delete(e.pointerId);

    if (activePointers.size === 0) {
      isDragging = false;
      container.classList.remove("dragging");
    } else if (activePointers.size === 1) {
      const remaining = [...activePointers.values()][0];
      isDragging = true;
      pointerStart.x = remaining.x;
      pointerStart.y = remaining.y;
      yawAtDragStart = targetYaw;
      pitchAtDragStart = targetPitch;
    }
  };

  el.addEventListener("pointerup", endPointer);
  el.addEventListener("pointercancel", endPointer);
  el.addEventListener("pointerleave", endPointer);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

function updatePointerNDC(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function pickArrow(e) {
  updatePointerNDC(e);
  raycaster.setFromCamera(pointerNDC, camera);
  const hits = raycaster.intersectObjects(arrowGroup.children, false);
  return hits.length ? hits[0].object : null;
}

function tryClickArrow(e) {
  const hit = pickArrow(e);
  if (hit) {
    switchTo(hit.userData.target);
    return true;
  }
  return false;
}

function updateHover(e) {
  const hit = pickArrow(e);
  if (hit !== hoveredArrow) {
    hoveredArrow = hit;
    renderer.domElement.style.cursor = hit ? "pointer" : "";
  }
}

/* ---------- Wheel zoom ---------- */

function setupWheelZoom(container) {
  container.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 100);
      targetFov = clamp(targetFov + delta * 0.08, MIN_FOV, MAX_FOV);
    },
    { passive: false }
  );
}

/* ---------- Resize / fullscreen ---------- */

function setupResize() {
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function setupFullscreen() {
  const btn = document.getElementById("fullscreen-btn");
  btn.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.warn("Fullscreen request failed:", err);
      });
    } else {
      document.exitFullscreen();
    }
  });
}

/* ---------- Keyboard ---------- */

function setupKeyboard() {
  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") targetYaw += 0.1;
    else if (e.key === "ArrowRight") targetYaw -= 0.1;
    else if (e.key === "ArrowUp")
      targetPitch = clamp(targetPitch + 0.1, -MAX_PITCH, MAX_PITCH);
    else if (e.key === "ArrowDown")
      targetPitch = clamp(targetPitch - 0.1, -MAX_PITCH, MAX_PITCH);
  });
}

/* ---------- Fade transition ---------- */

function createFadeOverlay() {
  fadeEl = document.createElement("div");
  Object.assign(fadeEl.style, {
    position: "fixed",
    inset: "0",
    background: "#000",
    opacity: "0",
    pointerEvents: "none",
    transition: `opacity ${FADE_DURATION}s ease`,
    zIndex: "8",
  });
  document.body.appendChild(fadeEl);
}

function fadeOut(onDone) {
  fadeEl.style.opacity = "1";
  setTimeout(onDone, FADE_DURATION * 1000);
}

function fadeIn() {
  requestAnimationFrame(() => {
    fadeEl.style.opacity = "0";
  });
}

/* ---------- Render loop ---------- */

function animate() {
  requestAnimationFrame(animate);

  yaw += (targetYaw - yaw) * (1 - DAMPING);
  pitch += (targetPitch - pitch) * (1 - DAMPING);

  const newFov = camera.fov + (targetFov - camera.fov) * (1 - DAMPING);
  if (Math.abs(newFov - camera.fov) > 0.01) {
    camera.fov = newFov;
    camera.updateProjectionMatrix();
  }

  const phi = Math.PI / 2 - pitch;
  const theta = yaw;

  const look = new THREE.Vector3(
    Math.sin(phi) * Math.sin(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.cos(theta)
  );
  camera.lookAt(look);

  renderer.render(scene, camera);
}

/* ---------- Helpers ---------- */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/* ---------- Go ---------- */

init();