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
const LANDMARK_CACHE_LIMIT = 32;
const landmarkCache = new Map();

function rememberLandmark(gloss, data) {
    if (landmarkCache.has(gloss)) landmarkCache.delete(gloss);
    landmarkCache.set(gloss, data);
    while (landmarkCache.size > LANDMARK_CACHE_LIMIT) {
        landmarkCache.delete(landmarkCache.keys().next().value);
    }
}

async function loadLandmark(sign, signal) {
    const gloss = sign.gloss.toLowerCase();
    const cached = landmarkCache.get(gloss);
    if (cached) {
        rememberLandmark(gloss, cached);
        return { gloss: sign.gloss, vi: sign.vi, data: cached, source: 'memory' };
    }

    const response = await fetch(`/api/landmarks/${encodeURIComponent(sign.gloss)}`, {
        signal,
        cache: 'force-cache',
    });
    if (!response.ok) return null;

    const result = await response.json();
    if (!result.data?.frames?.length) return null;
    rememberLandmark(gloss, result.data);
    return { gloss: sign.gloss, vi: sign.vi, data: result.data, source: 'network' };
}

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

function createLandmarkPreview(scene) {
    const group = new THREE.Group();
    group.name = 'landmark-preview';
    group.visible = false;

    const createTrack = (count, color, size) => {
        const positions = new Float32Array(count * 3);
        positions.fill(-100);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const material = new THREE.PointsMaterial({
            color,
            size,
            sizeAttenuation: true,
        });
        const points = new THREE.Points(geometry, material);
        group.add(points);
        return { count, positions, geometry };
    };

    const preview = {
        group,
        pose: createTrack(33, 0x55ddff, 0.028),
        leftHand: createTrack(21, 0xffd166, 0.034),
        rightHand: createTrack(21, 0x72f1b8, 0.034),
    };
    scene.add(group);
    return preview;
}

function updatePreviewTrack(track, landmarks) {
    for (let index = 0; index < track.count; index += 1) {
        const point = landmarks?.[index];
        const offset = index * 3;
        if (!point) {
            track.positions[offset] = -100;
            track.positions[offset + 1] = -100;
            track.positions[offset + 2] = -100;
            continue;
        }
        track.positions[offset] = (Number(point.x) - 0.5) * 1.25;
        track.positions[offset + 1] = (0.5 - Number(point.y)) * 1.25 + 0.38;
        track.positions[offset + 2] = -(Number(point.z) || 0) * 0.55;
    }
    track.geometry.attributes.position.needsUpdate = true;
}

function applyLandmarkPreview(preview, frame) {
    if (!preview || !frame) return;
    preview.group.visible = true;
    updatePreviewTrack(preview.pose, frame.pose);
    updatePreviewTrack(preview.leftHand, frame.left_hand);
    updatePreviewTrack(preview.rightHand, frame.right_hand);
}

function removeLandmarkPreview(sceneData) {
    const preview = sceneData?.landmarkPreview;
    if (!preview) return;
    preview.group.parent?.remove(preview.group);
    disposeObject(preview.group);
}

function resetPose(sd) {
    if (!sd) return;
    if (sd.landmarkPreview) {
        sd.landmarkPreview.group.visible = false;
        return;
    }
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

/* ==================== COMPONENT ==================== */

const AvatarScene3D = forwardRef(function AvatarScene3D(
    { className, style, active = true, onStatusChange, onPlayingSign, onFirstFrame },
    ref,
) {
    const containerRef = useRef(null);
    const sceneDataRef = useRef(null);
    const rendererRef = useRef(null);
    const animFrameRef = useRef(null);
    const playNextRef = useRef(null);
    const activeRef = useRef(active);
    const onFirstFrameRef = useRef(onFirstFrame);
    activeRef.current = active;
    onFirstFrameRef.current = onFirstFrame;
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
        loadGeneration: 0,
        pendingLoads: 0,
        abortController: null,
        firstFramePending: false,
    });

    const [status, setStatus] = useState('Đang tải mô hình...');
    const [isModelLoaded, setIsModelLoaded] = useState(false);
    const [loadError, setLoadError] = useState(null);
    const [currentGloss, setCurrentGloss] = useState(null);

    const updateStatus = useCallback((text) => {
        setStatus(text);
        onStatusChange?.(text);
    }, [onStatusChange]);

    /* ---------- Three.js init (runs once) ---------- */
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const animationState = animDataRef.current;

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
        camera.position.set(0, 0.50, 1.4);
        camera.lookAt(0, 0.35, 0);

        // Lights
        scene.add(new THREE.AmbientLight(0xffffff, 0.5));

        const hemi = new THREE.HemisphereLight(0xe8f4ff, 0x8eaacc, 0.7);
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

        const bottom = new THREE.PointLight(0x44ccff, 0.4, 3);
        bottom.position.set(0, -0.2, 0.5);
        scene.add(bottom);

        // Environment
        const pmrem = new THREE.PMREMGenerator(renderer);
        const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        scene.environment = envTexture;
        pmrem.dispose();

        // Controls
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.set(0, 0.35, 0);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 0.5;
        controls.maxDistance = 4;
        controls.maxPolarAngle = Math.PI * 0.65;
        controls.minPolarAngle = Math.PI * 0.15;
        controls.update();

        // Background & floor
        scene.background = new THREE.Color(0x1a2030);

        const floorGeo = new THREE.CircleGeometry(2, 48);
        const floorMat = new THREE.MeshStandardMaterial({ color: 0x2a3648, roughness: 0.3, metalness: 0.6 });
        const floor = new THREE.Mesh(floorGeo, floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.receiveShadow = true;
        scene.add(floor);

        const ringGeo = new THREE.TorusGeometry(0.7, 0.008, 8, 48);
        const ringMat = new THREE.MeshStandardMaterial({
            color: 0x55ddff, emissive: 0x33aacc,
            emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.2,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.005;
        scene.add(ring);

        const grid = new THREE.GridHelper(3, 20, 0x334466, 0x253344);
        grid.position.y = 0.001;
        grid.material.transparent = true;
        grid.material.opacity = 0.3;
        scene.add(grid);

        // A zero-download landmark avatar removes the full VRM from the
        // critical path. It responds immediately and is replaced once the
        // detailed model has finished loading and parsing.
        const landmarkPreview = createLandmarkPreview(scene);
        sceneDataRef.current = { landmarkPreview };
        setIsModelLoaded(true);
        updateStatus('Avatar nhẹ sẵn sàng — đang tải VRM...');

        async function loadFallbackHands() {
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

            removeLandmarkPreview(sceneDataRef.current);
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
            const removedAccessories = removeNonHumanAccessories(vrm.scene);
            if (removedAccessories.length > 0) {
                console.info(
                    `[AvatarScene3D] Removed non-human accessories: ${removedAccessories.join(', ')}`,
                );
            }

            const box = new THREE.Box3().setFromObject(vrm.scene);
            const size = box.getSize(new THREE.Vector3());
            vrm.scene.scale.setScalar(1.35 / Math.max(size.y, 0.01));
            vrm.scene.position.set(0, 0, 0);
            vrm.scene.traverse(node => {
                if (!node.isMesh) return;
                node.castShadow = true;
                node.receiveShadow = true;
                node.frustumCulled = false;
            });
            scene.add(vrm.scene);
            vrm.scene.updateMatrixWorld(true);

            removeLandmarkPreview(sceneDataRef.current);
            sceneDataRef.current = {
                vrm,
                vrmRetargeter: new VrmHolisticRetargeter(vrm),
            };
            setIsModelLoaded(true);
            updateStatus('Avatar VRM toàn thân sẵn sàng');
            return true;
        }

        // Give translation and the first landmark priority on a cold network.
        // The lightweight preview already makes the avatar interactive.
        const detailedModelTimer = window.setTimeout(() => {
            loadVrmAvatar()
                .then(loaded => loaded || loadFallbackHands())
                .catch(err => {
                    console.warn('[AvatarScene3D] VRM unavailable, using hand fallback:', err);
                    loadFallbackHands().catch(fallbackError => {
                        console.error('[AvatarScene3D] Model load failed:', fallbackError);
                        updateStatus('Avatar nhẹ sẵn sàng — không tải được VRM');
                    });
                });
        }, 1500);

        /* ---------- Animation loop ---------- */
        function playNextInQueue() {
            const anim = animDataRef.current;
            const sd = sceneDataRef.current;

            if (!sd || anim.queue.length === 0) {
                if (sd && anim.pendingLoads > 0) {
                    anim.isPlaying = false;
                    updateStatus('Loading next sign...');
                    return;
                }
                anim.isPlaying = false;
                anim.currentFrames = null;
                anim.currentSign = null;
                anim.currentFrameIdx = 0;
                anim.frameTimer = 0;
                resetPose(sd);
                setCurrentGloss(null);
                updateStatus(sd?.vrm
                    ? 'Avatar VRM toàn thân sẵn sàng'
                    : sd?.landmarkPreview
                        ? 'Avatar nhẹ sẵn sàng — đang tải VRM...'
                        : 'Mô hình tay sẵn sàng');
                return;
            }

            anim.isPlaying = true;
            const current = anim.queue.shift();
            anim.currentSign = current;
            anim.currentFrames = current.data.frames;
            anim.currentFps = current.data.fps || 25;
            anim.currentFrameIdx = 0;
            anim.frameTimer = 0;
            anim.isTransitioning = true;
            anim.transitionProgress = 0;
            anim.firstFramePending = Boolean(current.isSequenceFirst);

            const label = `Đang ký: ${current.vi} (${current.gloss.toUpperCase()})`;
            updateStatus(label);
            setCurrentGloss(current.gloss);
            onPlayingSign?.(current);
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
                if (anim.currentFrames.length > 0) {
                    const firstFrame = anim.currentFrames[0];
                    const t = easeInOutCubic(Math.min(anim.transitionProgress, 1));
                    if (sd.landmarkPreview) {
                        applyLandmarkPreview(sd.landmarkPreview, firstFrame);
                    } else if (sd.vrmRetargeter) {
                        sd.vrmRetargeter.apply(firstFrame, delta);
                    } else if (firstFrame.left_hand) {
                        const from = anim.prevLeftLandmarks || firstFrame.left_hand;
                        applyHandLandmarks(sd.leftBones, sd.leftRestQuats, lerpLandmarks(from, firstFrame.left_hand, t));
                    }
                    if (!sd.vrmRetargeter && !sd.landmarkPreview && firstFrame.right_hand) {
                        const from = anim.prevRightLandmarks || firstFrame.right_hand;
                        applyHandLandmarks(sd.rightBones, sd.rightRestQuats, lerpLandmarks(from, firstFrame.right_hand, t));
                    }
                }
                return;
            }

            anim.frameTimer += delta;
            const frameDuration = 1 / anim.currentFps;

            if (anim.frameTimer >= frameDuration) {
                anim.frameTimer -= frameDuration;
                anim.currentFrameIdx++;

                if (anim.currentFrameIdx >= anim.currentFrames.length) {
                    const lastFrame = anim.currentFrames[anim.currentFrames.length - 1];
                    anim.prevLeftLandmarks = lastFrame?.left_hand || null;
                    anim.prevRightLandmarks = lastFrame?.right_hand || null;
                    playNextInQueue();
                    return;
                }
            }

            const frame = anim.currentFrames[anim.currentFrameIdx];
            if (!frame) return;

            const nextIdx = Math.min(anim.currentFrameIdx + 1, anim.currentFrames.length - 1);
            const nextFrame = anim.currentFrames[nextIdx];
            const t = anim.frameTimer / frameDuration;

            if (sd.landmarkPreview) {
                applyLandmarkPreview(sd.landmarkPreview, {
                    pose: lerpLandmarks(frame.pose, nextFrame?.pose || frame.pose, t),
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
                });
            } else if (sd.vrmRetargeter) {
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
            if (!sd.vrmRetargeter && !sd.landmarkPreview && frame.right_hand) {
                applyHandLandmarks(sd.rightBones, sd.rightRestQuats,
                    lerpLandmarks(frame.right_hand, nextFrame?.right_hand || frame.right_hand, t));
            }
        }

        function animate() {
            if (disposed) return;
            animFrameRef.current = requestAnimationFrame(animate);

            const delta = clock.getDelta();
            if (!activeRef.current) return;
            controls.update();
            updateAnimation(delta);
            renderer.render(scene, camera);
            const anim = animDataRef.current;
            if (anim.firstFramePending && anim.isPlaying && anim.currentSign) {
                anim.firstFramePending = false;
                onFirstFrameRef.current?.({
                    gloss: anim.currentSign.gloss,
                    timestamp: performance.now(),
                });
            }
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
                camera.aspect = w / h;
                camera.updateProjectionMatrix();
                renderer.setSize(w, h);
            });
        });
        resizeObserver.observe(container);

        /* ---------- Cleanup ---------- */
        return () => {
            disposed = true;
            resizeObserver.disconnect();
            clearTimeout(detailedModelTimer);

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
            playNextRef.current = null;
            animationState.abortController?.abort();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    /* ---------- Imperative API ---------- */
    useImperativeHandle(ref, () => ({
        async playSignSequence(signs) {
            const sd = sceneDataRef.current;
            if (!sd) return;

            const foundSigns = signs.filter(s => s.found && s.gloss);
            if (foundSigns.length === 0) {
                updateStatus('Không tìm thấy ký hiệu nào có dữ liệu 3D');
                return;
            }

            updateStatus('Đang tải dữ liệu landmark...');

            const anim = animDataRef.current;
            anim.abortController?.abort();
            const controller = new AbortController();
            anim.abortController = controller;
            const generation = ++anim.loadGeneration;
            anim.queue = [];
            anim.isPlaying = false;
            anim.currentFrames = null;
            anim.currentSign = null;
            anim.pendingLoads = foundSigns.length;

            // Start every request together, but animate as soon as the first
            // available sign arrives instead of waiting for the whole sentence.
            const requestCache = new Map();
            const pending = foundSigns.map(sign => {
                const key = sign.gloss.toLowerCase();
                if (!requestCache.has(key)) {
                    requestCache.set(
                        key,
                        loadLandmark(sign, controller.signal).catch(err => {
                            if (err.name !== 'AbortError') {
                                console.warn(`[Avatar] Failed to load "${sign.gloss}":`, err);
                            }
                            return null;
                        }),
                    );
                }
                return requestCache.get(key).then(item => (
                    item ? { ...item, vi: sign.vi, gloss: sign.gloss } : null
                ));
            });

            let firstIndex = -1;
            for (let index = 0; index < pending.length; index += 1) {
                const item = await pending[index];
                if (generation !== anim.loadGeneration || controller.signal.aborted) return;
                if (item) {
                    firstIndex = index;
                    anim.queue.push({ ...item, isSequenceFirst: true });
                    playNextRef.current?.();
                    break;
                }
            }

            const allResults = await Promise.all(pending);
            if (generation !== anim.loadGeneration || controller.signal.aborted) return;
            anim.pendingLoads = 0;

            allResults.forEach((item, index) => {
                if (item && index !== firstIndex) anim.queue.push(item);
            });

            if (!anim.isPlaying && anim.queue.length > 0) {
                playNextRef.current?.();
            } else if (firstIndex < 0) {
                updateStatus('Không có dữ liệu landmark cho các từ này');
            }
        },

        stopAnimation() {
            const anim = animDataRef.current;
            anim.isPlaying = false;
            anim.queue = [];
            anim.currentFrames = null;
            anim.currentSign = null;
            anim.currentFrameIdx = 0;
            anim.frameTimer = 0;
            anim.isTransitioning = false;
            anim.pendingLoads = 0;
            anim.abortController?.abort();
            anim.abortController = null;
            anim.loadGeneration += 1;
            anim.firstFramePending = false;
            resetPose(sceneDataRef.current);
            setCurrentGloss(null);
            updateStatus(sceneDataRef.current?.vrm
                ? 'Avatar VRM toàn thân sẵn sàng'
                : sceneDataRef.current?.landmarkPreview
                    ? 'Avatar nhẹ sẵn sàng — đang tải VRM...'
                    : 'Mô hình tay sẵn sàng');
        },

        get isModelLoaded() { return isModelLoaded; },
    }), [isModelLoaded, updateStatus]);

    /* ---------- Render ---------- */
    if (loadError) {
        return (
            <div className={className} style={{
                ...style,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: '#0a0e17', borderRadius: 'var(--radius-md)',
            }}>
                <p style={{ color: '#f87171', fontSize: '14px', textAlign: 'center', padding: '16px' }}>
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
                    background: 'rgba(26, 32, 48, 0.9)', zIndex: 2,
                    borderRadius: 'var(--radius-md)',
                }}>
                    <div className="avatar-loader" />
                    <p style={{ color: '#94a3b8', fontSize: '13px', marginTop: '12px' }}>
                        Đang tải mô hình 3D...
                    </p>
                </div>
            )}

            {/* Status bar */}
            <div style={{
                position: 'absolute', bottom: '8px', left: '8px', right: '8px',
                padding: '8px 14px',
                background: 'rgba(0, 0, 0, 0.55)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                borderRadius: '10px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                zIndex: 1, pointerEvents: 'none',
            }}>
                <span style={{ color: '#e2e8f0', fontSize: '12px', fontWeight: 600 }}>
                    {status}
                </span>
                {currentGloss && (
                    <span style={{
                        padding: '2px 8px',
                        background: 'rgba(45, 212, 191, 0.2)',
                        borderRadius: '6px',
                        color: '#2dd4bf',
                        fontSize: '11px',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                    }}>
                        {currentGloss}
                    </span>
                )}
            </div>
        </div>
    );
});

export default AvatarScene3D;
