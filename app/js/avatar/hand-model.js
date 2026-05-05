/**
 * hand-model.js
 * Loads rigged_hand.glb (SkinnedMesh with skeleton) and maps
 * MediaPipe 21-landmark data to bone rotations for animation.
 *
 * Bone hierarchy (from GLB analysis):
 *   _rootJoint → pulse.R → hand.R →
 *     thumb_base.R  → thumb_01.R  → thumb_02.R  → thumb_03.R
 *     index_base.R  → index_01.R  → index_02.R  → index_03.R
 *     middle_base.R → middle_01.R → middle_02.R → middle_03.R
 *     ring_base.R   → ring_01.R   → ring_02.R   → ring_03.R
 *     pinky_base.R  → pinky_01.R  → pinky_02.R  → pinky_03.R
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

/* ==================== BONE NAME MAPPING ==================== */

// Map finger → bone names (matching Three.js loaded names - dots are stripped)
const BONE_MAP = {
  thumb: {
    base: 'thumb_baseR',
    b01:  'thumb_01R',
    b02:  'thumb_02R',
    b03:  'thumb_03R',
  },
  index: {
    base: 'index_baseR',
    b01:  'index_01R',
    b02:  'index_02R',
    b03:  'index_03R',
  },
  middle: {
    base: 'middle_baseR',
    b01:  'middle_01R',
    b02:  'middle_02R',
    b03:  'middle_03R',
  },
  ring: {
    base: 'ring_baseR',
    b01:  'ring_01R',
    b02:  'ring_02R',
    b03:  'ring_03R',
  },
  pinky: {
    base: 'pinky_baseR',
    b01:  'pinky_01R',
    b02:  'pinky_02R',
    b03:  'pinky_03R',
  },
};

// MediaPipe landmark indices per finger
// [wrist/palm-base, mcp, pip, dip, tip]
const FINGER_LM = {
  thumb:  [0, 1, 2, 3, 4],
  index:  [0, 5, 6, 7, 8],
  middle: [0, 9, 10, 11, 12],
  ring:   [0, 13, 14, 15, 16],
  pinky:  [0, 17, 18, 19, 20],
};


/* ==================== HAND MODEL CLASS ==================== */

class HandModel {
  constructor(scene) {
    this.scene = scene;
    this.loaded = false;

    this.leftHand = null;
    this.rightHand = null;
    this.leftBones = null;
    this.rightBones = null;

    // Store rest pose quaternions for delta rotation
    this.restQuats = {};
  }

  async load(url) {
    const loader = new GLTFLoader();
    let gltf;

    try {
      gltf = await loader.loadAsync(url);
    } catch (err) {
      console.error('[HandModel] Load failed:', err);
      throw err;
    }

    const original = gltf.scene;

    // Calculate model scale to fit scene
    const box = new THREE.Box3().setFromObject(original);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scaleFactor = 0.45 / maxDim;

    console.log(`[HandModel] Size: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}, scale=${scaleFactor.toFixed(4)}`);

    // Apply premium materials
    this._applyMaterials(original);

    // === LEFT HAND ===
    this.leftHand = SkeletonUtils.clone(original);
    this.leftHand.name = 'left_hand';
    this.leftHand.scale.setScalar(scaleFactor);
    this.leftHand.position.set(-0.22, 0.30, 0.05);
    // Rotate to face camera, palm forward
    this.leftHand.rotation.set(0, Math.PI, 0);
    this.scene.add(this.leftHand);

    this.leftBones = this._collectBones(this.leftHand);

    // === RIGHT HAND (mirrored) ===
    this.rightHand = SkeletonUtils.clone(original);
    this.rightHand.name = 'right_hand';
    this.rightHand.scale.set(scaleFactor, scaleFactor, scaleFactor);
    this.rightHand.position.set(0.22, 0.30, 0.05);
    this.rightHand.rotation.set(0, 0, 0);
    this.scene.add(this.rightHand);

    this.rightBones = this._collectBones(this.rightHand);

    // Save rest pose quaternions
    this._saveRestPose(this.leftBones, 'left');
    this._saveRestPose(this.rightBones, 'right');

    this.loaded = true;
    const boneCount = Object.keys(this.leftBones).length;
    console.log(`[HandModel] Ready! ${boneCount} bones mapped per hand`);

    return this;
  }

  /* ==================== MATERIALS ==================== */

  _applyMaterials(model) {
    const mainMat = new THREE.MeshPhysicalMaterial({
      color: 0xd8e2ec,
      metalness: 0.75,
      roughness: 0.20,
      clearcoat: 0.8,
      clearcoatRoughness: 0.1,
      envMapIntensity: 1.5,
    });

    model.traverse(node => {
      if (!node.isMesh) return;
      node.material = mainMat;
      node.castShadow = true;
      node.receiveShadow = true;
      if (node.isSkinnedMesh) node.frustumCulled = false;
    });
  }

  /* ==================== BONE COLLECTION ==================== */

  _collectBones(handModel) {
    const bones = {};

    // Traverse ALL nodes and match by name pattern

    handModel.traverse(node => {
      if (!node.name) return;

      const name = node.name;
      // Strip suffixes like _08, _017, _018 etc.
      const cleanName = name.replace(/_0?\d{1,3}$/, '');

      // Map to our bone dictionary
      for (const [finger, boneNames] of Object.entries(BONE_MAP)) {
        for (const [key, targetName] of Object.entries(boneNames)) {
          if (cleanName === targetName || name.startsWith(targetName + '_')) {
            const boneKey = `${finger}_${key}`;
            bones[boneKey] = node;
          }
        }
      }

      // Also map special bones (dots stripped: pulse.R → pulseR)
      if (cleanName === 'pulseR' || name.startsWith('pulseR_')) {
        bones['wrist'] = node;
      }
      if (cleanName === 'handR' || (name.startsWith('handR_') && !name.includes('001'))) {
        bones['hand'] = node;
      }
    });

    console.log(`[HandModel] Mapped bones:`, Object.keys(bones).join(', '));
    return bones;
  }

  _saveRestPose(bones, side) {
    for (const [key, bone] of Object.entries(bones)) {
      this.restQuats[`${side}_${key}`] = bone.quaternion.clone();
    }
  }

  /* ==================== LANDMARK → BONE ROTATION ==================== */

  /**
   * MediaPipe landmark coordinate system:
   *   X: 0 (left) → 1 (right)  in image space
   *   Y: 0 (top) → 1 (bottom) in image space
   *   Z: depth, negative = closer to camera
   *
   * Model bone coordinate system (from GLB):
   *   Y = along bone (toward fingertip)
   *   X = curl axis (finger bending)
   *   Z = spread axis (finger splay)
   *
   * Strategy: compute bend angle from 3 consecutive landmarks,
   * apply as rotation around bone's local X axis (curl).
   */

  setHandLandmarks(hand, landmarks) {
    if (!this.loaded || !landmarks || landmarks.length < 21) return;

    const bones = hand === 'left' ? this.leftBones : this.rightBones;
    const handObj = hand === 'left' ? this.leftHand : this.rightHand;
    if (!bones || !handObj) return;

    // Convert landmarks to 3D vectors (consistent coordinate space)
    const pts = landmarks.map(lm => new THREE.Vector3(
      (lm.x - 0.5),             // center around 0
      -(lm.y - 0.5),            // flip Y (up = positive)
      -(lm.z || 0) * 0.5,       // depth scaling
    ));

    // Apply wrist/hand orientation
    this._applyWristRotation(bones, pts, hand);

    // Apply per-finger curl
    for (const [fingerName, lmIndices] of Object.entries(FINGER_LM)) {
      this._applyFingerCurl(bones, pts, lmIndices, fingerName, hand);
    }
  }

  _applyWristRotation(bones, pts, side) {
    const wristBone = bones['wrist'] || bones['hand'];
    if (!wristBone) return;

    const wrist = pts[0];
    const middleBase = pts[9];
    const indexBase = pts[5];
    const pinkyBase = pts[17];

    // Palm direction vectors
    const palmForward = new THREE.Vector3().subVectors(middleBase, wrist).normalize();
    const palmSide = new THREE.Vector3().subVectors(pinkyBase, indexBase).normalize();
    const palmNormal = new THREE.Vector3().crossVectors(palmForward, palmSide).normalize();

    // Rebuild orthogonal basis
    const correctedSide = new THREE.Vector3().crossVectors(palmForward, palmNormal).normalize();

    const m = new THREE.Matrix4().makeBasis(correctedSide, palmForward, palmNormal);
    const targetQ = new THREE.Quaternion().setFromRotationMatrix(m);

    const restQ = this.restQuats[`${side}_wrist`] || this.restQuats[`${side}_hand`];
    if (restQ) {
      // Apply as delta from rest: finalQ = restQ * (restQ⁻¹ * targetQ)
      // But simpler: just blend toward target
      wristBone.quaternion.slerp(targetQ, 0.15);
    }
  }

  _applyFingerCurl(bones, pts, lmIndices, fingerName, side) {
    // lmIndices: [wrist, mcp, pip, dip, tip] → 5 points, 3 bones to rotate
    // bone b01 = MCP→PIP segment
    // bone b02 = PIP→DIP segment
    // bone b03 = DIP→TIP segment

    const boneKeys = ['b01', 'b02', 'b03'];

    for (let j = 0; j < 3; j++) {
      const boneKey = `${fingerName}_${boneKeys[j]}`;
      const bone = bones[boneKey];
      if (!bone) continue;

      const prevPt = pts[lmIndices[j]];     // previous joint
      const currPt = pts[lmIndices[j + 1]]; // current joint
      const nextPt = pts[lmIndices[j + 2]]; // next joint

      // Vectors: incoming → current, current → outgoing
      const incoming = new THREE.Vector3().subVectors(prevPt, currPt).normalize();
      const outgoing = new THREE.Vector3().subVectors(nextPt, currPt).normalize();

      // Bend angle (0 = straight, PI = fully folded back)
      const straightAngle = incoming.angleTo(outgoing);
      const bendAmount = Math.PI - straightAngle;

      // Determine bend direction using cross product
      const cross = new THREE.Vector3().crossVectors(incoming, outgoing);

      // Compute curl rotation from rest pose
      const restQ = this.restQuats[`${side}_${boneKey}`];
      if (!restQ) continue;

      // For regular fingers: curl is primarily around local X axis
      // For thumb: curl axis is different
      let curlAxis;
      if (fingerName === 'thumb') {
        // Thumb curls around a blend of X and Z
        curlAxis = new THREE.Vector3(0.8, 0, 0.6).normalize();
      } else {
        curlAxis = new THREE.Vector3(1, 0, 0);
      }

      // Scale the bend: landmarks give 0-PI range, but realistic finger curl is ~0-2.0 rad
      const scaledBend = THREE.MathUtils.clamp(bendAmount * 1.2, 0, 2.2);

      const curlQ = new THREE.Quaternion().setFromAxisAngle(curlAxis, scaledBend);
      const targetQ = restQ.clone().multiply(curlQ);

      // Smooth interpolation
      bone.quaternion.slerp(targetQ, 0.5);
    }

    // SPLAY: spread fingers apart based on base position
    const baseBone = bones[`${fingerName}_base`];
    if (!baseBone || fingerName === 'thumb') return;

    const restBaseQ = this.restQuats[`${side}_${fingerName}_base`];
    if (!restBaseQ) return;

    // Calculate splay from landmark position relative to palm center
    const mcp = pts[lmIndices[1]];
    const palmCenter = pts[0];
    const middleBase = pts[9];

    // Splay direction: MCP offset from palm center line
    const palmDir = new THREE.Vector3().subVectors(middleBase, palmCenter).normalize();
    const mcpDir = new THREE.Vector3().subVectors(mcp, palmCenter).normalize();

    // Cross product gives rotation needed
    const splayCross = new THREE.Vector3().crossVectors(palmDir, mcpDir);
    const splayAngle = palmDir.angleTo(mcpDir) * Math.sign(splayCross.z) * 0.4;

    const splayQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      THREE.MathUtils.clamp(splayAngle, -0.3, 0.3),
    );
    const splayTargetQ = restBaseQ.clone().multiply(splayQ);
    baseBone.quaternion.slerp(splayTargetQ, 0.3);
  }

  /* ==================== RESET ==================== */

  resetPose() {
    // Restore all bones to rest pose
    for (const [key, quat] of Object.entries(this.restQuats)) {
      const [side, ...boneKeyParts] = key.split('_');
      const boneKey = boneKeyParts.join('_');
      const bones = side === 'left' ? this.leftBones : this.rightBones;
      if (bones && bones[boneKey]) {
        bones[boneKey].quaternion.copy(quat);
      }
    }

    // Reset hand rotations
    if (this.leftHand) this.leftHand.rotation.set(0, Math.PI, 0);
    if (this.rightHand) this.rightHand.rotation.set(0, 0, 0);
  }
}

export default HandModel;
