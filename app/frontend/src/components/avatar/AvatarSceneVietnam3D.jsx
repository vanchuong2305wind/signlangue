/**
 * AvatarSceneVietnam3D.jsx — Tab "3D Việt Nam" của trang Dịch.
 *
 * Chép từ mô hình 3D của chrome-extension-siglang (áo đỏ sao vàng, nón lá,
 * sàn chữ DUT) nhưng lấy dữ liệu từ backend VieSign giống tab "3D Avatar":
 * landmark tải qua /api/landmarks/<gloss> và dùng chung VrmHolisticRetargeter.
 *
 * Sửa triệt để lỗi giật/reset mô hình 3D:
 * - Three.js Scene & WebGLRenderer chỉ khởi tạo ĐÚNG 1 LẦN khi mở Popup.
 * - Các callback (`onPlayingSign`, `onStatusChange`) được giữ trong `useRef` để
 *   không bao giờ kích hoạt `useEffect` khởi tạo lại cảnh 3D khi cha re-render
 *   (ví dụ khi gõ từng chữ cái vào ô input hoặc khi phụ đề cập nhật).
 */

import { useEffect, useRef, useState, useImperativeHandle, forwardRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VrmHolisticRetargeter } from './vrm-holistic-retargeter';

/* ==================== CONSTANTS ==================== */

const TRANSITION_DURATION = 0.16;
const PLAYBACK_SPEED_MULTIPLIER = 1.25;

/* ==================== HELPER FUNCTIONS ==================== */

function lerpLandmarks(a, b, t) {
  if (!a || !b) return a || b;
  return a.map((av, i) => {
    const bv = b[i] || av;
    return {
      x: av.x + (bv.x - av.x) * t,
      y: av.y + (bv.y - av.y) * t,
      z: (av.z || 0) + ((bv.z || 0) - (av.z || 0)) * t,
    };
  });
}

function resetPose(sd) {
  if (!sd) return;
  if (sd.vrmRetargeter) {
    sd.vrmRetargeter.reset();
  }
}

function disposeObject(obj, { disposeTextures = true } = {}) {
  if (!obj) return;
  obj.traverse((node) => {
    if (node.geometry) {
      node.geometry.dispose();
    }
    if (node.material) {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of materials) {
        if (disposeTextures) {
          for (const key of Object.keys(mat)) {
            const value = mat[key];
            if (value && typeof value.dispose === 'function') {
              value.dispose();
            }
          }
        }
        mat.dispose();
      }
    }
  });
}

const ACCESSORY_MATERIALS = new Set([
  'backpack_metal',
  'backpack_nm',
  'backpack_plastic',
  'green_emit',
  'robo_face',
  'glass',
  'arm_mat',
  'arm_plastic',
]);

function isAccessoryMaterial(material) {
  if (!material) return false;
  const materials = Array.isArray(material) ? material : [material];
  return materials.some((mat) => {
    const cleanName = (mat?.name || '')
      .toLowerCase()
      .replace(/\s*\(outline\)\s*$/i, '')
      .trim();
    return ACCESSORY_MATERIALS.has(cleanName);
  });
}

function removeNonHumanAccessories(root) {
  const accessoryName = /(^|[_.-])(robo|robot|mecha|bagpack|backpack)([_.-]|$)/i;
  const accessories = [];

  root.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    if (accessoryName.test(node.name || '') || isAccessoryMaterial(node.material)) {
      accessories.push(node);
    }
  });

  for (const accessory of accessories) {
    accessory.removeFromParent();
    disposeObject(accessory, { disposeTextures: false });
  }
}

/**
 * Tạo texture mặt sàn bên trong vòng tròn màu xanh có chữ "DUT" viết hoa dưới chân mô hình
 */
function createDutFloorDisc() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');

  const cx = 512;
  const cy = 512;

  // Nền tròn kem ấm bên trong vòng xanh
  const grad = ctx.createRadialGradient(cx, cy, 40, cx, cy, 500);
  grad.addColorStop(0, '#F5F1DF');
  grad.addColorStop(0.78, '#EAE4CE');
  grad.addColorStop(1, '#DFD8BE');

  ctx.beginPath();
  ctx.arc(cx, cy, 504, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Vòng chỉ mảnh màu xanh rêu bên trong
  ctx.beginPath();
  ctx.arc(cx, cy, 468, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(50, 88, 37, 0.35)';
  ctx.lineWidth = 6;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, 448, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(50, 88, 37, 0.18)';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([12, 10]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Chữ "DUT" viết hoa sắc nét đặt dưới chân mô hình bên trong vòng tròn xanh
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 148px "Libre Baskerville", "Georgia", "Arial Black", serif';

  // Bóng đổ nhẹ dưới chữ DUT
  ctx.fillStyle = 'rgba(50, 88, 37, 0.16)';
  ctx.fillText('DUT', cx, 736);

  // Viền kem sáng nổi bật
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#FFFCED';
  ctx.strokeText('DUT', cx, 730);

  // Màu chữ xanh rêu đậm đồng bộ với vòng tròn xanh
  ctx.fillStyle = '#325825';
  ctx.fillText('DUT', cx, 730);
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  const discGeo = new THREE.CircleGeometry(0.675, 64);
  const discMat = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.68,
    metalness: 0.05,
  });
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.003;
  disc.receiveShadow = true;
  return disc;
}

/**
 * Tạo texture lá cọ và các vòng tre đồng tâm cho chiếc Nón lá Việt Nam
 */
function createNonLaTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  // Nền màu lá nón tự nhiên
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#DFC48C');
  grad.addColorStop(0.5, '#EAD4A4');
  grad.addColorStop(1, '#D3B57A');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);

  // Các đường gân lá dọc theo thân nón
  ctx.strokeStyle = 'rgba(138, 102, 48, 0.16)';
  ctx.lineWidth = 1.5;
  for (let x = 0; x < 512; x += 6) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 512);
    ctx.stroke();
  }

  // Các vòng vành tre khâu đồng tâm trên nón lá
  for (let y = 28; y < 500; y += 30) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(512, y);
    ctx.strokeStyle = 'rgba(120, 82, 32, 0.36)';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // Đường mũi khâu nhỏ trên mỗi vành nón
    ctx.beginPath();
    ctx.setLineDash([4, 6]);
    ctx.moveTo(0, y + 2);
    ctx.lineTo(512, y + 2);
    ctx.strokeStyle = 'rgba(255, 248, 225, 0.45)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * Tạo hình ngôi sao vàng 5 cánh 3D chuẩn Quốc kỳ Việt Nam
 */
function createGoldenStarMesh(outerRadius = 0.056, innerRadius = 0.022, depth = 0.008) {
  const shape = new THREE.Shape();
  const points = 5;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = (i * Math.PI) / points + Math.PI / 2;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.0025,
    bevelSize: 0.002,
    bevelSegments: 2,
  });
  geo.center();

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffd700,
    emissive: 0xffb300,
    emissiveIntensity: 0.35,
    roughness: 0.25,
    metalness: 0.35,
  });

  const star = new THREE.Mesh(geo, mat);
  star.castShadow = true;
  return star;
}

/**
 * Nhuộm texture bộ đồ gốc (wear.png) sang màu đỏ cờ Việt Nam (#D81E1E),
 * giữ nguyên toàn bộ nếp gấp vải của bộ đồ gốc và vẽ thêm ngôi sao vàng 5 cánh ở chính giữa ngực.
 */
function createRedOriginalOutfitTexture(originalTex) {
  const img = originalTex?.image || originalTex?.source?.data;
  const width = img?.width || 1024;
  const height = img?.height || 1024;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (img) {
    ctx.drawImage(img, 0, 0, width, height);
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // Độ sáng giữ lại chi tiết nếp gấp vải gốc của bộ quần áo
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const shade = Math.min(1, Math.max(0.78, lum * 1.05));

      // Nhuộm toàn bộ áo và quần gốc sang màu đỏ cờ Việt Nam (#E01B1B) đồng nhất
      data[i] = Math.min(255, Math.round(shade * 232 + 12));
      data[i + 1] = Math.min(255, Math.round(shade * 22));
      data[i + 2] = Math.min(255, Math.round(shade * 22));
    }
    ctx.putImageData(imgData, 0, 0);
  } else {
    ctx.fillStyle = '#E01B1B';
    ctx.fillRect(0, 0, width, height);
  }

  // Vùng ngực trái nơi mesh anim_logo lấp vào 4 lỗ lục giác của áo:
  // Tô đồng nhất một màu đỏ chuẩn (#E81E1E) để 4 hình lục giác tiệp hoàn toàn vào nền áo đỏ, không còn dấu vết
  ctx.fillStyle = '#E81E1E';
  ctx.fillRect(Math.round(width * 0.32), Math.round(height * 0.15), Math.round(width * 0.18), Math.round(height * 0.25));

  const redTex = new THREE.CanvasTexture(canvas);
  redTex.colorSpace = THREE.SRGBColorSpace;
  redTex.flipY = originalTex ? originalTex.flipY : false;
  redTex.needsUpdate = true;
  return redTex;
}

/**
 * Giữ nguyên bộ quần áo gốc của nhân vật, đổi sang màu đỏ có ngôi sao vàng ở chính giữa ngực + đội Nón lá
 */
function applyVietnameseAoDaiAndNonLa(vrm) {
  let sharedRedTex = null;
  let baseRedMToonMat = null;

  // Bước 1: Tìm chất liệu MToon gốc của áo (huku_bake) để dùng chung cho cả phần vá lỗ logo (anim_logo)
  vrm.scene.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    for (const mat of mats) {
      if (!mat) continue;
      const rawName = (mat.name || '').toLowerCase();
      const mName = rawName.replace(/\s*\(outline\)\s*$/i, '').trim();
      if (mName === 'huku_bake' && !rawName.includes('(outline)') && !baseRedMToonMat) {
        const origTex = mat.map || mat.uniforms?.map?.value || null;
        sharedRedTex = createRedOriginalOutfitTexture(origTex);
        baseRedMToonMat = mat;
      }
    }
  });

  // Bước 2: Cập nhật màu đỏ cho toàn bộ quần áo gốc + lấp kín 4 lỗ lục giác (anim_logo) cùng màu đỏ áo
  vrm.scene.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    if (!node.material) return;

    const updateMat = (mat) => {
      if (!mat) return mat;
      const rawName = (mat.name || '').toLowerCase();
      const isOutline = rawName.includes('(outline)');
      const mName = rawName.replace(/\s*\(outline\)\s*$/i, '').trim();

      // Ẩn lớp viền (Outline) trên áo để không vẽ viền nâu/đen bên trong 4 lỗ lục giác trên ngực
      if (isOutline && (mName === 'huku_bake' || mName === 'armgear_plastic' || mName === 'wear_metal')) {
        mat.visible = false;
        if ('outlineWidthFactor' in mat) mat.outlineWidthFactor = 0;
        if (mat.uniforms?.outlineWidthFactor) mat.uniforms.outlineWidthFactor.value = 0;
        mat.needsUpdate = true;
        return mat;
      }

      // Gán chất liệu MToon đỏ của áo vào mesh anim_logo để bít kín 4 lỗ lục giác trên ngực trái
      if (mName === 'anim_logo' && baseRedMToonMat) {
        const patchMat = baseRedMToonMat.clone();
        patchMat.map = sharedRedTex;
        patchMat.shadeMultiplyTexture = sharedRedTex;
        if (patchMat.shadeColorFactor?.setRGB) {
          patchMat.shadeColorFactor.setRGB(0.82, 0.82, 0.82);
        }
        patchMat.needsUpdate = true;
        return patchMat;
      }

      if (mName === 'huku_bake' || mName === 'armgear_plastic' || mName === 'wear_metal' || mName === 'anim_logo') {
        if (!sharedRedTex) {
          const origTex = mat.map || mat.uniforms?.map?.value || null;
          sharedRedTex = createRedOriginalOutfitTexture(origTex);
        }
        if ('map' in mat) mat.map = sharedRedTex;
        if ('shadeMultiplyTexture' in mat) mat.shadeMultiplyTexture = sharedRedTex;
        if (mat.uniforms?.map) mat.uniforms.map.value = sharedRedTex;
        if (mat.uniforms?.shadeMultiplyTexture) {
          mat.uniforms.shadeMultiplyTexture.value = sharedRedTex;
        }
        if (mat.shadeColorFactor?.setRGB) {
          mat.shadeColorFactor.setRGB(0.82, 0.82, 0.82);
        } else if (mat.uniforms?.shadeColorFactor?.value?.setRGB) {
          mat.uniforms.shadeColorFactor.value.setRGB(0.82, 0.82, 0.82);
        }
        mat.needsUpdate = true;
        return mat;
      }
      return mat;
    };

    if (Array.isArray(node.material)) {
      node.material = node.material.map(updateMat);
    } else {
      node.material = updateMat(node.material);
    }
  });

  const outfitGroup = new THREE.Group();
  outfitGroup.name = 'vietnam_star_and_nonla';

  // 2. Ngôi sao vàng 5 cánh 3D đặt ngay chính giữa ngực bộ đồ gốc
  const frontStar = createGoldenStarMesh(0.052, 0.021, 0.007);
  frontStar.position.set(0, 1.072, 0.097);
  frontStar.rotation.x = -0.05;
  outfitGroup.add(frontStar);

  // 3. Đầu đội Nón lá Việt Nam
  const nonLaGroup = new THREE.Group();
  nonLaGroup.name = 'vietnam_non_la';

  const nonLaTex = createNonLaTexture();
  const nonLaMat = new THREE.MeshStandardMaterial({
    map: nonLaTex,
    roughness: 0.65,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });

  // Thân nón hình chóp
  const coneGeo = new THREE.ConeGeometry(0.245, 0.145, 64, 1, true);
  const coneMesh = new THREE.Mesh(coneGeo, nonLaMat);
  coneMesh.castShadow = true;
  coneMesh.receiveShadow = true;
  nonLaGroup.add(coneMesh);

  // Vành tre ngoài cùng của nón lá
  const brimMat = new THREE.MeshStandardMaterial({
    color: 0xc8a464,
    roughness: 0.55,
    metalness: 0.05,
  });
  const brimRingGeo = new THREE.TorusGeometry(0.245, 0.0045, 12, 64);
  const brimRing = new THREE.Mesh(brimRingGeo, brimMat);
  brimRing.rotation.x = Math.PI / 2;
  brimRing.position.y = -0.0725;
  nonLaGroup.add(brimRing);

  // Chóp nón nhỏ trên đỉnh
  const tipGeo = new THREE.ConeGeometry(0.014, 0.018, 24);
  const tipMesh = new THREE.Mesh(tipGeo, brimMat);
  tipMesh.position.y = 0.076;
  nonLaGroup.add(tipMesh);

  // Quai nón lụa đỏ mềm mại dưới cằm
  const strapMat = new THREE.MeshStandardMaterial({
    color: 0xd81e1e,
    roughness: 0.45,
    metalness: 0.05,
  });
  const strapCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.095, -0.055, 0.02),
    new THREE.Vector3(-0.075, -0.16, 0.045),
    new THREE.Vector3(0, -0.225, 0.062),
    new THREE.Vector3(0.075, -0.16, 0.045),
    new THREE.Vector3(0.095, -0.055, 0.02),
  ]);
  const strapGeo = new THREE.TubeGeometry(strapCurve, 32, 0.0032, 8, false);
  const strapMesh = new THREE.Mesh(strapGeo, strapMat);
  nonLaGroup.add(strapMesh);

  // Đặt nón lá ngay ngắn trên đầu nhân vật (hơi nghiêng nhẹ ra sau để lộ rõ gương mặt)
  nonLaGroup.position.set(0, 1.565, -0.018);
  nonLaGroup.rotation.x = -0.15;
  outfitGroup.add(nonLaGroup);

  vrm.scene.add(outfitGroup);
}

/* ==================== COMPONENT ==================== */

const AvatarSceneVietnam3D = forwardRef(function AvatarSceneVietnam3D(
  { className, style, onStatusChange, onPlayingSign, minimalUI = false },
  ref
) {
  const containerRef = useRef(null);
  const sceneDataRef = useRef(null);
  const rendererRef = useRef(null);
  const animFrameRef = useRef(null);

  // Giữ các callback ở trong ref để việc re-render của App (khi gõ phím, khi đồng bộ thời gian)
  // KHÔNG BAO GIỜ kích hoạt lại useEffect khởi tạo cảnh 3D.
  const callbacksRef = useRef({ onStatusChange, onPlayingSign });
  useEffect(() => {
    callbacksRef.current = { onStatusChange, onPlayingSign };
  }, [onStatusChange, onPlayingSign]);

  const animDataRef = useRef({
    queue: [],
    isPlaying: false,
    currentSign: null,
    currentFrames: null,
    currentFrameIdx: 0,
    currentFps: 25,
    frameTimer: 0,
    isTransitioning: false,
    transitionProgress: 0,
    prevLeftLandmarks: null,
    prevRightLandmarks: null,
    pendingCount: 0,
    awaitingData: false,
    runId: 0,
  });

  const landmarkCacheRef = useRef(new Map());
  const playNextRef = useRef(null);

  const [status, setStatus] = useState('Đang tải mô hình 3D...');
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [currentGloss, setCurrentGloss] = useState(null);

  const updateStatus = useCallback((text) => {
    setStatus(text);
    callbacksRef.current.onStatusChange?.(text);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    setIsModelLoaded(false);

    const scene = new THREE.Scene();
    const clock = new THREE.Clock();

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
        failIfMajorPerformanceCaveat: false,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      const w = Math.max(container.clientWidth, 1);
      const h = Math.max(container.clientHeight, 1);
      renderer.setSize(w, h);
      container.appendChild(renderer.domElement);
      rendererRef.current = renderer;
    } catch {
      setLoadError('WebGL không khởi tạo được.');
      return;
    }

    const onContextLost = (e) => {
      e.preventDefault();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
    const onContextRestored = () => {
      if (!disposed) animate();
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

    const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1);
    const camera = new THREE.PerspectiveCamera(38, aspect, 0.05, 50);
    // Lùi xa hơn bản extension: khung ở trang Dịch cao hơn popup, cần thấy trọn nón lá.
    camera.position.set(0, 0.9, 2.6);
    camera.lookAt(0, 0.76, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    const hemi = new THREE.HemisphereLight(0xe8f4ff, 0x8eaacc, 0.75);
    hemi.position.set(0, 2, 0);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2.5, 3, 2.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xb7d7ff, 0.9);
    fill.position.set(-2.5, 2, 1.5);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0x88ddff, 0.7);
    rim.position.set(0, 1.5, -3);
    scene.add(rim);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;
    pmrem.dispose();

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.76, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.5;
    controls.maxDistance = 3.5;
    controls.maxPolarAngle = Math.PI * 0.65;
    controls.minPolarAngle = Math.PI * 0.15;
    controls.update();

    scene.background = new THREE.Color(0xefece0);

    const floorGeo = new THREE.CircleGeometry(2, 48);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0xe2dec9,
      roughness: 0.75,
      metalness: 0.08,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Mặt sàn bên trong vòng tròn màu xanh có chữ "DUT" viết hoa dưới chân mô hình
    const dutFloorDisc = createDutFloorDisc();
    scene.add(dutFloorDisc);

    const ringGeo = new THREE.TorusGeometry(0.68, 0.014, 12, 64);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x325825,
      emissive: 0x307436,
      emissiveIntensity: 0.28,
      roughness: 0.45,
      metalness: 0.1,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.006;
    scene.add(ring);

    const grid = new THREE.GridHelper(3, 18, 0xc7bfa8, 0xdad4c0);
    grid.position.y = 0.001;
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    scene.add(grid);

    async function loadVrmAvatar() {
      const vrmUrl = '/models/avatar.vrm';
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(vrmUrl);
      if (disposed) return true;

      const vrm = gltf.userData.vrm;
      if (!vrm) throw new Error('avatar.vrm lacks VRM metadata');

      removeNonHumanAccessories(gltf.scene);
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      VRMUtils.rotateVRM0(vrm);

      removeNonHumanAccessories(vrm.scene);

      const box = new THREE.Box3().setFromObject(vrm.scene);
      const size = box.getSize(new THREE.Vector3());
      vrm.scene.scale.setScalar(1.35 / Math.max(size.y, 0.01));
      vrm.scene.position.set(0, 0, 0);

      // Mặc Áo dài Việt Nam màu đỏ có ngôi sao vàng ở chính giữa + đội Nón lá
      applyVietnameseAoDaiAndNonLa(vrm);

      vrm.scene.traverse((node) => {
        if (!node.isMesh) return;
        node.castShadow = true;
        node.receiveShadow = true;
        node.frustumCulled = false;
      });
      scene.add(vrm.scene);
      vrm.scene.updateMatrixWorld(true);

      sceneDataRef.current = {
        vrm,
        vrmRetargeter: new VrmHolisticRetargeter(vrm),
      };
      setIsModelLoaded(true);
      updateStatus('Nhân vật 3D toàn thân sẵn sàng');
      return true;
    }

    loadVrmAvatar().catch((err) => {
      console.error('[AvatarSceneVietnam3D] Lỗi tải nhân vật 3D:', err);
      setLoadError('Không tải được mô hình nhân vật 3D.');
    });

    function playNextInQueue() {
      const anim = animDataRef.current;
      const sd = sceneDataRef.current;

      if (sd && anim.queue.length === 0 && anim.pendingCount > 0) {
        anim.awaitingData = true;
        anim.currentFrames = null;
        anim.currentFrameIdx = 0;
        anim.frameTimer = 0;
        updateStatus('Đang chuẩn bị động tác tiếp theo...');
        return;
      }

      if (!sd || anim.queue.length === 0) {
        anim.isPlaying = false;
        anim.awaitingData = false;
        anim.currentFrames = null;
        anim.currentSign = null;
        anim.currentFrameIdx = 0;
        anim.frameTimer = 0;
        resetPose(sd);
        setCurrentGloss(null);
        updateStatus('Sẵn sàng phiên dịch');
        callbacksRef.current.onPlayingSign?.(null);
        return;
      }

      anim.awaitingData = false;
      anim.isPlaying = true;
      const current = anim.queue.shift();
      anim.currentSign = current;
      anim.currentFrames = current.data.frames;
      anim.currentFps = (current.data.fps || 25) * PLAYBACK_SPEED_MULTIPLIER;
      anim.currentFrameIdx = 0;
      anim.frameTimer = 0;
      anim.isTransitioning = true;
      anim.transitionProgress = 0;

      const label = `Đang ký: ${current.vi}`;
      updateStatus(label);
      setCurrentGloss(current.vi || current.gloss);
      callbacksRef.current.onPlayingSign?.(current);
    }

    playNextRef.current = playNextInQueue;

    function updateAnimation(delta) {
      const anim = animDataRef.current;
      const sd = sceneDataRef.current;
      if (!anim.isPlaying || !anim.currentFrames || !sd) return;

      if (anim.isTransitioning) {
        anim.transitionProgress += delta / TRANSITION_DURATION;
        if (anim.transitionProgress >= 1) {
          anim.isTransitioning = false;
          anim.transitionProgress = 1;
        }
        if (anim.currentFrames.length > 0 && sd.vrmRetargeter) {
          const firstFrame = anim.currentFrames[0];
          sd.vrmRetargeter.apply(firstFrame, delta);
        }
        return;
      }

      anim.frameTimer += delta;
      const frameDuration = 1 / anim.currentFps;

      if (anim.frameTimer >= frameDuration) {
        anim.frameTimer -= frameDuration;
        anim.currentFrameIdx++;

        if (anim.currentFrameIdx >= anim.currentFrames.length) {
          playNextInQueue();
          return;
        }
      }

      const frame = anim.currentFrames[anim.currentFrameIdx];
      if (!frame) return;

      const nextIdx = Math.min(anim.currentFrameIdx + 1, anim.currentFrames.length - 1);
      const nextFrame = anim.currentFrames[nextIdx];
      const t = anim.frameTimer / frameDuration;

      if (sd.vrmRetargeter) {
        sd.vrmRetargeter.apply(
          {
            ...frame,
            pose: lerpLandmarks(frame.pose, nextFrame?.pose || frame.pose, t),
            pose_world: lerpLandmarks(
              frame.pose_world,
              nextFrame?.pose_world || frame.pose_world,
              t
            ),
            left_hand: lerpLandmarks(frame.left_hand, nextFrame?.left_hand || frame.left_hand, t),
            right_hand: lerpLandmarks(
              frame.right_hand,
              nextFrame?.right_hand || frame.right_hand,
              t
            ),
          },
          delta
        );
      }
    }

    function animate() {
      if (disposed) return;
      animFrameRef.current = requestAnimationFrame(animate);

      const delta = clock.getDelta();
      controls.update();
      updateAnimation(delta);
      renderer.render(scene, camera);
    }

    animate();

    let lastW = 0,
      lastH = 0;
    let resizeRafId = null;
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      if (resizeRafId) cancelAnimationFrame(resizeRafId);
      resizeRafId = requestAnimationFrame(() => {
        if (!container || !renderer || !camera || disposed) return;
        const w = Math.max(container.clientWidth, 1);
        const h = Math.max(container.clientHeight, 1);
        if (w === lastW && h === lastH) return;
        lastW = w;
        lastH = h;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      });
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);

      disposeObject(scene);
      if (envTexture) envTexture.dispose();

      controls.dispose();
      renderer.dispose();
      renderer.forceContextLoss();

      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }

      rendererRef.current = null;
      sceneDataRef.current = null;
    };
  }, [updateStatus]);

  /* ---------- Load VieSign Landmarks from the Backend (same source as 3D Avatar) ---------- */
  const loadLandmarks = useCallback(async (sign) => {
    const glossKey = (sign.gloss || '').trim();
    if (!glossKey) return null;

    const cache = landmarkCacheRef.current;
    const cached = cache.get(glossKey);
    if (cached) {
      const data = await cached;
      return data ? { gloss: sign.gloss, vi: sign.vi, data } : null;
    }

    const request = (async () => {
      const resp = await fetch(`/api/landmarks/${encodeURIComponent(glossKey)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json();
      if (!result.data?.frames?.length) throw new Error('empty landmark frames');
      return result.data;
    })();

    cache.set(glossKey, request);
    try {
      const data = await request;
      cache.set(glossKey, data);
      return { gloss: sign.gloss, vi: sign.vi, data };
    } catch (err) {
      cache.delete(glossKey);
      throw err;
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      preloadSigns(signs) {
        for (const sign of signs || []) {
          if (sign?.found && sign?.gloss) {
            loadLandmarks(sign).catch(() => {});
          }
        }
      },

      async playSignSequence(signs) {
        const sd = sceneDataRef.current;
        if (!sd) return;

        const foundSigns = (signs || []).filter((s) => s.found && s.gloss);
        if (foundSigns.length === 0) return;

        const anim = animDataRef.current;
        const runId = anim.runId + 1;
        anim.runId = runId;
        anim.queue = [];
        anim.pendingCount = foundSigns.length;
        anim.awaitingData = false;

        const requests = foundSigns.map((sign) => loadLandmarks(sign));

        for (const request of requests) {
          let loaded = null;
          try {
            loaded = await request;
          } catch (err) {
            console.warn('[Avatar3D] Không tìm thấy file landmark:', err);
          }

          if (anim.runId !== runId) return;

          anim.pendingCount -= 1;
          if (!loaded) continue;

          anim.queue.push(loaded);
          if (!anim.isPlaying || anim.awaitingData) {
            playNextRef.current?.();
          }
        }

        if (anim.runId !== runId) return;

        if (anim.awaitingData && anim.queue.length === 0) {
          playNextRef.current?.();
        }
      },

      stopAnimation() {
        const anim = animDataRef.current;
        anim.runId += 1;
        anim.isPlaying = false;
        anim.pendingCount = 0;
        anim.awaitingData = false;
        anim.queue = [];
        anim.currentFrames = null;
        anim.currentSign = null;
        anim.currentFrameIdx = 0;
        anim.frameTimer = 0;
        anim.isTransitioning = false;
        resetPose(sceneDataRef.current);
        setCurrentGloss(null);
        updateStatus('Sẵn sàng phiên dịch');
      },

      get isModelLoaded() {
        return isModelLoaded;
      },
    }),
    [isModelLoaded, updateStatus, loadLandmarks]
  );

  if (loadError) {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#EFECE0',
          borderRadius: '12px',
        }}
      >
        <p style={{ color: '#5F2A1A', fontSize: '13px', textAlign: 'center', padding: '16px' }}>
          ❌ {loadError}
        </p>
      </div>
    );
  }

  return (
      <div
        ref={containerRef}
        className={className}
        style={{
          width: '100%',
          height: '100%',
          borderRadius: minimalUI ? '0px' : '12px',
          overflow: 'hidden',
          position: 'relative',
          ...style,
        }}
      >
        {!isModelLoaded && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(255, 252, 237, 0.94)',
              zIndex: 2,
            }}
          >
            <div className="avatar-loader" />
            <p
              style={{
                color: '#325825',
                fontSize: '12px',
                fontWeight: 600,
                marginTop: '10px',
              }}
            >
              Đang nạp mô hình ngôn ngữ ký hiệu 3D...
            </p>
          </div>
        )}

        {!minimalUI && (
          <div
            style={{
              position: 'absolute',
              bottom: '8px',
              left: '8px',
              right: '8px',
              padding: '6px 12px',
              background: 'rgba(232, 230, 218, 0.92)',
              backdropFilter: 'blur(6px)',
              borderRadius: '60px',
              border: '1px solid rgba(75, 45, 21, 0.14)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              zIndex: 1,
              pointerEvents: 'none',
            }}
          >
            <span style={{ color: '#4B2D15', fontSize: '11.5px', fontWeight: 600 }}>{status}</span>
            {currentGloss && (
              <span
                style={{
                  padding: '2px 10px',
                  background: '#325825',
                  borderRadius: '100px',
                  color: '#FFFCED',
                  fontSize: '10.5px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.4px',
                }}
              >
                {currentGloss}
              </span>
            )}
          </div>
        )}
      </div>
  );
});

export default AvatarSceneVietnam3D;
