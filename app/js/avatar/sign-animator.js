/**
 * sign-animator.js
 * Animates rigged hand models using sign dictionary landmark data.
 *
 * Flow:
 *   sign:sequence event → fetch landmarks → animate frame by frame on 3D hands
 */

import * as THREE from 'three';
import eventBus from '../event-bus.js';

const API_BASE = window.location.origin;

class SignAnimator {
  /**
   * @param {HandModel} handModel - Loaded HandModel instance
   */
  constructor(handModel) {
    this.handModel = handModel;
    this.queue = [];
    this.isPlaying = false;
    this.currentFrameIdx = 0;
    this.currentFrames = null;
    this.currentFps = 25;
    this.frameTimer = 0;
    this.transitionDuration = 0.35;
    this.isTransitioning = false;
    this.transitionProgress = 0;
    this.prevLeftLandmarks = null;
    this.prevRightLandmarks = null;
  }

  init() {
    eventBus.emit('avatar:status', { text: 'Mô hình tay sẵn sàng' });
    eventBus.emit('avatar:idle', {});

    eventBus.on('sign:sequence', (data) => {
      this._onSignSequence(data);
    });
  }

  async _onSignSequence(data) {
    const foundSigns = data.signs.filter(s => s.found && s.gloss);

    if (foundSigns.length === 0) {
      eventBus.emit('avatar:status', { text: 'Không tìm thấy ký hiệu' });
      return;
    }

    eventBus.emit('avatar:status', { text: 'Đang tải dữ liệu...' });

    const signDataList = [];
    for (const sign of foundSigns) {
      try {
        const resp = await fetch(`${API_BASE}/api/landmarks/${sign.gloss}`);
        if (resp.ok) {
          const result = await resp.json();
          signDataList.push({
            gloss: sign.gloss,
            vi: sign.vi,
            data: result.data,
          });
        }
      } catch (err) {
        console.warn(`[SignAnimator] Failed to load "${sign.gloss}":`, err);
      }
    }

    if (signDataList.length > 0) {
      this.queue = signDataList;
      this._startPlaying();
    }
  }

  _startPlaying() {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      this.currentFrames = null;
      this.currentFrameIdx = 0;
      this.frameTimer = 0;
      this.handModel.resetPose();
      eventBus.emit('avatar:status', { text: 'Mô hình tay sẵn sàng' });
      eventBus.emit('avatar:idle', {});
      return;
    }

    this.isPlaying = true;
    const current = this.queue.shift();

    eventBus.emit('avatar:status', {
      text: `Đang ký: ${current.vi} (${current.gloss.toUpperCase()})`,
    });
    eventBus.emit('avatar:playing', { gloss: current.gloss, vi: current.vi });

    this.currentFrames = current.data.frames;
    this.currentFps = current.data.fps || 25;
    this.currentFrameIdx = 0;
    this.frameTimer = 0;
    this.isTransitioning = true;
    this.transitionProgress = 0;
  }

  update(delta) {
    if (!this.isPlaying || !this.currentFrames) return;

    if (this.isTransitioning) {
      this.transitionProgress += delta / this.transitionDuration;
      if (this.transitionProgress >= 1) {
        this.isTransitioning = false;
        this.transitionProgress = 1;
      }

      if (this.currentFrames.length > 0) {
        const firstFrame = this.currentFrames[0];
        const t = this._easeInOutCubic(this.transitionProgress);

        if (firstFrame.left_hand) {
          const from = this.prevLeftLandmarks || firstFrame.left_hand;
          this.handModel.setHandLandmarks('left', this._lerpLandmarks(from, firstFrame.left_hand, t));
        }
        if (firstFrame.right_hand) {
          const from = this.prevRightLandmarks || firstFrame.right_hand;
          this.handModel.setHandLandmarks('right', this._lerpLandmarks(from, firstFrame.right_hand, t));
        }
      }
      return;
    }

    this.frameTimer += delta;
    const frameDuration = 1 / this.currentFps;

    if (this.frameTimer >= frameDuration) {
      this.frameTimer -= frameDuration;
      this.currentFrameIdx++;

      if (this.currentFrameIdx >= this.currentFrames.length) {
        const lastFrame = this.currentFrames[this.currentFrames.length - 1];
        this.prevLeftLandmarks = lastFrame?.left_hand || null;
        this.prevRightLandmarks = lastFrame?.right_hand || null;
        this._startPlaying();
        return;
      }
    }

    const frame = this.currentFrames[this.currentFrameIdx];
    if (!frame) return;

    const nextIdx = Math.min(this.currentFrameIdx + 1, this.currentFrames.length - 1);
    const nextFrame = this.currentFrames[nextIdx];
    const t = this.frameTimer / frameDuration;

    if (frame.left_hand) {
      this.handModel.setHandLandmarks('left',
        this._lerpLandmarks(frame.left_hand, nextFrame?.left_hand || frame.left_hand, t));
    }
    if (frame.right_hand) {
      this.handModel.setHandLandmarks('right',
        this._lerpLandmarks(frame.right_hand, nextFrame?.right_hand || frame.right_hand, t));
    }
  }

  _lerpLandmarks(a, b, t) {
    if (!a || !b) return a || b;
    return a.map((av, i) => {
      const bv = b[i] || av;
      return {
        x: THREE.MathUtils.lerp(av.x, bv.x, t),
        y: THREE.MathUtils.lerp(av.y, bv.y, t),
        z: THREE.MathUtils.lerp(av.z || 0, bv.z || 0, t),
      };
    });
  }

  _easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  stop() {
    this.isPlaying = false;
    this.queue = [];
    this.currentFrames = null;
    this.currentFrameIdx = 0;
    this.frameTimer = 0;
    this.isTransitioning = false;
    this.handModel.resetPose();
    eventBus.emit('avatar:status', { text: 'Mô hình tay sẵn sàng' });
    eventBus.emit('avatar:idle', {});
  }
}

export default SignAnimator;
