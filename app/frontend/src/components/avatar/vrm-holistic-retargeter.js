import * as THREE from 'three';
import { VRMHumanBoneName } from '@pixiv/three-vrm';

const POSE_BONES = [
    [VRMHumanBoneName.LeftUpperArm, 11, 13],
    [VRMHumanBoneName.LeftLowerArm, 13, 15],
    [VRMHumanBoneName.RightUpperArm, 12, 14],
    [VRMHumanBoneName.RightLowerArm, 14, 16],
];

const FINGER_CHAINS = {
    left: [
        ['Thumb', [1, 2, 3, 4], ['Metacarpal', 'Proximal', 'Distal']],
        ['Index', [5, 6, 7, 8], ['Proximal', 'Intermediate', 'Distal']],
        ['Middle', [9, 10, 11, 12], ['Proximal', 'Intermediate', 'Distal']],
        ['Ring', [13, 14, 15, 16], ['Proximal', 'Intermediate', 'Distal']],
        ['Little', [17, 18, 19, 20], ['Proximal', 'Intermediate', 'Distal']],
    ],
    right: [
        ['Thumb', [1, 2, 3, 4], ['Metacarpal', 'Proximal', 'Distal']],
        ['Index', [5, 6, 7, 8], ['Proximal', 'Intermediate', 'Distal']],
        ['Middle', [9, 10, 11, 12], ['Proximal', 'Intermediate', 'Distal']],
        ['Ring', [13, 14, 15, 16], ['Proximal', 'Intermediate', 'Distal']],
        ['Little', [17, 18, 19, 20], ['Proximal', 'Intermediate', 'Distal']],
    ],
};

const _sourceDirection = new THREE.Vector3();
const _targetWorldQuaternion = new THREE.Quaternion();
const _parentWorldQuaternion = new THREE.Quaternion();
const _targetLocalQuaternion = new THREE.Quaternion();
const _rotationDelta = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _restBasis = new THREE.Matrix4();
const _sourceBasis = new THREE.Matrix4();
const _restBasisQuaternion = new THREE.Quaternion();
const _sourceBasisQuaternion = new THREE.Quaternion();
const _palmAcross = new THREE.Vector3();
const _palmForward = new THREE.Vector3();
const _palmNormal = new THREE.Vector3();

function pointToWorld(point, target) {
    target.set(
        Number(point?.x) || 0,
        -(Number(point?.y) || 0),
        -(Number(point?.z) || 0),
    );
    return target;
}

function isValidTrack(track, minimum) {
    return Array.isArray(track) && track.length >= minimum && track.some(point =>
        Math.abs(Number(point?.x) || 0) +
        Math.abs(Number(point?.y) || 0) +
        Math.abs(Number(point?.z) || 0) > 1e-7
    );
}

export class VrmHolisticRetargeter {
    constructor(vrm) {
        this.vrm = vrm;
        this.rest = new Map();
        this.lastFrame = null;

        for (const [boneName] of POSE_BONES) {
            this.captureRestBone(boneName);
        }
        this.captureRestBone(VRMHumanBoneName.LeftHand);
        this.captureRestBone(VRMHumanBoneName.RightHand);
        this.captureRestPalm('left');
        this.captureRestPalm('right');

        for (const side of ['left', 'right']) {
            for (const [finger, , segments] of FINGER_CHAINS[side]) {
                for (const segment of segments) {
                    this.captureRestBone(`${side}${finger}${segment}`);
                }
            }
        }
    }

    captureRestBone(boneName) {
        const bone = this.vrm.humanoid?.getNormalizedBoneNode(boneName);
        if (!bone) return;
        bone.updateWorldMatrix(true, false);
        const origin = bone.getWorldPosition(new THREE.Vector3());
        let direction;
        if (bone.children[0]) {
            bone.children[0].updateWorldMatrix(true, false);
            direction = bone.children[0]
                .getWorldPosition(new THREE.Vector3())
                .sub(origin)
                .normalize();
        } else if (bone.parent) {
            direction = origin
                .clone()
                .sub(bone.parent.getWorldPosition(new THREE.Vector3()))
                .normalize();
        } else {
            return;
        }
        this.rest.set(boneName, {
            localQuaternion: bone.quaternion.clone(),
            worldQuaternion: bone.getWorldQuaternion(new THREE.Quaternion()),
            worldDirection: direction,
        });
    }

    captureRestPalm(side) {
        const handName = side === 'left'
            ? VRMHumanBoneName.LeftHand
            : VRMHumanBoneName.RightHand;
        const indexName = `${side}IndexProximal`;
        const littleName = `${side}LittleProximal`;
        const hand = this.vrm.humanoid?.getNormalizedBoneNode(handName);
        const index = this.vrm.humanoid?.getNormalizedBoneNode(indexName);
        const little = this.vrm.humanoid?.getNormalizedBoneNode(littleName);
        if (!hand || !index || !little) return;

        hand.updateWorldMatrix(true, false);
        index.updateWorldMatrix(true, false);
        little.updateWorldMatrix(true, false);
        const wrist = hand.getWorldPosition(new THREE.Vector3());
        const indexPosition = index.getWorldPosition(new THREE.Vector3());
        const littlePosition = little.getWorldPosition(new THREE.Vector3());
        const across = littlePosition.sub(indexPosition).normalize();
        const forward = index.getWorldPosition(new THREE.Vector3())
            .add(little.getWorldPosition(new THREE.Vector3()))
            .multiplyScalar(0.5)
            .sub(wrist)
            .normalize();
        const normal = new THREE.Vector3()
            .crossVectors(across, forward)
            .normalize();
        across.crossVectors(forward, normal).normalize();

        _restBasis.makeBasis(across, forward, normal);
        this.restPalms ??= new Map();
        this.restPalms.set(side, {
            basisQuaternion: new THREE.Quaternion().setFromRotationMatrix(_restBasis),
            worldQuaternion: hand.getWorldQuaternion(new THREE.Quaternion()),
        });
    }

    apply(frame, delta) {
        if (!frame) return;
        const smoothing = 1 - Math.exp(-Math.max(delta, 0) * 18);
        const pose = isValidTrack(frame.pose_world, 25)
            ? frame.pose_world
            : frame.pose;

        if (isValidTrack(pose, 25)) {
            for (const [boneName, startIndex, endIndex] of POSE_BONES) {
                this.applyBoneDirection(
                    boneName,
                    pose[startIndex],
                    pose[endIndex],
                    smoothing,
                );
            }
        }

        this.applyPalm('left', frame.left_hand, smoothing);
        this.applyPalm('right', frame.right_hand, smoothing);
        this.applyHand('left', frame.left_hand, smoothing);
        this.applyHand('right', frame.right_hand, smoothing);
        this.applyFace(frame.face_blendshapes, smoothing);
        this.vrm.update(delta);
        this.lastFrame = frame;
    }

    applyBoneDirection(boneName, startPoint, endPoint, smoothing) {
        const bone = this.vrm.humanoid?.getNormalizedBoneNode(boneName);
        const rest = this.rest.get(boneName);
        if (!bone || !rest || !startPoint || !endPoint) return;

        pointToWorld(startPoint, _a);
        pointToWorld(endPoint, _b);
        _sourceDirection.subVectors(_b, _a);
        if (_sourceDirection.lengthSq() < 1e-8) return;
        _sourceDirection.normalize();

        _rotationDelta.setFromUnitVectors(rest.worldDirection, _sourceDirection);
        _targetWorldQuaternion
            .copy(_rotationDelta)
            .multiply(rest.worldQuaternion);

        if (bone.parent) {
            bone.parent.getWorldQuaternion(_parentWorldQuaternion).invert();
            _targetLocalQuaternion
                .copy(_parentWorldQuaternion)
                .multiply(_targetWorldQuaternion);
        } else {
            _targetLocalQuaternion.copy(_targetWorldQuaternion);
        }
        bone.quaternion.slerp(_targetLocalQuaternion, smoothing);
        bone.updateWorldMatrix(false, true);
    }

    applyPalm(side, landmarks, smoothing) {
        if (!isValidTrack(landmarks, 21)) return;
        const restPalm = this.restPalms?.get(side);
        const handName = side === 'left'
            ? VRMHumanBoneName.LeftHand
            : VRMHumanBoneName.RightHand;
        const hand = this.vrm.humanoid?.getNormalizedBoneNode(handName);
        if (!hand || !restPalm) return;

        pointToWorld(landmarks[0], _a);
        pointToWorld(landmarks[5], _b);
        pointToWorld(landmarks[17], _c);
        _palmAcross.subVectors(_c, _b);
        _palmForward
            .copy(_b)
            .add(_c)
            .multiplyScalar(0.5)
            .sub(_a);
        if (_palmAcross.lengthSq() < 1e-8 || _palmForward.lengthSq() < 1e-8) return;

        _palmAcross.normalize();
        _palmForward.normalize();
        _palmNormal.crossVectors(_palmAcross, _palmForward).normalize();
        _palmAcross.crossVectors(_palmForward, _palmNormal).normalize();

        _sourceBasis.makeBasis(_palmAcross, _palmForward, _palmNormal);
        _sourceBasisQuaternion.setFromRotationMatrix(_sourceBasis);
        _rotationDelta
            .copy(_sourceBasisQuaternion)
            .multiply(_restBasisQuaternion.copy(restPalm.basisQuaternion).invert());
        _targetWorldQuaternion
            .copy(_rotationDelta)
            .multiply(restPalm.worldQuaternion);

        if (hand.parent) {
            hand.parent.getWorldQuaternion(_parentWorldQuaternion).invert();
            _targetLocalQuaternion
                .copy(_parentWorldQuaternion)
                .multiply(_targetWorldQuaternion);
        } else {
            _targetLocalQuaternion.copy(_targetWorldQuaternion);
        }
        hand.quaternion.slerp(_targetLocalQuaternion, smoothing);
        hand.updateWorldMatrix(false, true);
    }

    applyHand(side, landmarks, smoothing) {
        if (!isValidTrack(landmarks, 21)) return;

        for (const [finger, indices, segments] of FINGER_CHAINS[side]) {
            for (let segment = 0; segment < 3; segment += 1) {
                const segmentName = segments[segment];
                this.applyBoneDirection(
                    `${side}${finger}${segmentName}`,
                    landmarks[indices[segment]],
                    landmarks[indices[segment + 1]],
                    smoothing,
                );
            }
        }
    }

    applyFace(blendshapes, smoothing) {
        const expressions = this.vrm.expressionManager;
        if (!expressions || !blendshapes) return;
        const mappings = {
            blinkLeft: 'blinkLeft',
            blinkRight: 'blinkRight',
            jawOpen: 'aa',
            mouthSmileLeft: 'happy',
            mouthSmileRight: 'happy',
            browInnerUp: 'surprised',
        };
        for (const [source, target] of Object.entries(mappings)) {
            const current = expressions.getValue(target) || 0;
            const desired = Math.min(Math.max(Number(blendshapes[source]) || 0, 0), 1);
            expressions.setValue(target, THREE.MathUtils.lerp(current, desired, smoothing));
        }
    }

    reset() {
        for (const [boneName, rest] of this.rest) {
            const bone = this.vrm.humanoid?.getNormalizedBoneNode(boneName);
            if (bone) bone.quaternion.copy(rest.localQuaternion);
        }
        this.vrm.expressionManager?.resetValues();
        this.lastFrame = null;
    }
}
