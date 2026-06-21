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

function disposeObject(obj) {
    if (!obj) return;
    obj.traverse(node => {
        if (node.geometry) {
            node.geometry.dispose();
        }
        if (node.material) {
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            for (const mat of materials) {
                for (const key of Object.keys(mat)) {
                    const value = mat[key];
                    if (value && typeof value.dispose === 'function') {
                        value.dispose();
                    }
                }
                mat.dispose();
            }
        }
    });
}

function removeNonHumanAccessories(root) {
    const accessoryName = /(^|[_.-])(robo|robot|mecha)([_.-]|$)/i;
    const accessories = [];

    root.traverse(node => {
        if ((node.isMesh || node.isSkinnedMesh) && accessoryName.test(node.name || '')) {
            accessories.push(node);
        }
    });

    for (const accessory of accessories) {
        accessory.removeFromParent();
        disposeObject(accessory);
    }

    return accessories.map(accessory => accessory.name);
}

/* ==================== COMPONENT ==================== */

const AvatarScene3D = forwardRef(function AvatarScene3D(
    { className, style, onStatusChange, onPlayingSign },
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

            // Seed-san includes a separate mechanical arm mounted behind the
            // character. It is not part of the humanoid rig used for signing,
            // so remove it before framing and rendering the avatar.
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

            sceneDataRef.current = {
                vrm,
                vrmRetargeter: new VrmHolisticRetargeter(vrm),
            };
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

            if (!sd || anim.queue.length === 0) {
                anim.isPlaying = false;
                anim.currentFrames = null;
                anim.currentSign = null;
                anim.currentFrameIdx = 0;
                anim.frameTimer = 0;
                resetPose(sd);
                setCurrentGloss(null);
                updateStatus('Mô hình tay sẵn sàng');
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

            const label = `Đang ký: ${current.vi} (${current.gloss.toUpperCase()})`;
            updateStatus(label);
            setCurrentGloss(current.gloss);
            onPlayingSign?.(current);
        }

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

            const signDataList = [];
            for (const sign of foundSigns) {
                try {
                    const resp = await fetch(`/api/landmarks/${sign.gloss}`);
                    if (resp.ok) {
                        const result = await resp.json();
                        if (result.data?.frames?.length > 0) {
                            signDataList.push({ gloss: sign.gloss, vi: sign.vi, data: result.data });
                        }
                    }
                } catch (err) {
                    console.warn(`[Avatar] Failed to load "${sign.gloss}":`, err);
                }
            }

            if (signDataList.length > 0) {
                const anim = animDataRef.current;
                anim.queue = signDataList;
                anim.isPlaying = true;

                const current = anim.queue.shift();
                anim.currentSign = current;
                anim.currentFrames = current.data.frames;
                anim.currentFps = current.data.fps || 25;
                anim.currentFrameIdx = 0;
                anim.frameTimer = 0;
                anim.isTransitioning = true;
                anim.transitionProgress = 0;

                updateStatus(`Đang ký: ${current.vi} (${current.gloss.toUpperCase()})`);
                setCurrentGloss(current.gloss);
                onPlayingSign?.(current);
            } else {
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
            resetPose(sceneDataRef.current);
            setCurrentGloss(null);
            updateStatus('Mô hình tay sẵn sàng');
        },

        get isModelLoaded() { return isModelLoaded; },
    }), [isModelLoaded, updateStatus, onPlayingSign]);

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
