import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { GameMap } from '@webgame/shared';

export type Quality = 'low' | 'medium' | 'high';

/** Sky dome radius. Must stay inside the camera far plane or the backdrop and
 * the IBL capture both clip away to black. */
const SKY_RADIUS = 900;
const CAMERA_FAR = 2400;

/** Film grain + vignette + subtle chromatic aberration, tuned to be barely
 * noticeable on its own but to stop the image looking like raw WebGL. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.9 },
    uGrain: { value: 0.022 },
    uAberration: { value: 0.0007 },
    uDamage: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uDamage;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      float ab = uAberration * (1.0 + uDamage * 4.0);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + c * ab).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - c * ab).b;

      float vig = smoothstep(0.95, 0.25, r2 * uVignette * 2.2);
      col *= mix(1.0, vig, 0.75);

      float g = hash(vUv * vec2(1024.0, 1024.0) + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain;

      col = mix(col, vec3(dot(col, vec3(0.3, 0.59, 0.11))) * vec3(1.5, 0.35, 0.3), uDamage * 0.55);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class RenderSystem {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private gradePass: ShaderPass | null = null;
  private vmPass: RenderPass | null = null;
  private sun: THREE.DirectionalLight;
  private readonly sunDir = new THREE.Vector3(-0.4, -0.7, -0.6);
  private envRT: THREE.WebGLRenderTarget | null = null;
  private quality: Quality = 'high';
  private time = 0;

  constructor(container: HTMLElement, fov: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game';
    container.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.72;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.05, CAMERA_FAR);

    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
  }

  /** Set up sky, lighting, fog and IBL for a specific map. */
  applyMap(map: GameMap): void {
    const [dx, dy, dz] = map.sun.dir;
    const sunPos = new THREE.Vector3(-dx, -dy, -dz).normalize();

    // Physical sky, both as the visible backdrop and as the IBL source. This is
    // what gives metal its blue sheen and shaded faces their bounce light.
    const sky = new Sky();
    sky.scale.setScalar(SKY_RADIUS);
    const u = sky.material.uniforms;
    u.turbidity.value = 4.5;
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.82;
    sky.material.toneMapped = true;
    u.sunPosition.value.copy(sunPos);
    this.scene.add(sky);

    // IBL comes from a hand-built gradient rather than from prefiltering the sky
    // itself: the physical sky's solar disc exceeds half-float range, and the
    // resulting Inf/NaN in the environment map turns every lit surface black
    // (and then spreads across the whole frame through the bloom blur).
    const envTex = buildSkyEnvTexture(sunPos, new THREE.Color(map.sun.color));
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT?.dispose();
    this.envRT = pmrem.fromEquirectangular(envTex);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.5;
    pmrem.dispose();
    envTex.dispose();

    this.scene.fog = new THREE.FogExp2(map.fog.color, 0.0021);

    this.sun.color = new THREE.Color(map.sun.color);
    this.sun.intensity = map.sun.intensity;
    this.sunDir.set(dx, dy, dz).normalize();
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = true;
    const span = Math.max(map.bounds.max[0] - map.bounds.min[0], map.bounds.max[2] - map.bounds.min[2]) * 0.62;
    const cam = this.sun.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.near = 1;
    cam.far = 200;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.035;

    // Fill lights from the map definition (no shadows: too costly for many).
    for (const l of map.lights) {
      const pl = new THREE.PointLight(l.color, l.intensity * 0.3, l.distance, 2);
      pl.position.set(l.pos[0], l.pos[1], l.pos[2]);
      this.scene.add(pl);
    }

    const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x2a2620, 0.22);
    this.scene.add(hemi);
  }

  setQuality(q: Quality, vmScene?: THREE.Scene, vmCamera?: THREE.Camera): void {
    this.quality = q;
    this.renderer.shadowMap.enabled = q !== 'low';
    const shadowSize = q === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    this.renderer.setPixelRatio(q === 'low' ? 1 : Math.min(devicePixelRatio, q === 'high' ? 2 : 1.5));
    this.buildComposer(vmScene, vmCamera);
    this.resize();
  }

  private buildComposer(vmScene?: THREE.Scene, vmCamera?: THREE.Camera): void {
    this.composer?.dispose();
    if (this.quality === 'low') {
      this.composer = null;
      this.vmPass = null;
      this.gradePass = null;
      return;
    }
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));

    if (vmScene && vmCamera) {
      // Draw the viewmodel on top of the world but still inside the post chain,
      // so it picks up bloom and AA without being occluded by geometry.
      const vmPass = new RenderPass(vmScene, vmCamera);
      vmPass.clear = false;
      vmPass.clearDepth = true;
      composer.addPass(vmPass);
      this.vmPass = vmPass;
    } else {
      this.vmPass = null;
    }

    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), this.quality === 'high' ? 0.22 : 0.16, 0.55, 1.0);
    composer.addPass(bloom);
    this.bloom = bloom;

    const grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
    this.gradePass = grade;

    composer.addPass(new OutputPass());
    if (this.quality === 'high') composer.addPass(new SMAAPass());
    this.composer = composer;
  }

  setDamageFlash(v: number): void {
    if (this.gradePass) this.gradePass.uniforms.uDamage.value = v;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
    this.bloom?.setSize(w, h);
  }

  setFov(fov: number): void {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  render(dt: number, vmScene: THREE.Scene, vmCamera: THREE.Camera): void {
    this.time += dt;
    this.renderer.info.reset();
    // Keep the sun rig centred on the player so the shadow map stays tight.
    const focusX = this.camera.position.x;
    const focusZ = this.camera.position.z;
    this.sun.target.position.set(focusX, 0, focusZ);
    this.sun.position.set(focusX - this.sunDir.x * 80, -this.sunDir.y * 80, focusZ - this.sunDir.z * 80);
    this.sun.target.updateMatrixWorld();

    if (this.gradePass) this.gradePass.uniforms.uTime.value = this.time;

    if (this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(vmScene, vmCamera);
      this.renderer.autoClear = true;
    }
  }

  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  /** Prefiltered sky environment, shared with the viewmodel scene. */
  get environment(): THREE.Texture | null {
    return this.envRT ? this.envRT.texture : null;
  }
}

/**
 * Equirectangular sky/ground gradient with a bounded sun lobe, used as the IBL
 * source. Values stay well inside half-float range so the prefiltered mips
 * never produce Inf.
 */
function buildSkyEnvTexture(sunDir: THREE.Vector3, sunColour: THREE.Color): THREE.DataTexture {
  const W = 256;
  const H = 128;
  const data = new Float32Array(W * H * 4);
  const zenith = new THREE.Color(0x3d7fc4);
  const horizon = new THREE.Color(0xc8d9e8);
  const ground = new THREE.Color(0x3a342c);

  for (let y = 0; y < H; y++) {
    const theta = ((y + 0.5) / H) * Math.PI; // 0 at the zenith
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    for (let x = 0; x < W; x++) {
      const phi = ((x + 0.5) / W) * Math.PI * 2 - Math.PI;
      const dx = sinT * Math.sin(phi);
      const dy = cosT;
      const dz = sinT * Math.cos(phi);

      let r: number;
      let g: number;
      let b: number;
      if (dy >= 0) {
        // Sky: zenith -> horizon, brightening toward the horizon haze.
        const t = Math.pow(1 - dy, 2.2);
        r = zenith.r + (horizon.r - zenith.r) * t;
        g = zenith.g + (horizon.g - zenith.g) * t;
        b = zenith.b + (horizon.b - zenith.b) * t;
        const scale = 0.85 + t * 0.65;
        r *= scale;
        g *= scale;
        b *= scale;
      } else {
        // Ground bounce, fading out with depth below the horizon.
        const t = Math.min(1, -dy * 3);
        const scale = 0.38 * (1 - t * 0.6);
        r = ground.r * scale;
        g = ground.g * scale;
        b = ground.b * scale;
      }

      // Broad, bounded sun lobe: enough to give speculars a direction without
      // any single texel blowing past what a half-float can hold.
      const d = Math.max(0, dx * sunDir.x + dy * sunDir.y + dz * sunDir.z);
      const lobe = Math.pow(d, 220) * 6 + Math.pow(d, 12) * 0.9;
      r += sunColour.r * lobe;
      g += sunColour.g * lobe;
      b += sunColour.b * lobe;

      const i = (y * W + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
