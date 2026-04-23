import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---- Settings / Meta ----
const PARAMS = {
    lons: 192,
    lats: 94,
    frames: 91,
    currentFrame: 0,
    datasetIndex: 1, // 1 for PWAT1, 2 for PWAT2
    seasonIndex: 0,  // 0=Jan, 1=July
    viewMode: 0,     // 0 = 3D, 1 = 2D, 2 = SPLIT
    showWind: true,
};

// Gaussian Latitude levels (from flx.ctl) - Row 0 = North, Row 93 = South
const GAUSSIAN_LATS = [
    88.542, 86.653, 84.753, 82.851, 80.947, 79.043, 77.139, 75.235, 73.331, 71.426,
    69.522, 67.617, 65.713, 63.808, 61.903, 59.999, 58.094, 56.189, 54.285, 52.380,
    50.475, 48.571, 46.666, 44.761, 42.856, 40.952, 39.047, 37.142, 35.238, 33.333,
    31.428, 29.523, 27.619, 25.714, 23.809, 21.904, 20.000, 18.095, 16.190, 14.286,
    12.381, 10.476, 8.571, 6.667, 4.762, 2.857, 0.952, -0.952, -2.857, -4.762,
    -6.667, -8.571, -10.476, -12.381, -14.286, -16.190, -18.095, -20.000, -21.904, -23.809,
    -25.714, -27.619, -29.523, -31.428, -33.333, -35.238, -37.142, -39.047, -40.952, -42.856,
    -44.761, -46.666, -48.571, -50.475, -52.380, -54.285, -56.189, -58.094, -59.999, -61.903,
    -63.808, -65.713, -67.617, -69.522, -71.426, -73.331, -75.235, -77.139, -79.043, -80.947,
    -82.851, -84.753, -86.653, -88.542
];

// ---- Source de verite : make_summer.gs / flx.ctl ----
const SEASONS = [
    {
        prefix: 'jpbz_201707',
        label: 'Summer 2017 — JP tracer (00Z01JUL2017)',
        tdefStart: new Date('2017-07-01T00:00:00Z'),
        increment: 86400000
    },
    {
        prefix: 'jpbz_1_2018',
        label: 'Winter 2018 — JP tracer (00Z01JAN2018)',
        tdefStart: new Date('2018-01-01T00:00:00Z'),
        increment: 86400000
    }
];

let buffer1 = null;
let localBuffer = null;
let localBufferU = null;
let localBufferV = null;
let archiveBufferU = null;
let archiveBufferV = null;
let localFramesLoaded = 0;
let dataTexture = null;
let material = null;

// ---- Particle Advection System (Windy-style) ----
const N_PARTICLES = 28;     // Style épuré "Atlas"
const TRAIL_LEN = 100;      // Assez long pour traverser un océan
const WIND_RADIUS = 1.025;
const WIND_SCALE = 0.008;

const pLat = new Float32Array(N_PARTICLES);
const pLon = new Float32Array(N_PARTICLES);
const pAge = new Uint16Array(N_PARTICLES);
const pLife = new Uint16Array(N_PARTICLES);
const pTrailX = new Float32Array(N_PARTICLES * TRAIL_LEN);
const pTrailY = new Float32Array(N_PARTICLES * TRAIL_LEN);
const pTrailZ = new Float32Array(N_PARTICLES * TRAIL_LEN);
let trailMesh = null;

let currentTopWinds = [];

function updateTopWinds(frameIdx) {
    const aU = isLocalData ? localBufferU : archiveBufferU;
    const aV = isLocalData ? localBufferV : archiveBufferV;
    if (!aU || !aV) return;

    const base = frameIdx * 192 * 94;

    // On divise le monde en 8 zones (2 colonnes x 4 rangées)
    const zones = Array.from({ length: 8 }, () => []);

    for (let r = 0; r < 94; r++) {
        const lat = GAUSSIAN_LATS[r];
        const zoneR = Math.floor(r / (94 / 4)); // 0 à 3

        for (let c = 0; c < 192; c++) {
            const lon = (c / 192) * 360;
            const zoneC = Math.floor(c / (192 / 2)); // 0 à 1
            const zoneIdx = zoneR * 2 + zoneC;

            const idx = base + r * 192 + c;
            const speedSq = aU[idx] * aU[idx] + aV[idx] * aV[idx];

            if (!isNaN(speedSq) && speedSq > 5.0) { // Seuil réduit pour voir plus de vent
                zones[zoneIdx].push({ lat, lon, speedSq });
            }
        }
    }

    currentTopWinds = [];
    const perZone = Math.ceil(N_PARTICLES / 8); // On veut environ 3-4 flèches par zone

    // Pour chaque zone, on prend les meilleurs vents
    zones.forEach(z => {
        z.sort((a, b) => b.speedSq - a.speedSq);
        let addedInZone = 0;

        for (const pt of z) { // On boucle sur 'z' (la zone) et pas 'windSpeeds'
            if (currentTopWinds.length >= N_PARTICLES) break;
            if (addedInZone >= perZone) break;

            let tooClose = false;
            for (const s of currentTopWinds) {
                // EXCLUSION RADICALE pour le style Atlas (30° de longitude)
                if (Math.abs(s.lat - pt.lat) < 15 && Math.abs(s.lon - pt.lon) < 30) {
                    tooClose = true;
                    break;
                }
            }

            if (!tooClose) {
                currentTopWinds.push(pt);
                addedInZone++; // On compte combien on en ajoute pour cette zone
            }
        }
    });
}
let isLocalData = false;
let currentUploadedFiles = [];

// ---- UI Bindings ----
const uiLabelSet = document.getElementById('dataset-label');
const uiLabelFrame = document.getElementById('frame-label');
const uiDateDisplay = document.getElementById('date-display');
const sliderTime = document.getElementById('time-slider');
const btnToggle = document.getElementById('toggle-data');
const btnPlay = document.getElementById('btn-play');
const btnToggleView = document.getElementById('btn-toggle-view');
const archiveUI = document.getElementById('archive-specific-ui');
const localUI = document.getElementById('local-specific-ui');
const commonUI = document.getElementById('common-ui');

let globe = null;
let graticule = null;
let coastMesh = null;
let basePlane = null;

// 2D Canvas setup (Transparent HUD Layer)
const canvas2D = document.getElementById('canvas-2d');
const ctx2D = canvas2D.getContext('2d', { alpha: true }); // Must be true to see WebGL behind
const canvas2DContainer = document.getElementById('canvas-2d-container');
const mainContent = document.getElementById('main-content');

function resize2DCanvas() {
    if (canvas2DContainer.style.display === 'none') return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas2DContainer.getBoundingClientRect();
    if (rect.width === 0) return;

    // Calcul de la taille max en conservant le ratio strict de 2.04
    let targetW = rect.width * 0.95;
    let targetH = targetW / 2.04;

    if (targetH > rect.height * 0.95) {
        targetH = rect.height * 0.95;
        targetW = targetH * 2.04;
    }

    // Taille physique de la zone de dessin (Retina/High-DPI)
    canvas2D.width = targetW * dpr;
    canvas2D.height = targetH * dpr;

    // Taille visuelle bloquée pour empêcher le CSS d'étirer l'image
    canvas2D.style.width = targetW + 'px';
    canvas2D.style.height = targetH + 'px';

    // SYNCHRONISATION : Calcul de la distance Z dynamique (camera2D)
    const vFOV = camera2D.fov * Math.PI / 180;
    const finalZ = (rect.height / targetH) / (2 * Math.tan(vFOV / 2));
    camera2D.position.set(0, 0, finalZ);
}

function updateCameras() {
    // 🛡️ BOUCLIER 1 : Force un minimum de 1 pixel pour éviter le bug NaN (écran noir)
    const W = Math.max(1, mainContent.clientWidth);
    const H = Math.max(1, mainContent.clientHeight);

    const aspect = (PARAMS.viewMode === 2) ? (W / 2) / H : (W / H);

    camera2D.aspect = aspect;
    camera2D.updateProjectionMatrix();
    camera3D.aspect = aspect;
    camera3D.updateProjectionMatrix();

    renderer.setSize(W, H);
    resize2DCanvas();
}
// Offscreen Buffer for Bilinear Interpolation (192x94 native resolution)
const offscreenCanvas = document.createElement('canvas');
offscreenCanvas.width = 192;
offscreenCanvas.height = 94;
const offscreenCtx = offscreenCanvas.getContext('2d', { alpha: true });

let coastlinesGeoJSON = null;

sliderTime.min = 0;
sliderTime.max = PARAMS.frames - 1;

// ---- Auto-Play State ----
let isPlaying = false;
let lastFrameTime = 0;
let currentFPS = 12;
let msPerFrame = 1000 / currentFPS;
let isSlowMotion = false;

// ---- Three.js Setup ----
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050505); // Global Black Workspace

const camera2D = new THREE.PerspectiveCamera(45, (mainContent.clientWidth / 2) / mainContent.clientHeight, 0.1, 20000);
const camera3D = new THREE.PerspectiveCamera(45, (mainContent.clientWidth / 2) / mainContent.clientHeight, 0.1, 20000);
camera3D.position.set(0, 0, 3.5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(mainContent.clientWidth, mainContent.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera3D, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;


// ---- 1. Base Globe ----
const globeGeom = new THREE.SphereGeometry(1.0, 64, 64);
const globeMat = new THREE.MeshBasicMaterial({ color: 0x2a2a2a });
globe = new THREE.Mesh(globeGeom, globeMat);
scene.add(globe);

// ---- 2. Graticule ----
const graticuleMat = new THREE.LineBasicMaterial({ color: 0x444444, transparent: true, opacity: 0.5 });
const graticuleGeom = new THREE.BufferGeometry();
const graticulePoints = [];
const radiusGraticule = 1.001;

for (let lon = -180; lon <= 180; lon += 15) {
    const lonRad = lon * Math.PI / 180;
    for (let lat = -90; lat <= 90; lat += 2) {
        const latRad = lat * Math.PI / 180;
        const x = radiusGraticule * Math.cos(latRad) * Math.cos(lonRad);
        const y = radiusGraticule * Math.sin(latRad);
        const z = -radiusGraticule * Math.cos(latRad) * Math.sin(lonRad);
        graticulePoints.push(new THREE.Vector3(x, y, z));
    }
}
for (let lat = -90; lat <= 90; lat += 15) {
    const latRad = lat * Math.PI / 180;
    for (let lon = -180; lon <= 180; lon += 2) {
        const lonRad = lon * Math.PI / 180;
        const x = radiusGraticule * Math.cos(latRad) * Math.cos(lonRad);
        const y = radiusGraticule * Math.sin(latRad);
        const z = -radiusGraticule * Math.cos(latRad) * Math.sin(lonRad);
        graticulePoints.push(new THREE.Vector3(x, y, z));
    }
}
graticuleGeom.setFromPoints(graticulePoints);
graticule = new THREE.LineSegments(graticuleGeom, graticuleMat);
scene.add(graticule);

// ---- 2b. Coastlines ----
function loadCoastlines() {
    fetch('countries.geojson')
        .then(res => res.json())
        .then(data => {
            coastlinesGeoJSON = data;
            const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false });
            const R = 1.005;
            const positions = [];
            data.features.forEach(f => {
                const rings = (f.geometry.type === 'Polygon') ? [f.geometry.coordinates] : f.geometry.coordinates;
                rings.forEach(poly => poly.forEach(ring => {
                    for (let n = 0; n < ring.length - 1; n++) {
                        if (Math.abs(ring[n][0] - ring[n + 1][0]) > 180) continue;
                        const l1 = ring[n][0] * Math.PI / 180; const a1 = ring[n][1] * Math.PI / 180;
                        const l2 = ring[n + 1][0] * Math.PI / 180; const a2 = ring[n + 1][1] * Math.PI / 180;
                        positions.push(R * Math.cos(a1) * Math.cos(l1), R * Math.sin(a1), -R * Math.cos(a1) * Math.sin(l1));
                        positions.push(R * Math.cos(a2) * Math.cos(l2), R * Math.sin(a2), -R * Math.cos(a2) * Math.sin(l2));
                    }
                }));
            });
            const geom = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            coastMesh = new THREE.LineSegments(geom, mat);
            coastMesh.renderOrder = 3;
            scene.add(coastMesh);
        });
}
loadCoastlines();

// ---- 3. Unified Shader Layer ----
const initialData = new Float32Array(PARAMS.lons * PARAMS.lats);
dataTexture = new THREE.DataTexture(initialData, PARAMS.lons, PARAMS.lats, THREE.RedFormat, THREE.FloatType);
dataTexture.generateMipmaps = false;
dataTexture.minFilter = THREE.LinearFilter;
dataTexture.magFilter = THREE.LinearFilter;
dataTexture.wrapS = THREE.ClampToEdgeWrapping;
dataTexture.wrapT = THREE.ClampToEdgeWrapping;
dataTexture.needsUpdate = true;

const _VS = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const _FS = `
uniform sampler2D tData;
uniform float u_is3D;
varying vec2 vUv;

vec3 getColor(float val) {
    if (val < 0.001 || val > 1.0e15) return vec3(0.18, 0.44, 0.77); // Unified GrADS Blue
    // Dégradé de bleu basé sur l'intensité de la vapeur d'eau (suggéré)
    if (val < 0.002) return vec3(0.20, 0.48, 0.82);
    if (val < 0.005) return vec3(0.24, 0.52, 0.86);
    if (val < 0.01)  return vec3(0.28, 0.56, 0.90);
    if (val < 0.02)  return vec3(0.32, 0.60, 0.94);
    if (val < 0.05)  return vec3(0.38, 0.65, 0.98);
    if (val < 0.1)   return vec3(0.44, 0.70, 1.00);
    if (val < 0.2)   return vec3(0.52, 0.76, 1.00);
    if (val < 0.5)   return vec3(0.60, 0.82, 1.00);
    if (val < 1.0)   return vec3(0.70, 0.88, 1.00);
    if (val < 2.0)   return vec3(0.80, 0.92, 1.00);
    if (val < 5.0)   return vec3(0.90, 0.96, 1.00);
    if (val < 10.0)  return vec3(0.95, 0.98, 1.00);
    return vec3(1.00, 1.00, 1.00);
}

void main() {
    vec2 finalUv;
    if (u_is3D > 0.5) {
        float lon = vUv.x * 360.0 - 180.0;
        float gribLon = (lon < 0.0 ? lon + 360.0 : lon);
        finalUv = vec2(gribLon / 360.0, 1.0 - vUv.y);
    } else {
        // Mirror 2D : Identité pure
        finalUv = vec2(vUv.x, 1.0 - vUv.y);
    }
    float val = texture2D(tData, finalUv).r;
    gl_FragColor = vec4(getColor(val), 1.0);
}
`;

material = new THREE.ShaderMaterial({
    uniforms: {
        tData: { value: dataTexture },
        u_is3D: { value: 1.0 } // Default to 3D
    },
    vertexShader: _VS, fragmentShader: _FS, side: THREE.DoubleSide
});

const dataSphere = new THREE.Mesh(new THREE.SphereGeometry(1.002, 64, 64), material);
dataSphere.renderOrder = 2;
scene.add(dataSphere);

const dataPlaneGeom = new THREE.PlaneGeometry(2.04, 1.0); // Ratio 192/94
const dataPlane = new THREE.Mesh(dataPlaneGeom, material);
dataPlane.position.set(0, 0, 0.0); // Exactly at origin for 2D mode
dataPlane.rotation.set(0, 0, 0); // No tilt
dataPlane.frustumCulled = false;
dataPlane.visible = false;
dataPlane.renderOrder = 2;
scene.add(dataPlane);

// ---- 3c. 2D Base Ground (The "Surface" Twin) ----
const basePlaneGeom = new THREE.PlaneGeometry(2.04, 1.0);
const basePlaneMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
basePlane = new THREE.Mesh(basePlaneGeom, basePlaneMat);
basePlane.position.set(0, 0, -0.01); // Standard depth layering
basePlane.visible = false;
basePlane.renderOrder = 1;
scene.add(basePlane);

// ---- Markers ----
const markers = [];
function createMarker(lat, lon, labelText, isPrimary = false, r = 1.11) {
    const latRad = lat * Math.PI / 180; const lonRad = lon * Math.PI / 180;
    const x = r * Math.cos(latRad) * Math.cos(lonRad);
    const y = r * Math.sin(latRad);
    const z = -r * Math.cos(latRad) * Math.sin(lonRad);
    const group = new THREE.Group(); group.position.set(x, y, z);

    // Taille du point réduite pour les villes secondaires
    const dotSize = isPrimary ? 0.02 : 0.012;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(dotSize), new THREE.MeshBasicMaterial({ color: 0xffff00 }));
    group.add(mesh);

    // Canvas haute résolution pour un texte net
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 44px Arial';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round'; // Coins arrondis pour éviter les pointes noires du stroke
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    ctx.strokeText(labelText, 128, 110);
    ctx.fillText(labelText, 128, 110);

    const spriteMat = new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        depthTest: false,   // Empêche le panneau transparent d'occulter la géométrie 3D (le bug du "rectangle bleu")
        depthWrite: false,
        transparent: true
    });
    const sprite = new THREE.Sprite(spriteMat);
    // L'ancre du Sprite est décalée vers le bas pour le faire flotter au-dessus du point en coordonnée "écran" (et non géographique)
    sprite.center.set(0.5, -0.2);
    sprite.scale.set(0.12, 0.06, 1); // Taille réduite pour ne pas cacher la région
    sprite.renderOrder = 4; // Rendu en tout dernier, par-dessus les côtes et le globe
    group.add(sprite);

    // Sauvegarde en userData pour optimisation via l'animateLoop et render2D
    group.userData = { lat, lon, labelText, isPrimary, sprite };

    scene.add(group); markers.push(group);
}

// --- Japon ---
createMarker(34.69, 135.50, "OSA");

// --- Europe (Cités dans le workshop) ---
createMarker(48.85, 2.35, "PAR");
createMarker(40.41, -3.70, "MAD");
createMarker(51.50, -0.12, "LON");

// --- Amériques ---
createMarker(-23.55, -46.63, "SAO");
createMarker(-22.90, -43.17, "RIO");
createMarker(40.71, -74.00, "NYC");
createMarker(21.30, -157.85, "HNL"); // Point clé du Pacifique

// --- Autres points mondiaux ---
createMarker(39.90, 116.40, "PEK");
createMarker(-33.86, 151.20, "SYD");
createMarker(30.04, 31.23, "CAI");
createMarker(-33.92, 18.42, "CPT");

// ---- Data Loop ----
async function loadData() {
    const season = SEASONS[PARAMS.seasonIndex];
    const res1 = await fetch(season.prefix + '_pwat1_91frames.bin');
    if (res1.ok && !isLocalData) buffer1 = new Float32Array(await res1.arrayBuffer());

    const resU = await fetch(season.prefix + '_u_91frames.bin');
    if (resU.ok && !isLocalData) archiveBufferU = new Float32Array(await resU.arrayBuffer());

    const resV = await fetch(season.prefix + '_v_91frames.bin');
    if (resV.ok && !isLocalData) archiveBufferV = new Float32Array(await resV.arrayBuffer());
    if (!isLocalData) {
        resetParticles(); // <-- AJOUTEZ CECI
        updateFrame();
    }
}

function updateFrame() {
    let active = null;
    if (isLocalData) {
        active = localBuffer;
        PARAMS.frames = localFramesLoaded;
    } else {
        active = buffer1; // Force toujours tracer 1 (Japon)
        PARAMS.frames = 91;
    }

    // 🛡️ 1. MODE GLOBE VIERGE (Pas de données ou attente d'import initial)
    if (!active) {
        // On remplit les données avec des zéros (0) = Plus de couleurs, juste les continents !
        if (typeof dataTexture !== 'undefined' && dataTexture.image && dataTexture.image.data) {
            dataTexture.image.data.fill(0);
            dataTexture.needsUpdate = true;
        }
        return;
    }

    // ✅ 2. MODE LECTURE (On a des données)
    if (dataSphere) dataSphere.visible = true;
    if (dataPlane && PARAMS.viewMode !== 0) dataPlane.visible = true;

    // --- MISE À JOUR CIBLÉE DES COMPOSANTS (SLIDER ET LABELS) ---
    if (sliderTime) sliderTime.max = PARAMS.frames - 1;

    // On injecte les données de la frame actuelle
    dataTexture.image.data.set(active.subarray(PARAMS.currentFrame * 192 * 94, (PARAMS.currentFrame + 1) * 192 * 94));
    dataTexture.needsUpdate = true;
    sliderTime.value = PARAMS.currentFrame;

    // --- Mise à jour du texte de la bannière et des labels UI ---
    const dateDisplay = document.getElementById('date-display');
    const datasetLabel = document.getElementById('dataset-label');
    const frameLabel = document.getElementById('frame-label');

    if (isLocalData) {
        if (dateDisplay) dateDisplay.innerText = `FRAME: ${PARAMS.currentFrame + 1} / ${PARAMS.frames}`;
        if (datasetLabel) datasetLabel.innerText = `${PARAMS.frames} local file(s) loaded`;
        if (frameLabel) frameLabel.innerText = `${PARAMS.currentFrame + 1} / ${PARAMS.frames}`;
    } else {
        const d = new Date(SEASONS[PARAMS.seasonIndex].tdefStart.getTime() + PARAMS.currentFrame * 86400000);
        const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        if (dateDisplay) dateDisplay.innerText = `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

        if (datasetLabel) datasetLabel.innerText = `PWAT1 (Japan) — ${PARAMS.seasonIndex === 0 ? 'Summer' : 'Winter'}`;
        if (frameLabel) frameLabel.innerText = `${PARAMS.currentFrame + 1} / 91`;
    }

    if (PARAMS.viewMode !== 0) render2D();
}

// ========================
// PARTICLE ADVECTION SYSTEM
// =====

function initParticles() {
    const TOTAL_VERTS = N_PARTICLES * (TRAIL_LEN - 1) * 6; // 6 sommets par segment
    const posArr = new Float32Array(TOTAL_VERTS * 3);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3).setUsage(THREE.DynamicDrawUsage));

    const mat = new THREE.MeshBasicMaterial({
        color: 0xff0000,       // Rouge vif
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthTest: true
    });

    if (trailMesh) {
        trailMesh.geometry.dispose();
        trailMesh.material.dispose();
        scene.remove(trailMesh);
    }

    trailMesh = new THREE.Mesh(geo, mat);
    trailMesh.renderOrder = 3;
    scene.add(trailMesh);
}

function spawnParticle(i, forceLat = null, forceLon = null) {
    const aU = isLocalData ? localBufferU : archiveBufferU;
    const aV = isLocalData ? localBufferV : archiveBufferV;

    // 1. Position de départ
    if (forceLat !== null && forceLon !== null) {
        pLat[i] = forceLat;
        pLon[i] = forceLon;
    } else {
        pLat[i] = (Math.random() * 160) - 80;
        pLon[i] = Math.random() * 360;
    }

    pAge[i] = TRAIL_LEN + 1; // On force l'âge à être "adulte" tout de suite
    pLife[i] = 200 + Math.floor(Math.random() * 300);

    // 2. PRÉ-CALCUL DE LA TRAÎNÉE (On génère les 120 points d'un coup)
    const tb = i * TRAIL_LEN;

    // On remplit l'historique en simulant le passé
    for (let t = 0; t < TRAIL_LEN; t++) {
        const latR = pLat[i] * Math.PI / 180;
        const lonR = pLon[i] * Math.PI / 180;

        // Position actuelle
        pTrailX[tb + t] = WIND_RADIUS * Math.cos(latR) * Math.cos(lonR);
        pTrailY[tb + t] = WIND_RADIUS * Math.sin(latR);
        pTrailZ[tb + t] = -WIND_RADIUS * Math.cos(latR) * Math.sin(lonR);

        // On fait avancer la position "virtuellement" pour le prochain point du trail
        if (aU && aV) {
            const [u, v] = getWindAtPos(pLat[i], pLon[i], PARAMS.currentFrame, aU, aV);
            const cosLat = Math.max(0.05, Math.cos(pLat[i] * Math.PI / 180));
            pLon[i] += u * WIND_SCALE / cosLat;
            pLat[i] += v * WIND_SCALE;
            pLon[i] = ((pLon[i] % 360) + 360) % 360;
            pLat[i] = Math.max(-80, Math.min(80, pLat[i]));
        }
    }
}

function resetParticles() {
    updateTopWinds(PARAMS.currentFrame);
    const len = currentTopWinds.length;

    for (let i = 0; i < N_PARTICLES; i++) {
        const spot = len > 0 ? currentTopWinds[i % len] : null;
        spawnParticle(i, spot ? spot.lat : null, spot ? spot.lon : null);
    }

    if (trailMesh && trailMesh.geometry) {
        trailMesh.geometry.attributes.position.needsUpdate = true;
    }
}

function getWindAtPos(lat, lon, frameIdx, aU, aV) {
    lat = Math.max(-87, Math.min(87, lat));
    lon = ((lon % 360) + 360) % 360;
    const cf = lon / (360 / 192);
    const c0 = Math.floor(cf) % 192;
    const c1 = (c0 + 1) % 192;
    const lt = cf - Math.floor(cf);
    let r0 = 92;
    for (let i = 0; i < 93; i++) {
        if (GAUSSIAN_LATS[i] >= lat && lat >= GAUSSIAN_LATS[i + 1]) { r0 = i; break; }
    }
    if (lat > GAUSSIAN_LATS[0]) r0 = 0;
    const r1 = Math.min(r0 + 1, 93);
    const lr = (r0 === r1) ? 0 : (GAUSSIAN_LATS[r0] - lat) / (GAUSSIAN_LATS[r0] - GAUSSIAN_LATS[r1]);
    const base = frameIdx * 192 * 94;
    const lerp = (a, b, t) => a + (b - a) * t;
    const u = lerp(lerp(aU[base + r0 * 192 + c0], aU[base + r0 * 192 + c1], lt),
        lerp(aU[base + r1 * 192 + c0], aU[base + r1 * 192 + c1], lt), lr);
    const v = lerp(lerp(aV[base + r0 * 192 + c0], aV[base + r0 * 192 + c1], lt),
        lerp(aV[base + r1 * 192 + c0], aV[base + r1 * 192 + c1], lt), lr);
    return [u, v];
}

function updateParticles(frameIdx, doAdvance) {
    const aU = isLocalData ? localBufferU : archiveBufferU;
    const aV = isLocalData ? localBufferV : archiveBufferV;
    if (!aU || !aV || !trailMesh) return;

    trailMesh.visible = (PARAMS.viewMode !== 1 && PARAMS.showWind);

    const posArr = trailMesh.geometry.attributes.position.array;
    const len = currentTopWinds.length;

    for (let i = 0; i < N_PARTICLES; i++) {
        const tb = i * TRAIL_LEN;

        // --- PARTIE 2 : GÉNÉRATION DU RUBAN (Dessin permanent) ---
        const vb = i * (TRAIL_LEN - 1) * 18;
        const _p1 = new THREE.Vector3();
        const _p2 = new THREE.Vector3();
        const _dir = new THREE.Vector3();
        const _up = new THREE.Vector3();
        const _right = new THREE.Vector3();
        const _up2 = new THREE.Vector3();
        const _right2 = new THREE.Vector3();

        // Calcul du facteur de taille selon la vitesse
        const h1 = new THREE.Vector3(pTrailX[tb], pTrailY[tb], pTrailZ[tb]);
        const h2 = new THREE.Vector3(pTrailX[tb + 1], pTrailY[tb + 1], pTrailZ[tb + 1]);
        const sizeFactor = Math.max(0.0, Math.min(1.0, h1.distanceTo(h2) / 0.003));

        for (let t = 0; t < TRAIL_LEN - 1; t++) {
            _p1.set(pTrailX[tb + t], pTrailY[tb + t], pTrailZ[tb + t]);
            _p2.set(pTrailX[tb + t + 1], pTrailY[tb + t + 1], pTrailZ[tb + t + 1]);
            _dir.subVectors(_p1, _p2);
            const base = vb + t * 18;

            if (isNaN(sizeFactor) || _dir.lengthSq() < 1e-12 || pAge[i] <= t + 2 || sizeFactor < 0.02) {
                for (let k = 0; k < 18; k++) posArr[base + k] = 0.0;
                continue;
            }

            _dir.normalize();
            _up.copy(_p1).normalize();
            _right.crossVectors(_dir, _up).normalize();
            _up2.copy(_p2).normalize();
            _right2.crossVectors(_dir, _up2).normalize();

            // --- POINTE EFFILÉE ---
            const getWidth = (index) => {
                const headLength = 12.0;
                if (index === 0) return 0.0;
                // Tête plus massive (0.05) et tige plus costaude (0.008)
                if (index <= headLength) return (0.05 * sizeFactor) * (index / headLength);
                return 0.008 * sizeFactor;
            };

            const w1 = getWidth(t);
            const w2 = getWidth(t + 1);

            const p1L = _p1.clone().addScaledVector(_right, w1);
            const p1R = _p1.clone().addScaledVector(_right, -w1);
            const p2L = _p2.clone().addScaledVector(_right2, w2);
            const p2R = _p2.clone().addScaledVector(_right2, -w2);

            const wv = (vec, off) => {
                posArr[base + off] = vec.x;
                posArr[base + off + 1] = vec.y;
                posArr[base + off + 2] = vec.z;
            };
            wv(p1L, 0); wv(p1R, 3); wv(p2L, 6);
            wv(p2L, 9); wv(p1R, 12); wv(p2R, 15);
        }
    }
    trailMesh.geometry.attributes.position.needsUpdate = true;
}
function render2D() {
    if (!ctx2D || canvas2D.width === 0) return;
    const W = canvas2D.width;
    const H = canvas2D.height;
    ctx2D.clearRect(0, 0, W, H);

    const projectToCanvas = (lat, lon) => {
        let l_360 = ((lon % 360) + 360) % 360;
        const x = (l_360 / 360.0) * W;
        const y = (1.0 - (lat + 90) / 180.0) * H;
        return { x, y };
    };

    // 1. DESSIN DES CÔTES
    if (coastlinesGeoJSON) {
        ctx2D.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        ctx2D.lineWidth = 1 * (window.devicePixelRatio || 1);
        coastlinesGeoJSON.features.forEach(f => {
            const rings = (f.geometry.type === 'Polygon') ? [f.geometry.coordinates] : f.geometry.coordinates;
            rings.forEach(poly => poly.forEach(ring => {
                ctx2D.beginPath();
                for (let n = 0; n < ring.length; n++) {
                    const pos = projectToCanvas(ring[n][1], ring[n][0]);
                    if (n === 0) ctx2D.moveTo(pos.x, pos.y);
                    else {
                        let currL = ((ring[n][0] % 360) + 360) % 360;
                        let prevL = ((ring[n - 1][0] % 360) + 360) % 360;
                        if (Math.abs(currL - prevL) > 180) ctx2D.moveTo(pos.x, pos.y);
                        else ctx2D.lineTo(pos.x, pos.y);
                    }
                }
                ctx2D.stroke();
            }));
        });
    }

    // 2. DESSIN DES PINS ET NOMS DES VILLES
    const dpr = window.devicePixelRatio || 1;
    markers.forEach(m => {
        const { lat, lon, labelText, isPrimary } = m.userData;
        const pos = projectToCanvas(lat, lon);

        // Point jaune
        ctx2D.beginPath();
        const radius = (isPrimary ? 4 : 2.5) * dpr;
        ctx2D.arc(pos.x, pos.y, radius, 0, 2 * Math.PI);
        ctx2D.fillStyle = '#ffff00';
        ctx2D.fill();

        // TEXTE : Nom de la ville
        ctx2D.font = `${isPrimary ? 'bold' : 'normal'} ${11 * dpr}px Inter, sans-serif`;
        ctx2D.textAlign = 'center';
        ctx2D.textBaseline = 'bottom';

        // Contour noir pour la lisibilité
        ctx2D.strokeStyle = '#000';
        ctx2D.lineWidth = 3 * dpr;
        ctx2D.strokeText(labelText, pos.x, pos.y - 5 * dpr);

        // Texte blanc
        ctx2D.fillStyle = '#fff';
        ctx2D.fillText(labelText, pos.x, pos.y - 5 * dpr);
    });

    // 3. DESSIN DES FLÈCHES DE VENT
    const aU2D = isLocalData ? localBufferU : archiveBufferU;
    const aV2D = isLocalData ? localBufferV : archiveBufferV;

    if (PARAMS.showWind && aU2D && aV2D) {
        ctx2D.lineCap = 'round';
        for (let i = 0; i < N_PARTICLES; i++) {
            const [u, v] = getWindAtPos(pLat[i], pLon[i], PARAMS.currentFrame, aU2D, aV2D);
            const speed = Math.hypot(u, v);
            const sf = Math.max(0.0, Math.min(1.0, speed / 25.0));
            if (sf < 0.1) continue;

            ctx2D.beginPath();
            let cLat = pLat[i], cLon = pLon[i];
            let prevX = -1;
            let started = false;

            for (let t = 0; t < 45; t++) {
                const pos = projectToCanvas(cLat, cLon);
                if (!started) {
                    ctx2D.moveTo(pos.x, pos.y);
                    started = true;
                } else {
                    if (Math.abs(pos.x - prevX) > W / 2) ctx2D.moveTo(pos.x, pos.y);
                    else ctx2D.lineTo(pos.x, pos.y);
                }
                prevX = pos.x;

                const [up, vp] = getWindAtPos(cLat, cLon, PARAMS.currentFrame, aU2D, aV2D);
                const cosLat = Math.max(0.05, Math.cos(cLat * Math.PI / 180));
                cLon -= up * WIND_SCALE * 3.5 / cosLat;
                cLat -= vp * WIND_SCALE * 3.5;
            }

            const lineW = sf * 8 * dpr;
            ctx2D.lineWidth = lineW;
            ctx2D.strokeStyle = `rgba(255, 0, 0, ${0.4 + sf * 0.5})`;
            ctx2D.stroke();

            // --- NOUVELLE POINTE DE FLÈCHE TRIANGULAIRE ---
            const head = projectToCanvas(pLat[i], pLon[i]);
            // On calcule l'angle du vent pour orienter la pointe
            const angle = Math.atan2(-v, u); // Y est inversé en Canvas
            const headSize = lineW * 2;

            ctx2D.save();
            ctx2D.translate(head.x, head.y);
            ctx2D.rotate(angle);

            ctx2D.beginPath();
            ctx2D.moveTo(headSize, 0); // Pointe
            ctx2D.lineTo(-headSize / 2, headSize / 1.5); // Bas gauche
            ctx2D.lineTo(-headSize / 2, -headSize / 1.5); // Bas droit
            ctx2D.closePath();

            ctx2D.fillStyle = 'red';
            ctx2D.fill();
            ctx2D.restore();
        }
    }
}

// ---- Events ----
sliderTime.addEventListener('input', (e) => {
    isPlaying = false;
    if (btnPlay) {
        btnPlay.textContent = '▶ Play';
        btnPlay.classList.remove('playing');
    }
    PARAMS.currentFrame = parseInt(e.target.value);
    resetParticles(); // <-- AJOUTEZ CETTE LIGNE
    updateFrame();
});

let currentSeason = 'summer'; // Nouvelles variables d'état (saison)
if (btnToggle) {
    btnToggle.innerText = 'Season: Summer';

    // Remplacement de l'événement de clic
    btnToggle.addEventListener('click', () => {
        currentSeason = currentSeason === 'summer' ? 'winter' : 'summer';

        // Mise à jour visuelle du bouton
        btnToggle.innerText = currentSeason === 'summer' ? 'Season: Summer' : 'Season: Winter';

        // Mise à jour du label en haut à gauche
        if (typeof uiLabelSet !== 'undefined' && uiLabelSet) {
            uiLabelSet.innerText = `PWAT1 (Japan) — ${currentSeason === 'summer' ? 'Summer' : 'Winter'}`;
        }

        // Action de chargement des données
        if (isLocalData && currentUploadedFiles && currentUploadedFiles.length > 0) {
            alert("Pour changer de saison en mode Import Local, veuillez glisser les nouveaux fichiers .ft correspondants.");
        } else {
            PARAMS.seasonIndex = currentSeason === 'summer' ? 0 : 1;
            loadData();
            console.log(`Chargement des archives pour la saison : ${currentSeason}`);
        }
    });
}
btnPlay.addEventListener('click', () => {
    if (!buffer1 && !localBuffer) return;
    isPlaying = !isPlaying;
    btnPlay.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
    if (isPlaying) {
        lastFrameTime = performance.now(); // Solid sync on Play
        btnPlay.classList.add('playing');
    } else {
        btnPlay.classList.remove('playing');
    }
});

// Création du bouton de vitesse
const btnSpeed = document.createElement('button');
btnSpeed.innerText = 'Vitesse : 1x';
btnSpeed.style.background = '#2a2a2a';
btnSpeed.style.marginBottom = '8px';

// Insertion dans le DOM juste après le bouton Play
if (btnPlay && btnPlay.parentNode) {
    btnPlay.parentNode.insertBefore(btnSpeed, btnPlay.nextSibling);
}

// Événement pour basculer la vitesse
btnSpeed.addEventListener('click', () => {
    isSlowMotion = !isSlowMotion;
    currentFPS = isSlowMotion ? 6 : 12; // 6 FPS = Vitesse 0.5x
    msPerFrame = 1000 / currentFPS;
    btnSpeed.innerText = isSlowMotion ? 'Vitesse : 0.5x' : 'Vitesse : 1x';
    btnSpeed.style.background = isSlowMotion ? '#4a9eff' : '#2a2a2a';
    btnSpeed.style.color = isSlowMotion ? '#fff' : '#e0e0e0';
});

const btnToggleWind = document.getElementById('btn-toggle-wind');
btnToggleWind.addEventListener('click', () => {
    PARAMS.showWind = !PARAMS.showWind;
    btnToggleWind.innerText = `Wind Arrows: ${PARAMS.showWind ? 'ON' : 'OFF'}`;
    btnToggleWind.style.borderColor = PARAMS.showWind ? 'var(--border-accent)' : 'var(--border-light)';
    btnToggleWind.style.color = PARAMS.showWind ? 'var(--text-primary)' : 'var(--text-secondary)';
    updateFrame(); // Force le rafraîchissement
});

btnToggleView.addEventListener('click', () => {
    PARAMS.viewMode = (PARAMS.viewMode + 1) % 3;
    const labels = ['View: 3D Globe', 'View: 2D Map', 'View: Comparative'];
    btnToggleView.innerText = labels[PARAMS.viewMode];
    if (PARAMS.viewMode === 0) {
        canvas2DContainer.style.display = 'none';
        camera3D.position.set(0, 0, 3.5);
    } else if (PARAMS.viewMode === 1) {
        canvas2DContainer.style.display = 'flex';
        canvas2DContainer.style.width = '100%';
        canvas2DContainer.style.borderRight = 'none';
        dataPlane.rotation.set(0, 0, 0);
        dataPlane.position.set(0, 0, 0);
    } else {
        canvas2DContainer.style.display = 'flex';
        canvas2DContainer.style.width = '50%';
        canvas2DContainer.style.borderRight = '2px solid #333';
        dataPlane.rotation.set(0, 0, 0);
        dataPlane.position.set(0, 0, 0);
        camera3D.position.set(0, 0, 3.5);
    }
    updateCameras();
    camera2D.lookAt(0, 0, 0);
    camera3D.lookAt(0, 0, 0);
    updateFrame();
});

// Initialization
updateCameras();
camera2D.lookAt(0, 0, 0);
camera3D.lookAt(0, 0, 0);
updateFrame();
initParticles(); // Démarrage du système de particules

// Flag d'avancement : true uniquement lors d'un tick Play
let _doAdvance = false;

function animateLoop(t) {
    requestAnimationFrame(animateLoop);
    controls.update();

    _doAdvance = false; // reset chaque frame RAF

    if (isPlaying && (t - lastFrameTime >= msPerFrame)) {
        lastFrameTime = t;

        const nextFrame = (PARAMS.currentFrame + 1) % PARAMS.frames;
        // On force le reset à CHAQUE changement de jour pour garder la clarté du slider
        resetParticles();
        PARAMS.currentFrame = nextFrame;
        updateFrame();
        _doAdvance = true;
    }

    // Géométrie à 60fps fluide, physique synchronisée avec la simulation
    updateParticles(PARAMS.currentFrame, _doAdvance);



    const W = mainContent.clientWidth;
    const H = mainContent.clientHeight;

    if (PARAMS.viewMode === 0) {
        // --- RENDU 100% 3D ---
        renderer.setViewport(0, 0, W, H);
        renderer.setScissorTest(false);
        material.uniforms.u_is3D.value = 1.0;

        dataPlane.visible = false; basePlane.visible = false;
        dataSphere.visible = true; globe.visible = true; graticule.visible = true;
        if (coastMesh) coastMesh.visible = true; // 🛡️ SÉCURITÉ ICI

        const camPos = camera3D.position;
        const camDir = camPos.clone().normalize();
        markers.forEach(m => {
            const isVisible = (camDir.dot(m.position.clone().normalize()) > 0);
            m.visible = isVisible;
            if (isVisible && m.userData.sprite) {
                m.userData.sprite.visible = true; // Toujours visible si le marqueur est du bon côté du globe
            }
        });
        renderer.render(scene, camera3D);

    } else if (PARAMS.viewMode === 1) {
        // --- RENDU 100% 2D ---
        renderer.setViewport(0, 0, W, H);
        renderer.setScissorTest(false);
        material.uniforms.u_is3D.value = 0.0;

        dataPlane.visible = true; basePlane.visible = true;
        dataSphere.visible = false; globe.visible = false; graticule.visible = false;
        if (coastMesh) coastMesh.visible = false; // 🛡️ SÉCURITÉ ICI
        markers.forEach(m => { m.visible = false; });
        renderer.render(scene, camera2D);

    } else if (PARAMS.viewMode === 2) {
        // --- RENDU COMPARATIF (SPLIT) ---
        const W = mainContent.clientWidth;
        const H = mainContent.clientHeight;
        const halfW = W / 2;
        renderer.setScissorTest(true);

        // GAUCHE (2D)
        renderer.setViewport(0, 0, halfW, H);
        renderer.setScissor(0, 0, halfW, H);
        material.uniforms.u_is3D.value = 0.0;
        dataPlane.visible = true; basePlane.visible = true;
        dataSphere.visible = false; globe.visible = false; graticule.visible = false;

        // 🛡️ ON CACHE LES FLÈCHES 3D ICI
        if (trailMesh) trailMesh.visible = false;

        if (coastMesh) coastMesh.visible = false;
        markers.forEach(m => { m.visible = false; });
        renderer.render(scene, camera2D);

        // DROITE (3D)
        renderer.setViewport(halfW, 0, halfW, H);
        renderer.setScissor(halfW, 0, halfW, H);
        material.uniforms.u_is3D.value = 1.0;
        dataPlane.visible = false; basePlane.visible = false;
        dataSphere.visible = true; globe.visible = true; graticule.visible = true;

        // 🛡️ ON RÉACTIVE LES FLÈCHES 3D ICI
        if (trailMesh) trailMesh.visible = PARAMS.showWind;

        if (coastMesh) coastMesh.visible = true;
        const camPos = camera3D.position;
        const camDir = camPos.clone().normalize();
        markers.forEach(m => {
            const isVisible = (camDir.dot(m.position.clone().normalize()) > 0);
            m.visible = isVisible;
            if (isVisible && m.userData.sprite) m.userData.sprite.visible = true;
        });
        renderer.render(scene, camera3D);

        renderer.setScissorTest(false);
    }
}
requestAnimationFrame(animateLoop);

window.addEventListener('resize', updateCameras);
loadData();
// ============================================================================
// ── UI V3 : DRAG & DROP ET LECTURE MULTIPLE (.bin / .nc) ──
// ============================================================================
const tabArchives = document.getElementById('tab-archives');
const tabUpload = document.getElementById('tab-upload');
const uploadView = document.getElementById('upload-view');
const dropZoneBox = document.getElementById('drop-zone-box');
const btnBrowse = document.getElementById('btn-browse');
const fileInput = document.getElementById('file-input');

// 1. Activation de la sélection multiple
if (fileInput) {
    fileInput.setAttribute('multiple', '');
    fileInput.setAttribute('accept', '.nc,.bin,.ft*');
}

// -- VÉRITABLE DRAG & DROP --
if (dropZoneBox) {
    dropZoneBox.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZoneBox.style.background = 'rgba(255,255,255,0.1)';
        dropZoneBox.style.border = '2px dashed #00bfff';
    });
    dropZoneBox.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZoneBox.style.background = 'transparent';
        dropZoneBox.style.border = 'none';
    });
    dropZoneBox.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZoneBox.style.background = 'transparent';
        dropZoneBox.style.border = 'none';

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFileSelection(e.dataTransfer.files);
        }
    });
}

// --- LOGIQUE DES ONGLETS AVEC RESET ---
// --- LOGIQUE DES ONGLETS CORRIGÉE ---
// --- LOGIQUE DES ONGLETS CORRIGÉE ET COMPLÈTE ---
if (tabArchives && tabUpload) {

    // 1. CLIC SUR ARCHIVES
    tabArchives.addEventListener('click', () => {
        // 1. Arrêt de la lecture
        isPlaying = false;
        btnPlay.textContent = '▶ Play';
        btnPlay.classList.remove('playing');

        // 2. Mise en surbrillance de l'onglet
        tabArchives.classList.add('active-tab');
        tabUpload.classList.remove('active-tab');

        // 3. Gestion de l'affichage des menus
        if (uploadView) uploadView.style.display = 'none';
        if (archiveUI) archiveUI.style.display = 'block';
        if (localUI) localUI.style.display = 'none'; // Cache les options locales
        if (commonUI) commonUI.style.display = 'block'; // On remontre le bouton Play

        // 4. On remet la date dans le coin gauche
        if (uiDateDisplay) {
            uiDateDisplay.parentElement.style.width = "auto";
            uiDateDisplay.parentElement.style.textAlign = "left";
        }

        // 5. On recharge les données d'archives
        isLocalData = false;
        PARAMS.currentFrame = 0;
        loadData();
    });

    // 2. CLIC SUR IMPORT LOCAL
    tabUpload.addEventListener('click', () => {
        // 1. Arrêt de la lecture
        isPlaying = false;
        btnPlay.textContent = '▶ Play';
        btnPlay.classList.remove('playing');

        // 2. Mise en surbrillance de l'onglet
        tabUpload.classList.add('active-tab');
        tabArchives.classList.remove('active-tab');

        // 3. Gestion de l'affichage des menus
        if (archiveUI) archiveUI.style.display = 'none'; // Cache (Period, Tracer...)
        if (localUI) localUI.style.display = 'block'; // Affiche les options locales s'il y a lieu

        if (localBuffer) {
            uploadView.style.display = 'none'; // On cache la zone de drop pour afficher le globe
            if (commonUI) commonUI.style.display = 'block'; // Affiche la barre de lecture
        } else {
            uploadView.style.display = 'flex'; // Affiche la zone de drop
            if (commonUI) commonUI.style.display = 'none'; // Cache le bouton Play
        }

        // 4. Étire le conteneur et centre le texte au milieu de l'écran si pas de données locales
        if (uiDateDisplay) {
            if (!localBuffer) {
                uiDateDisplay.innerText = "WAITING FOR FILES...";
                uiDateDisplay.parentElement.style.width = "100%";
                uiDateDisplay.parentElement.style.textAlign = "center";
                uiDateDisplay.parentElement.style.display = "block";
            } else {
                uiDateDisplay.parentElement.style.width = "auto";
                uiDateDisplay.parentElement.style.textAlign = "left";
                // L'affichage de la bannière se mettra à jour automatiquement via updateFrame()
            }
        }

        // 5. Déclenche la fonction qui met le globe à zéro
        isLocalData = true;
        updateFrame();
    });

    // Le clic sur "Retour aux Archives"
    const btnBackArchives = document.getElementById('btn-back-archives');
    if (btnBackArchives) {
        btnBackArchives.addEventListener('click', (e) => {
            e.preventDefault();
            if (tabArchives) tabArchives.click();
        });
    }

    // Le bouton parcourir
    btnBrowse.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => handleFileSelection(e.target.files));
}

// 2. Validation et Routage (Version Multi-fichiers)
function handleFileSelection(files) {
    if (!files || files.length === 0) return;

    const fileList = Array.from(files);
    const fileName = fileList[0].name.toLowerCase();

    if (fileName.endsWith('.nc')) {
        console.log("Lecture NetCDF locale");
    } else if (fileName.includes('.ft')) {
        currentUploadedFiles = fileList;
        processMultipleGRIBWithVercel(fileList, 150); // Toujours le Japon
    } else if (fileName.includes('.bin')) {
        readMultipleBinFiles(fileList);
    }
}

async function scanFileForVariables(file) {
    if (typeof uiDateDisplay !== 'undefined') uiDateDisplay.innerText = "SCANNING FILE...";

    const formData = new FormData();
    formData.append("file", file);
    formData.append("action", "scan");

    try {
        const response = await fetch('https://isogsm-backend.onrender.com/decode', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();

        if (result.variables && result.variables.length > 0) {
            buildVariableMenu(result.variables);
            // On lance le décodage initial avec la première variable de la liste
            processMultipleGRIBWithVercel(currentUploadedFiles, result.variables[0].id);
        } else {
            throw new Error("No variables found in file.");
        }
    } catch (e) {
        console.error("Scanning error:", e);
        if (typeof uiDateDisplay !== 'undefined') uiDateDisplay.innerText = "SCANNING ERROR";
    }
}

function buildVariableMenu(variables) {
    const container = document.getElementById('local-specific-ui');
    let selectMenu = document.getElementById('dynamic-tracer-select');

    // Si le menu n'existe pas, on le crée
    if (!selectMenu) {
        selectMenu = document.createElement('select');
        selectMenu.id = 'dynamic-tracer-select';
        selectMenu.style.width = '100%';
        selectMenu.style.marginBottom = '10px';
        selectMenu.style.padding = '4px';

        if (container) {
            container.appendChild(selectMenu);
        }

        // Événement : Relance le décodage complet si on change de variable
        selectMenu.addEventListener('change', (e) => {
            const newParamId = parseInt(e.target.value);
            processMultipleGRIBWithVercel(currentUploadedFiles, newParamId);
        });
    }

    // Peupler le menu
    selectMenu.innerHTML = '';
    variables.forEach(v => {
        const option = document.createElement('option');
        option.value = v.id;
        const displayName = v.name !== 'unknown' ? v.name : `Tracer (ID: ${v.id})`;
        option.innerText = `[Lvl ${v.level}] ${displayName}`;
        selectMenu.appendChild(option);
    });
}

async function processMultipleGRIBWithVercel(files, paramId = 150) {
    try {
        console.warn(`[DEBUG IsoGSM] processMultipleGRIBWithVercel appelé avec ${files.length} fichiers !`);

        if (typeof uiDateDisplay !== 'undefined' && uiDateDisplay) {
            uiDateDisplay.innerText = `DECODING ${files.length} FILES...`;
            uiDateDisplay.parentElement.style.display = "block";
        }

        // 1. Sort files sequentially (ft00, ft24, ft48...)
        files.sort((a, b) => {
            const numA = parseInt(a.name.match(/\d+/)?.[0] || 0);
            const numB = parseInt(b.name.match(/\d+/)?.[0] || 0);
            return numA - numB;
        });

        const GRID_SIZE = 192 * 94;
        const combinedBuffer = new Float32Array(files.length * GRID_SIZE);
        const combinedBufferU = new Float32Array(files.length * GRID_SIZE);
        const combinedBufferV = new Float32Array(files.length * GRID_SIZE);
        let framesLoaded = 0;

        const fetchParam = async (id, file) => {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("param_id", id);
            formData.append("action", "decode");
            const response = await fetch('https://isogsm-backend.onrender.com/decode', {
                method: 'POST',
                body: formData
            });
            if (!response.ok) return null;
            return (await response.json()).data;
        };

        // 2. Process each file
        for (let i = 0; i < files.length; i++) {
            console.log(`[DEBUG IsoGSM] Envoi du fichier ${i + 1}/${files.length} : ${files[i].name} (150, 33, 34)`);

            if (typeof uiDateDisplay !== 'undefined' && uiDateDisplay) {
                uiDateDisplay.innerText = `DECODING: ${i + 1} / ${files.length}...`;
            }

            const [data150, dataU, dataV] = await Promise.all([
                fetchParam(150, files[i]), // PWAT
                fetchParam(33, files[i]),  // U
                fetchParam(34, files[i])   // V
            ]);

            if (!data150 || !dataU || !dataV) {
                console.error(`[DEBUG IsoGSM] Server error/missing data for ${files[i].name}.`);
                continue; // Skip failed files, don't crash
            }

            // 3. Clean and map data
            const cleanArray = (dataArr) => new Float32Array(dataArr).map(v => (v > 1000 || isNaN(v)) ? 0 : v);

            combinedBuffer.set(cleanArray(data150), framesLoaded * GRID_SIZE);
            combinedBufferU.set(cleanArray(dataU), framesLoaded * GRID_SIZE);
            combinedBufferV.set(cleanArray(dataV), framesLoaded * GRID_SIZE);

            framesLoaded++;
            console.log(`[DEBUG IsoGSM] framesLoaded vaut maintenant : ${framesLoaded}`);
        }

        if (framesLoaded === 0) throw new Error("No files were successfully processed.");

        // 4. Update the 3D Player state
        localBuffer = combinedBuffer.slice(0, framesLoaded * GRID_SIZE);
        localBufferU = combinedBufferU.slice(0, framesLoaded * GRID_SIZE);
        localBufferV = combinedBufferV.slice(0, framesLoaded * GRID_SIZE);
        localFramesLoaded = framesLoaded;
        console.warn(`[DEBUG IsoGSM] FIN. Mise à jour de PARAMS.frames à ${framesLoaded} !`);

        PARAMS.frames = framesLoaded;
        PARAMS.currentFrame = 0;
        isLocalData = true;

        if (typeof sliderTime !== 'undefined' && sliderTime) {
            sliderTime.max = framesLoaded - 1;
            sliderTime.value = 0;
        }

        const datasetLabel = document.getElementById('dataset-label');
        if (datasetLabel) datasetLabel.innerText = `${framesLoaded} .ft file(s) decoded`;

        if (typeof uploadView !== 'undefined' && uploadView) uploadView.style.display = 'none';
        if (typeof commonUI !== 'undefined' && commonUI) commonUI.style.display = 'block';

        updateFrame();
        console.log(`Success: ${framesLoaded} frames loaded and assembled.`);

    } catch (error) {
        console.error("Vercel decoding error:", error);
        alert("Error during decoding: " + error.message);
        if (typeof uiDateDisplay !== 'undefined' && uiDateDisplay) {
            uiDateDisplay.innerText = "WAITING FOR FILES...";
        }
    }
}




async function readMultipleBinFiles(files) {
    const GRID_SIZE = 192 * 94;
    const BYTES_PER_GRID = GRID_SIZE * 4;

    // ---------------------------------------------------------
    // 🛠️ RÉGLAGE IMPORTANT : Index de la variable (Record)
    // Ton fichier de 2.6 Mo contient plein de variables.
    // PWAT n'est probablement pas la première (0). 
    // Il faudra ajuster ce chiffre pour trouver la bonne carte !
    // ---------------------------------------------------------
    const RECORD_INDEX_TO_EXTRACT = 38;

    // Trie les fichiers dans le bon ordre chronologique (ft00, ft24, ft48...)
    files.sort((a, b) => {
        const numA = parseInt(a.name.match(/\d+/)?.[0] || 0);
        const numB = parseInt(b.name.match(/\d+/)?.[0] || 0);
        return numA - numB;
    });

    let totalFrames = 0;
    let allFramesData = [];

    try {
        for (let file of files) {
            const arrayBuffer = await file.arrayBuffer();
            const dataView = new DataView(arrayBuffer);
            const fileSize = arrayBuffer.byteLength;

            // 1. Détection automatique de l'Endianness
            let isLittleEndian = true;
            if (dataView.getUint32(0, true) > 100000000) {
                isLittleEndian = false;
            }

            const frameData = new Float32Array(GRID_SIZE);
            let offset = 0;
            let currentRecord = 0;
            let dataFound = false;

            // 2. L'Explorateur de Fichier Fortran
            while (offset < fileSize) {
                const recordLength = dataView.getUint32(offset, isLittleEndian);
                offset += 4;

                if (currentRecord === RECORD_INDEX_TO_EXTRACT) {
                    if (recordLength === BYTES_PER_GRID) {
                        for (let i = 0; i < GRID_SIZE; i++) {
                            frameData[i] = dataView.getFloat32(offset + i * 4, isLittleEndian);
                        }
                        dataFound = true;
                    } else {
                        console.warn(`Warning: Variable No. ${RECORD_INDEX_TO_EXTRACT} does not correspond to a 192x94 2D grid.`);
                    }
                    break;
                }

                offset += recordLength;
                offset += 4;
                currentRecord++;
            }

            if (dataFound) {
                allFramesData.push(frameData);
                totalFrames++;
            }
        }

        if (totalFrames === 0) {
            alert(`No compatible data could be extracted at index ${RECORD_INDEX_TO_EXTRACT}.`);
            return;
        }

        // 3. Fusion de toutes les frames
        const combinedBuffer = new Float32Array(totalFrames * GRID_SIZE);
        for (let i = 0; i < totalFrames; i++) {
            combinedBuffer.set(allFramesData[i], i * GRID_SIZE);
        }

        // 4. Mise à jour du moteur 3D
        localFramesLoaded = totalFrames;
        PARAMS.frames = totalFrames;
        PARAMS.currentFrame = 0;
        if (sliderTime) sliderTime.max = PARAMS.frames - 1;
        localBuffer = combinedBuffer;
        isLocalData = true;

        const datasetLabel = document.getElementById('dataset-label');
        if (datasetLabel) datasetLabel.innerText = `${totalFrames} file(s) loaded`;
        if (uploadView) uploadView.style.display = 'none';
        if (commonUI) commonUI.style.display = 'block';

        updateFrame();
        console.log(`Success: ${totalFrames} frames in ${isLittleEndian ? "Little-Endian" : "Big-Endian"}`);

    } catch (err) {
        console.error("Fortran reading error:", err);
        alert("Error during binary decoding of files.");
    }
}
