import { buildCueTimeline, sampleCue } from './cue-timeline';
/**
 * AvatarScene3D.jsx — Fixed & Optimized
 *
 * Key fixes:
 * 1. Replaced THREE.Timer with THREE.Clock (more reliable across versions)
 * 2. Pre-allocated Vector3/Quaternion/Matrix4 reused per-frame (zero GC)
 * 3. Proper Three.js dispose on unmount (geometry, material, texture, renderer)
 * 4. Correct light positioning
 * 5. Lazy initialization — scene created only once, never remounted
 * 6. ResizeObserver instead of window resize for container-aware sizing
 */

import { useEffect, useRef, useState, useImperativeHandle, forwardRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VrmHolisticRetargeter } from './vrm-holistic-retargeter';

/* ==================== CONSTANTS ==================== */

const BONE_MAP = {
    thumb: { base: 'thumb_baseR', b01: 'thumb_01R', b02: 'thumb_02R', b03: 'thumb_03R' },
    index: { base: 'index_baseR', b01: 'index_01R', b02: 'index_02R', b03: 'index_03R' },
    middle: { base: 'middle_baseR', b01: 'middle_01R', b02: 'middle_02R', b03: 'middle_03R' },
    ring: { base: 'ring_baseR', b01: 'ring_01R', b02: 'ring_02R', b03: 'ring_03R' },
    pinky: { base: 'pinky_baseR', b01: 'pinky_01R', b02: 'pinky_02R', b03: 'pinky_03R' },
};

const FINGER_LM = {
    thumb: [0, 1, 2, 3, 4],
    index: [0, 5, 6, 7, 8],
    middle: [0, 9, 10, 11, 12],
    ring: [0, 13, 14, 15, 16],
    pinky: [0, 17, 18, 19, 20],
};

const FINGER_NAMES = Object.keys(FINGER_LM);
const BONE_KEYS = ['b01', 'b02', 'b03'];
const TRANSITION_DURATION = 0.35;

/* ==================== PRE-ALLOCATED MATH OBJECTS ==================== */

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _v3d = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _quatTarget = new THREE.Quaternion();
const _mat4 = new THREE.Matrix4();

const _pts = Array.from({ length: 21 }, () => new THREE.Vector3());

const _curlAxisThumb = new THREE.Vector3(0.8, 0, 0.6).normalize();
const _curlAxisFinger = new THREE.Vector3(1, 0, 0);
const _splayAxis = new THREE.Vector3(0, 0, 1);

/* ==================== HELPER FUNCTIONS ==================== */

function collectBones(handModel) {
    const bones = {};
    handModel.traverse(node => {
        if (!node.name) return;
        const cleanName = node.name.replace(/_0?\d{1,3}$/, '');
        for (const [finger, boneNames] of Object.entries(BONE_MAP)) {
            for (const [key, targetName] of Object.entries(boneNames)) {
                if (cleanName === targetName || node.name.startsWith(targetName + '_')) {
                    bones[`${finger}_${key}`] = node;
                }
            }
        }
        if (cleanName === 'pulseR' || node.name.startsWith('pulseR_')) bones['wrist'] = node;
        if (cleanName === 'handR' || (node.name.startsWith('handR_') && !node.name.includes('001'))) {
            bones['hand'] = node;
        }
    });
    return bones;
}

function saveRestPose(bones) {
    const quats = {};
    for (const [key, bone] of Object.entries(bones)) {
        quats[key] = bone.quaternion.clone();
    }
    return quats;
}

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

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function landmarksToPoints(landmarks) {
    for (let i = 0; i < 21; i++) {
        const lm = landmarks[i];
        _pts[i].set(lm.x - 0.5, -(lm.y - 0.5), -(lm.z || 0) * 0.5);
    }
    return _pts;
}

function applyHandLandmarks(bones, restQuats, landmarks) {
    if (!landmarks || landmarks.length < 21) return;

    const pts = landmarksToPoints(landmarks);

    const wristBone = bones['wrist'] || bones['hand'];
    if (wristBone) {
        _v3a.subVectors(pts[9], pts[0]).normalize();
        _v3b.subVectors(pts[17], pts[5]).normalize();
        _v3c.crossVectors(_v3a, _v3b).normalize();
        _v3d.crossVectors(_v3a, _v3c).normalize();

        _mat4.makeBasis(_v3d, _v3a, _v3c);
        _quatTarget.setFromRotationMatrix(_mat4);
        wristBone.quaternion.slerp(_quatTarget, 0.15);
    }

    for (let fi = 0; fi < FINGER_NAMES.length; fi++) {
        const fingerName = FINGER_NAMES[fi];
        const lmIndices = FINGER_LM[fingerName];

        for (let j = 0; j < 3; j++) {
            const boneKey = `${fingerName}_${BONE_KEYS[j]}`;
            const bone = bones[boneKey];
            if (!bone) continue;

            const restQ = restQuats[boneKey];
            if (!restQ) continue;

            _v3a.subVectors(pts[lmIndices[j]], pts[lmIndices[j + 1]]).normalize();
            _v3b.subVectors(pts[lmIndices[j + 2]], pts[lmIndices[j + 1]]).normalize();

            const straightAngle = _v3a.angleTo(_v3b);
            const bendAmount = Math.PI - straightAngle;
            const curlAxis = fingerName === 'thumb' ? _curlAxisThumb : _curlAxisFinger;
            const scaledBend = Math.min(Math.max(bendAmount * 1.2, 0), 2.2);

            _quat.setFromAxisAngle(curlAxis, scaledBend);
            _quatTarget.copy(restQ).multiply(_quat);
            bone.quaternion.slerp(_quatTarget, 0.5);
        }

        if (fingerName === 'thumb') continue;
        const baseBone = bones[`${fingerName}_base`];
        if (!baseBone) continue;
        const restBaseQ = restQuats[`${fingerName}_base`];
        if (!restBaseQ) continue;

        _v3a.subVectors(pts[9], pts[0]).normalize();
        _v3b.subVectors(pts[lmIndices[1]], pts[0]).normalize();
        _v3c.crossVectors(_v3a, _v3b);
        const splayAngle = _v3a.angleTo(_v3b) * Math.sign(_v3c.z) * 0.4;
        const clampedSplay = Math.min(Math.max(splayAngle, -0.3), 0.3);

        _quat.setFromAxisAngle(_splayAxis, clampedSplay);
        _quatTarget.copy(restBaseQ).multiply(_quat);
        baseBone.quaternion.slerp(_quatTarget, 0.3);
    }
}

function resetPose(sd) {
    if (!sd) return;
    if (sd.vrmRetargeter) {
        sd.vrmRetargeter.reset();
        return;
    }
    const restore = (bones, quats) => {
        if (!bones || !quats) return;
        for (const [key, quat] of Object.entries(quats)) {
            if (bones[key]) bones[key].quaternion.copy(quat);
        }
    };
    restore(sd.leftBones, sd.leftRestQuats);
    restore(sd.rightBones, sd.rightRestQuats);
    if (sd.leftHand) sd.leftHand.rotation.set(0, Math.PI, 0);
    if (sd.rightHand) sd.rightHand.rotation.set(0, 0, 0);
}

// `disposeTextures` must stay off when only part of a model is being thrown
// away: GLTFLoader hands the same texture instance to every material that
// references it, so freeing one accessory's maps can blank a surface we keep.
function disposeObject(obj, { disposeTextures = true } = {}) {
    if (!obj) return;
    obj.traverse(node => {
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

// The backpack and its fittings are baked into the same `wear` mesh as the
// clothes and body, so they cannot be matched by node name — only the glTF
// material of each primitive tells them apart. Verified against avatar.vrm by
// skin weights (these sit on the `bagpack` bone) and by surface proximity:
// `anim_logo` is printed on a shoulder strap and `robo_face`/`glass` are the
// pack's display panel, so all three go with it rather than being left floating.
// `wear_metal` and `armgear_plastic` belong to the clothing and the forearm
// gauntlet, so they stay.
const ACCESSORY_MATERIALS = new Set([
    'backpack_metal',
    'backpack_nm',
    'backpack_plastic',
    'green_emit',
    'robo_face',
    'glass',
    'anim_logo',
    // Only used by the detached mechanical arm, which node names alone may miss
    // once the loader splits the mesh into per-primitive children.
    'arm_mat',
    'arm_plastic',
]);

function isAccessoryMaterial(material) {
    if (!material) return false;
    const materials = Array.isArray(material) ? material : [material];
    return materials.some(mat => ACCESSORY_MATERIALS.has((mat?.name || '').toLowerCase()));
}

function removeNonHumanAccessories(root) {
    const accessoryName = /(^|[_.-])(robo|robot|mecha|bagpack|backpack)([_.-]|$)/i;
    const accessories = [];

    root.traverse(node => {
        if (!node.isMesh && !node.isSkinnedMesh) return;
        if (accessoryName.test(node.name || '') || isAccessoryMaterial(node.material)) {
            accessories.push(node);
        }
    });

    // Reported with materials because the loader gives every primitive of a
    // multi-material mesh the same name, which alone says nothing about what went.
    const removed = accessories.map(accessory => {
        const materials = Array.isArray(accessory.material) ? accessory.material : [accessory.material];
        const names = materials.map(mat => mat?.name || '?').join('+');
        return `${accessory.name || 'unnamed'}[${names}]`;
    });

    for (const accessory of accessories) {
        accessory.removeFromParent();
        disposeObject(accessory, { disposeTextures: false });
    }

    return removed;
}

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

const AvatarScene3D = forwardRef(function AvatarScene3D(
    { className, style, onStatusChange, onPlayingSign, playbackSpeed = 1 },
    ref,
) {
    const containerRef = useRef(null);
    const sceneDataRef = useRef(null);
    const rendererRef = useRef(null);
    const animFrameRef = useRef(null);
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
        // Signs still in flight. Playback starts on the first one to arrive and
        // waits here rather than ending when the queue momentarily drains.
        pendingCount: 0,
        awaitingData: false,
        // Bumped per playSignSequence call so a stale in-flight fetch from a
        // previous sentence cannot push frames into the current one.
        runId: 0,
    });

    // Landmark data keyed by gloss. A replay, or a word repeated in a sentence,
    // then costs nothing at all.
    const landmarkCacheRef = useRef(new Map());
    const playNextRef = useRef(null);
    const playbackSpeedRef = useRef(playbackSpeed);
    useEffect(() => {
        playbackSpeedRef.current = playbackSpeed;
    }, [playbackSpeed]);

    const [status, setStatus] = useState('Đang tải mô hình...');
    const [isModelLoaded, setIsModelLoaded] = useState(false);
    const [loadError, setLoadError] = useState(null);

    const updateStatus = useCallback((text) => {
        setStatus(text);
        onStatusChange?.(text);
    }, [onStatusChange]);

    /* ---------- Three.js init (runs once) ---------- */
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        let disposed = false;

        // Scene
        const scene = new THREE.Scene();
        // Use THREE.Clock — universally supported and reliable
        const clock = new THREE.Clock();

        // Renderer — with proper context loss handling
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
            setLoadError('WebGL không khởi tạo được. Dùng Chrome/Edge.');
            return;
        }

        // Handle WebGL context loss gracefully
        const onContextLost = (e) => {
            e.preventDefault();
            console.warn('[AvatarScene3D] WebGL context lost — pausing render loop');
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        };
        const onContextRestored = () => {
            console.info('[AvatarScene3D] WebGL context restored — resuming');
            if (!disposed) animate();
        };
        renderer.domElement.addEventListener('webglcontextlost', onContextLost);
        renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

        // Camera
        const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1);
        const camera = new THREE.PerspectiveCamera(38, aspect, 0.05, 50);
        camera.position.set(0, 0.9, 2.6);
        camera.lookAt(0, 0.76, 0);

        // Lights
        scene.add(new THREE.AmbientLight(0xffffff, 0.55));

        const hemi = new THREE.HemisphereLight(0xe8f4ff, 0x8eaacc, 0.75);
        hemi.position.set(0, 2, 0);
        scene.add(hemi);

        const key = new THREE.DirectionalLight(0xffffff, 1.6);
        key.position.set(2.5, 3, 2.5);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        key.shadow.camera.near = 0.3;
        key.shadow.camera.far = 10;
        key.shadow.camera.left = -1.5;
        key.shadow.camera.right = 1.5;
        key.shadow.camera.top = 1.5;
        key.shadow.camera.bottom = -1.5;
        key.shadow.bias = -0.0002;
        scene.add(key);

        const fill = new THREE.DirectionalLight(0xb7d7ff, 0.9);
        fill.position.set(-2.5, 2, 1.5);
        scene.add(fill);

        const rim = new THREE.DirectionalLight(0x88ddff, 0.7);
        rim.position.set(0, 1.5, -3);
        scene.add(rim);

        // Environment
        const pmrem = new THREE.PMREMGenerator(renderer);
        const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        scene.environment = envTexture;
        pmrem.dispose();

        // Controls
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.set(0, 0.76, 0);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 0.5;
        controls.maxDistance = 3.5;
        controls.maxPolarAngle = Math.PI * 0.65;
        controls.minPolarAngle = Math.PI * 0.15;
        controls.update();

        // Background & floor
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

        // Keep the hat and feet inside the visible area above the status bar,
        // including the shorter viewport in the video overlay layout.
        function resizeScene() {
            const w = Math.max(container.clientWidth, 1);
            const h = Math.max(container.clientHeight, 1);
            const bottomInset = sceneDataRef.current?.vrm ? Math.min(56, h * 0.25) : 0;
            const viewportHeight = h - bottomInset;
            camera.aspect = w / viewportHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
            renderer.setViewport(0, bottomInset, w, viewportHeight);
        }

        async function loadFallbackHands() {
            // Preserve the original close-up framing of the fallback hands.
            camera.position.set(0, 0.50, 1.4);
            controls.target.set(0, 0.35, 0);
            controls.maxDistance = 4;
            controls.update();
            const loader = new GLTFLoader();
            const gltf = await loader.loadAsync('/models/rigged_hand.glb');
            if (disposed) return;

            const original = gltf.scene;
            const box = new THREE.Box3().setFromObject(original);
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const scaleFactor = 0.45 / maxDim;

            // Shared material — premium metallic
            const mainMat = new THREE.MeshPhysicalMaterial({
                color: 0xd8e2ec,
                metalness: 0.75,
                roughness: 0.20,
                clearcoat: 0.8,
                clearcoatRoughness: 0.1,
                envMapIntensity: 1.5,
            });

            function applyMaterial(model) {
                model.traverse(node => {
                    if (!node.isMesh) return;
                    node.material = mainMat;
                    node.castShadow = true;
                    node.receiveShadow = true;
                    node.frustumCulled = false;
                });
            }

            // Clone for left hand
            const leftHand = SkeletonUtils.clone(original);
            leftHand.name = 'left_hand';
            leftHand.scale.setScalar(scaleFactor);
            leftHand.position.set(-0.22, 0.30, 0.05);
            leftHand.rotation.set(0, Math.PI, 0);
            applyMaterial(leftHand);
            scene.add(leftHand);

            // Clone for right hand
            const rightHand = SkeletonUtils.clone(original);
            rightHand.name = 'right_hand';
            rightHand.scale.setScalar(scaleFactor);
            rightHand.position.set(0.22, 0.30, 0.05);
            rightHand.rotation.set(0, 0, 0);
            applyMaterial(rightHand);
            scene.add(rightHand);

            // Force update world matrices so meshes render immediately
            leftHand.updateMatrixWorld(true);
            rightHand.updateMatrixWorld(true);

            let meshCount = 0;
            leftHand.traverse(n => { if (n.isMesh) meshCount++; });
            rightHand.traverse(n => { if (n.isMesh) meshCount++; });
            console.info(`[AvatarScene3D] Hands loaded: ${meshCount} meshes, scale=${scaleFactor.toFixed(4)}`);

            const leftBones = collectBones(leftHand);
            const rightBones = collectBones(rightHand);
            console.info(`[AvatarScene3D] Bones: L=${Object.keys(leftBones).length}, R=${Object.keys(rightBones).length}`);

            // Debug: log bone names for verification
            if (Object.keys(leftBones).length === 0) {
                console.warn('[AvatarScene3D] No bones found! Dumping model node names:');
                leftHand.traverse(n => { if (n.isBone) console.log(`  Bone: "${n.name}"`); });
            }

            sceneDataRef.current = {
                leftHand, rightHand,
                leftBones, rightBones,
                leftRestQuats: saveRestPose(leftBones),
                rightRestQuats: saveRestPose(rightBones),
                mainMat,
            };

            setIsModelLoaded(true);
            updateStatus('Mô hình tay sẵn sàng — thêm avatar.vrm để bật toàn thân');
        }

        async function loadVrmAvatar() {
            const response = await fetch('/models/avatar.vrm', { method: 'HEAD' });
            const contentType = response.headers.get('content-type') || '';
            if (!response.ok || contentType.includes('text/html')) return false;

            const loader = new GLTFLoader();
            loader.register(parser => new VRMLoaderPlugin(parser));
            const gltf = await loader.loadAsync('/models/avatar.vrm');
            if (disposed) return true;

            const vrm = gltf.userData.vrm;
            if (!vrm) throw new Error('avatar.vrm does not contain VRM metadata');

            VRMUtils.removeUnnecessaryVertices(gltf.scene);
            VRMUtils.combineSkeletons(gltf.scene);
            VRMUtils.rotateVRM0(vrm);

            // Seed-san carries a backpack with a mechanical arm mounted on it.
            // None of it belongs to the humanoid rig used for signing and it
            // clutters the silhouette, so strip it before framing the avatar.
            // Keep the logo's original skinned geometry to fill the shirt's
            // cutouts. The accessory remover still handles every other part.
            const shirtPatches = [];
            vrm.scene.traverse(node => {
                if (node.isMesh && isAccessoryMaterial(node.material)) {
                    const mats = Array.isArray(node.material) ? node.material : [node.material];
                    if (mats.every(mat => /^anim_logo(?:\s*\(outline\))?$/i.test(mat.name || ''))) {
                        shirtPatches.push({ node, parent: node.parent });
                    }
                }
            });
            for (const { node } of shirtPatches) node.removeFromParent();
            const removedAccessories = removeNonHumanAccessories(vrm.scene);
            for (const { node, parent } of shirtPatches) parent.add(node);
            if (removedAccessories.length > 0) {
                console.info(
                    `[AvatarScene3D] Removed non-human accessories: ${removedAccessories.join(', ')}`,
                );
            }

            const box = new THREE.Box3().setFromObject(vrm.scene);
            const size = box.getSize(new THREE.Vector3());
            vrm.scene.scale.setScalar(1.35 / Math.max(size.y, 0.01));
            vrm.scene.position.set(0, 0, 0);
            applyVietnameseAoDaiAndNonLa(vrm);
            vrm.scene.traverse(node => {
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
            resizeScene();
            setIsModelLoaded(true);
            updateStatus('Avatar VRM toàn thân sẵn sàng');
            return true;
        }

        loadVrmAvatar()
            .then(loaded => loaded || loadFallbackHands())
            .catch(err => {
                console.warn('[AvatarScene3D] VRM unavailable, using hand fallback:', err);
                loadFallbackHands().catch(fallbackError => {
                    console.error('[AvatarScene3D] Model load failed:', fallbackError);
                    setLoadError('Không tải được mô hình 3D.');
                });
            });

        /* ---------- Animation loop ---------- */
        function playNextInQueue() {
            const anim = animDataRef.current;
            const sd = sceneDataRef.current;

            if (sd && anim.queue.length === 0 && anim.pendingCount > 0) {
                // The rest of the sentence is still downloading. Hold the pose
                // instead of ending, and resume the moment it lands.
                anim.awaitingData = true;
                anim.currentFrames = null;
                anim.currentFrameIdx = 0;
                anim.frameTimer = 0;
                updateStatus('Đang tải ký hiệu tiếp theo...');
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
                updateStatus('Mô hình tay sẵn sàng');
                return;
            }

            anim.awaitingData = false;
            anim.isPlaying = true;
            const current = anim.queue.shift();
            anim.currentSign = current;
            anim.currentFrames = current.data.frames;
            anim.currentFps = (current.data.fps || 25) * playbackSpeedRef.current;
            anim.currentFrameIdx = 0;
            anim.frameTimer = 0;
            anim.isTransitioning = true;
            anim.transitionProgress = 0;

            const label = `Đang ký: ${current.vi}`;
            updateStatus(label);
            onPlayingSign?.(current);
        }

        playNextRef.current = playNextInQueue;

        function updateAnimation(delta) {
            const anim = animDataRef.current;
            const sd = sceneDataRef.current;
            if (!sd) return;
            if (anim.timing) {
                const { timeline, getElapsed, duration } = anim.timing;
                const sample = sampleCue(timeline, getElapsed(), duration);
                if (!sample) {
                    if (anim.currentSign) resetPose(sd);
                    anim.currentSign = null;
                    return;
                }
                if (anim.currentSign !== sample.sign) {
                    anim.currentSign = sample.sign;
                    updateStatus(`Đang ký: ${sample.sign.vi}`);
                    onPlayingSign?.(sample.sign);
                }
                renderPose(sd, sample.sign.data.frames, sample.index, sample.fraction, delta);
                return;
            }
            if (!anim.isPlaying || !anim.currentFrames) return;

            if (anim.isTransitioning) {
                anim.transitionProgress += delta / TRANSITION_DURATION;
                if (anim.transitionProgress >= 1) {
                    anim.isTransitioning = false;
                    anim.transitionProgress = 1;
                }
                if (anim.currentFrames.length > 0) {
                    const firstFrame = anim.currentFrames[0];
                    const t = easeInOutCubic(Math.min(anim.transitionProgress, 1));
                    if (sd.vrmRetargeter) {
                        sd.vrmRetargeter.apply(firstFrame, delta);
                    } else if (firstFrame.left_hand) {
                        const from = anim.prevLeftLandmarks || firstFrame.left_hand;
                        applyHandLandmarks(sd.leftBones, sd.leftRestQuats, lerpLandmarks(from, firstFrame.left_hand, t));
                    }
                    if (!sd.vrmRetargeter && firstFrame.right_hand) {
                        const from = anim.prevRightLandmarks || firstFrame.right_hand;
                        applyHandLandmarks(sd.rightBones, sd.rightRestQuats, lerpLandmarks(from, firstFrame.right_hand, t));
                    }
                }
                return;
            }

            anim.frameTimer += delta;
            const frameDuration = 1 / anim.currentFps;

            if (anim.frameTimer >= frameDuration) {
                const steps = Math.floor(anim.frameTimer / frameDuration);
                anim.frameTimer -= steps * frameDuration;
                anim.currentFrameIdx += steps;

                if (anim.currentFrameIdx >= anim.currentFrames.length) {
                    const lastFrame = anim.currentFrames[anim.currentFrames.length - 1];
                    anim.prevLeftLandmarks = lastFrame?.left_hand || null;
                    anim.prevRightLandmarks = lastFrame?.right_hand || null;
                    playNextInQueue();
                    return;
                }
            }

            renderPose(sd, anim.currentFrames, anim.currentFrameIdx, anim.frameTimer / frameDuration, delta);
        }

        function renderPose(sd, frames, index, t, delta) {
            const frame = frames[index];
            const nextFrame = frames[index + 1] || frame;
            if (sd.vrmRetargeter) {
                sd.vrmRetargeter.apply({
                    ...frame,
                    pose: lerpLandmarks(frame.pose, nextFrame?.pose || frame.pose, t),
                    pose_world: lerpLandmarks(
                        frame.pose_world,
                        nextFrame?.pose_world || frame.pose_world,
                        t,
                    ),
                    left_hand: lerpLandmarks(
                        frame.left_hand,
                        nextFrame?.left_hand || frame.left_hand,
                        t,
                    ),
                    right_hand: lerpLandmarks(
                        frame.right_hand,
                        nextFrame?.right_hand || frame.right_hand,
                        t,
                    ),
                }, delta);
            } else if (frame.left_hand) {
                applyHandLandmarks(sd.leftBones, sd.leftRestQuats,
                    lerpLandmarks(frame.left_hand, nextFrame?.left_hand || frame.left_hand, t));
            }
            if (!sd.vrmRetargeter && frame.right_hand) {
                applyHandLandmarks(sd.rightBones, sd.rightRestQuats,
                    lerpLandmarks(frame.right_hand, nextFrame?.right_hand || frame.right_hand, t));
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

        // Resize handler — debounced
        let lastW = 0, lastH = 0;
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
                resizeScene();
            });
        });
        resizeObserver.observe(container);

        /* ---------- Cleanup ---------- */
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
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    /* ---------- Landmark loading ---------- */
    const loadLandmarks = useCallback(async (sign) => {
        const cache = landmarkCacheRef.current;
        const cached = cache.get(sign.gloss);
        if (cached) {
            // Either the data itself, or the in-flight promise for it — sharing
            // the promise means a word repeated in one sentence is fetched once.
            const data = await cached;
            return data ? { gloss: sign.gloss, vi: sign.vi, data } : null;
        }

        const request = (async () => {
            const resp = await fetch(`/api/landmarks/${encodeURIComponent(sign.gloss)}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const result = await resp.json();
            if (!result.data?.frames?.length) throw new Error('empty landmark data');
            return result.data;
        })();

        cache.set(sign.gloss, request);
        try {
            const data = await request;
            cache.set(sign.gloss, data);
            return { gloss: sign.gloss, vi: sign.vi, data };
        } catch (err) {
            cache.delete(sign.gloss);
            throw err;
        }
    }, []);

    /* ---------- Imperative API ---------- */
    useImperativeHandle(ref, () => ({
        preloadSigns(signs) {
            return Promise.allSettled(signs.filter(s => s.found && s.gloss).map(loadLandmarks));
        },

        async playSignSequence(signs, timing) {
            const sd = sceneDataRef.current;
            if (!sd) return;

            const foundSigns = signs.filter(s => s.found && s.gloss);
            const anim = animDataRef.current;
            const runId = ++anim.runId;
            anim.queue = [];
            anim.timing = null;
            anim.currentFrames = null;
            anim.currentSign = null;
            anim.isPlaying = false;
            if (!foundSigns.length) {
                resetPose(sd);
                updateStatus('Không tìm thấy ký hiệu nào có dữ liệu 3D');
                return;
            }
            if (timing) {
                const results = await Promise.allSettled(foundSigns.map(loadLandmarks));
                if (anim.runId !== runId) return;
                const loaded = results.flatMap(r => r.status === 'fulfilled' && r.value ? [r.value] : []);
                anim.timing = { ...timing, timeline: buildCueTimeline(loaded) };
                if (!loaded.length) {
                    resetPose(sd);
                    updateStatus('Không có dữ liệu landmark cho các từ này');
                }
                return;
            }
            anim.pendingCount = foundSigns.length;
            anim.awaitingData = false;

            updateStatus('Đang tải dữ liệu landmark...');

            // All requests go out at once. The old loop awaited each one before
            // starting the next, so a five-word sentence paid five round trips
            // end to end before the avatar moved at all.
            const requests = foundSigns.map(sign => loadLandmarks(sign));

            // Playback starts on the first sign and the rest stream in behind
            // it, so what the user waits for is one sign, not the whole sentence.
            for (const request of requests) {
                let loaded = null;
                try {
                    loaded = await request;
                } catch (err) {
                    console.warn('[Avatar] landmark load failed:', err);
                }

                // A newer sentence started while this was in flight.
                if (anim.runId !== runId) return;

                anim.pendingCount -= 1;
                if (!loaded) continue;

                anim.queue.push(loaded);
                if (!anim.isPlaying || anim.awaitingData) {
                    playNextRef.current?.();
                }
            }

            if (anim.runId !== runId) return;

            // Nothing left in flight. If playback is parked waiting for data
            // that never arrived, let it end instead of holding the pose.
            if (anim.awaitingData && anim.queue.length === 0) {
                playNextRef.current?.();
                return;
            }

            if (!anim.isPlaying && anim.queue.length === 0) {
                updateStatus('Không có dữ liệu landmark cho các từ này');
            }
        },

        stopAnimation() {
            const anim = animDataRef.current;
            // Bumping the run id makes any in-flight fetch drop its result.
            anim.runId += 1;
            anim.timing = null;
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
            updateStatus('Mô hình tay sẵn sàng');
        },

        get isModelLoaded() { return isModelLoaded; },
    }), [isModelLoaded, updateStatus, loadLandmarks]);

    /* ---------- Render ---------- */
    if (loadError) {
        return (
            <div className={className} style={{
                ...style,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: '#EFECE0', borderRadius: 'var(--radius-md)',
            }}>
                <p style={{ color: '#5F2A1A', fontSize: '14px', textAlign: 'center', padding: '16px' }}>
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
                width: '100%', height: '100%',
                borderRadius: 'var(--radius-md)', overflow: 'hidden',
                position: 'relative', ...style,
            }}
        >
            {/* Loading overlay */}
            {!isModelLoaded && (
                <div style={{
                    position: 'absolute', inset: 0,
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(255, 252, 237, 0.94)', zIndex: 2,
                    borderRadius: 'var(--radius-md)',
                }}>
                    <div className="avatar-loader" />
                    <p style={{ color: '#325825', fontSize: '13px', marginTop: '12px' }}>
                        Đang tải mô hình 3D...
                    </p>
                </div>
            )}

            {/* Status bar */}
            <div style={{
                position: 'absolute', bottom: '8px', left: '8px', right: '8px',
                padding: '8px 14px',
                background: 'rgba(232, 230, 218, 0.92)',
                border: '1px solid rgba(75, 45, 21, 0.14)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                borderRadius: '10px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                zIndex: 1, pointerEvents: 'none',
            }}>
                <span style={{ color: '#4B2D15', fontSize: '12px', fontWeight: 600 }}>
                    {status}
                </span>
            </div>
        </div>
    );
});

export default AvatarScene3D;
