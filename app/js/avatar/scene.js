/**
 * scene.js
 * Clean Three.js scene optimized for metallic hand model display.
 * Futuristic environment with good reflections for robotic hands.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

class AvatarScene {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.isReady = false;
    if (!this.container) return;

    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();
    this._updateCallbacks = [];

    const hasRenderer = this._initRenderer();
    if (!hasRenderer) return;

    this._initCamera();
    this._initLights();
    this._initEnvironment();
    this._initControls();
    this._initBackground();

    this._animate = this._animate.bind(this);
    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);

    this._animate();
    this.isReady = true;
  }

  _initRenderer() {
    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

      const w = Math.max(this.container.clientWidth, 1);
      const h = Math.max(this.container.clientHeight, 1);
      this.renderer.setSize(w, h);

      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.15;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.container.appendChild(this.renderer.domElement);
      return true;
    } catch (err) {
      console.error('[AvatarScene] WebGL init failed:', err);
      this.container.innerHTML = `
        <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;
          background:#0a0e17;border:1px solid #641a1a;border-radius:8px;padding:16px;text-align:center">
          <p style="color:#f87171;font-size:14px">WebGL không khởi tạo được. Dùng Chrome/Edge.</p>
        </div>`;
      return false;
    }
  }

  _initCamera() {
    const aspect = Math.max(this.container.clientWidth, 1) / Math.max(this.container.clientHeight, 1);
    this.camera = new THREE.PerspectiveCamera(38, aspect, 0.05, 50);
    this.camera.position.set(0, 0.50, 1.4);
    this.camera.lookAt(0, 0.35, 0);
  }

  _initLights() {
    // Ambient base
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));

    // Hemisphere for soft fill
    const hemi = new THREE.HemisphereLight(0xe8f4ff, 0x8eaacc, 0.7);
    hemi.position.set(0, 2, 0);
    this.scene.add(hemi);

    // Key light (main) - strong for metallic reflections
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
    this.scene.add(key);

    // Fill light
    const fill = new THREE.DirectionalLight(0xb7d7ff, 0.9);
    fill.position.set(-2.5, 2, 1.5);
    this.scene.add(fill);

    // Rim light (back-edge definition)
    const rim = new THREE.DirectionalLight(0x88ddff, 0.7);
    rim.position.set(0, 1.5, -3);
    this.scene.add(rim);

    // Bottom accent (futuristic uplighting)
    const bottom = new THREE.PointLight(0x44ccff, 0.4, 3);
    bottom.position.set(0, -0.2, 0.5);
    this.scene.add(bottom);
  }

  _initEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = envTexture;
    pmrem.dispose();
  }

  _initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.35, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 4;
    this.controls.maxPolarAngle = Math.PI * 0.65;
    this.controls.minPolarAngle = Math.PI * 0.15;
    this.controls.update();
  }

  _initBackground() {
    // Gradient background
    this.scene.background = new THREE.Color(0x1a2030);

    // Reflective floor
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(2, 64),
      new THREE.MeshStandardMaterial({
        color: 0x2a3648,
        roughness: 0.3,
        metalness: 0.6,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Subtle glow ring on floor
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.7, 0.008, 12, 64),
      new THREE.MeshStandardMaterial({
        color: 0x55ddff,
        emissive: 0x33aacc,
        emissiveIntensity: 0.6,
        roughness: 0.3,
        metalness: 0.2,
      }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.005;
    this.scene.add(ring);

    // Grid helper (subtle)
    const grid = new THREE.GridHelper(3, 30, 0x334466, 0x253344);
    grid.position.y = 0.001;
    grid.material.transparent = true;
    grid.material.opacity = 0.3;
    this.scene.add(grid);
  }

  onUpdate(callback) {
    this._updateCallbacks.push(callback);
  }

  _animate() {
    if (!this.renderer) return;
    requestAnimationFrame(this._animate);
    const delta = this.clock.getDelta();
    const elapsed = this.clock.getElapsedTime();

    this.controls.update();

    for (const cb of this._updateCallbacks) {
      cb(delta, elapsed);
    }

    this.renderer.render(this.scene, this.camera);
  }

  _onResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const w = Math.max(this.container.clientWidth, 1);
    const h = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    if (this.renderer) this.renderer.dispose();
    if (this.controls) this.controls.dispose();
  }
}

export default AvatarScene;
