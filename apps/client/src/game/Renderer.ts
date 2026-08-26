import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { GameMap } from '@webgame/shared';

export type Quality = 'low' | 'medium' | 'high';

/**
 * How hard each tier pushes the GPU. `low` skips the post chain and shadows
 * entirely and renders below native resolution, which is what makes integrated
 * graphics playable; `high` is the full pipeline.
 */
interface Tier {
  post: boolean;
  bloom: boolean;
  smaa: boolean;
  shadows: boolean;
  shadowMapSize: number;
  maxPixelRatio: number;
}

const TIERS: Record<Quality, Tier> = {
  low: { post: false, bloom: false, smaa: false, shadows: false, shadowMapSize: 512, maxPixelRatio: 1 },
  medium: { post: true, bloom: true, smaa: false, shadows: true, shadowMapSize: 1024, maxPixelRatio: 1.25 },
  high: { post: true, bloom: true, smaa: true, shadows: true, shadowMapSize: 2048, maxPixelRatio: 2 },
};

/** Dynamic resolution never drops below this fraction of the chosen scale. */
const MIN_DYNAMIC_SCALE = 0.55;

/** Exposure at brightness 1.0. Tuned so the sky peaks just under clipping. */
const BASE_EXPOSURE = 1.05;

const GRADE_VIGNETTE = 0.5;
const GRADE_GRAIN = 0.022;
const GRADE_ABERRATION = 0.0007;

/** Shared sky palette. Deliberately below 1.0 so nothing clips to white. */
const SKY_ZENITH = 0x3d7fc4;
const SKY_HORIZON = 0xc8d9e8;
const SKY_GROUND = 0x6b6358;
const SKY_ZENITH_SCALE = 0.64;
const SKY_HORIZON_SCALE = 1.05;

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
    uVignette: { value: 0.62 },
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
      col *= mix(1.0, vig, 0.5);

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
  private tier: Tier = TIERS.high;
  /** User-chosen resolution scale (0.5..1). */
  private baseScale = 1;
  /** Extra scale applied by the dynamic-resolution governor. */
  private dynamicScale = 1;
  private dynamicEnabled = true;
  private frameMs = 16.7;
  private lastScaleCheck = 0;
  private lastFrameStamp = 0;
  private screenEffects = true;
  private time = 0;
  private vmScene: THREE.Scene | null = null;
  private vmCamera: THREE.Camera | null = null;

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
    this.renderer.toneMappingExposure = BASE_EXPOSURE;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.05, CAMERA_FAR);

    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
  }

  /**
   * Set up sky, lighting, fog and IBL for a specific map. The low tier skips the
   * atmospheric sky dome and the fixture lights: both are per-fragment costs
   * that dominate on weak GPUs, and the sun plus image-based lighting already
   * carries the scene.
   */
  applyMap(map: GameMap, quality: Quality = 'high'): void {
    const lowSpec = quality === 'low';
    const [dx, dy, dz] = map.sun.dir;
    const sunPos = new THREE.Vector3(-dx, -dy, -dz).normalize();

    // A hand-built gradient dome rather than the physical sky shader. The
    // atmospheric model outputs radiance far above 1.0, so even after ACES the
    // open roof clipped to a flat white sheet that bloom then smeared over the
    // arena. Driving the same palette that bakes the environment map keeps the
    // backdrop and the lighting in agreement, and the brightest texel is a
    // value we chose.
    const segments = lowSpec ? 16 : 32;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_RADIUS, segments, segments / 2),
      makeSkyMaterial(sunPos),
    );
    dome.name = 'sky';
    dome.frustumCulled = false;
    this.scene.add(dome);

    const envTex = buildSkyEnvTexture(sunPos, new THREE.Color(map.sun.color));
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT?.dispose();
    this.envRT = pmrem.fromEquirectangular(envTex);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = lowSpec ? 1.2 : 1.1;
    pmrem.dispose();
    envTex.dispose();

    this.scene.fog = new THREE.FogExp2(map.fog.color, 0.0021);

    this.sun.color = new THREE.Color(map.sun.color);
    this.sun.intensity = map.sun.intensity;
    this.sunDir.set(dx, dy, dz).normalize();
    this.sun.target.position.set(0, 0, 0);
    this.sun.position.set(-this.sunDir.x * 80, -this.sunDir.y * 80, -this.sunDir.z * 80);
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
    if (!lowSpec) {
      for (const l of map.lights) {
        const pl = new THREE.PointLight(l.color, l.intensity * 0.3, l.distance, 2);
        pl.position.set(l.pos[0], l.pos[1], l.pos[2]);
        this.scene.add(pl);
      }
    }

    const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x4a4238, lowSpec ? 1.6 : 1.4);
    this.scene.add(hemi);
  }

  setQuality(q: Quality, vmScene?: THREE.Scene, vmCamera?: THREE.Camera): void {
    this.quality = q;
    this.tier = TIERS[q];
    if (vmScene) this.vmScene = vmScene;
    if (vmCamera) this.vmCamera = vmCamera;

    this.renderer.shadowMap.enabled = this.tier.shadows;
    this.sun.castShadow = this.tier.shadows;
    this.sun.shadow.mapSize.set(this.tier.shadowMapSize, this.tier.shadowMapSize);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;

    this.dynamicScale = 1;
    this.applyPixelRatio();
    this.buildComposer(this.vmScene ?? undefined, this.vmCamera ?? undefined);
    this.resize();
  }

  /** 0.5..1: renders below native resolution and upscales. */
  setRenderScale(scale: number): void {
    this.baseScale = Math.max(0.5, Math.min(1, scale));
    this.dynamicScale = 1;
    this.applyPixelRatio();
    this.resize();
  }

  setDynamicResolution(on: boolean): void {
    this.dynamicEnabled = on;
    if (!on) {
      this.dynamicScale = 1;
      this.applyPixelRatio();
      this.resize();
    }
  }

  private applyPixelRatio(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.tier.maxPixelRatio);
    this.renderer.setPixelRatio(Math.max(0.4, dpr * this.baseScale * this.dynamicScale));
  }

  /**
   * Hold a playable frame rate by trading resolution for speed.
   *
   * Everything here is measured against the wall clock rather than the frame
   * counter. An EMA weighted per frame converges in *frames*, so on the slow
   * machines this exists for it would take half a minute to notice — and the
   * simulation's own delta is clamped, which hides long stalls entirely.
   */
  private governResolution(): void {
    const now = performance.now();
    if (this.lastFrameStamp === 0) {
      this.lastFrameStamp = now;
      this.lastScaleCheck = now;
      return;
    }
    const raw = Math.min(1000, now - this.lastFrameStamp);
    this.lastFrameStamp = now;
    // Time-weighted smoothing: ~0.4s to converge at any frame rate.
    this.frameMs += (raw - this.frameMs) * Math.min(1, raw / 400);

    if (!this.dynamicEnabled) return;
    if (now - this.lastScaleCheck < 700) return;
    this.lastScaleCheck = now;

    // Cost scales with pixel count, so the scale correction is a square root.
    const target = 1000 / 60;
    if (this.frameMs < 13 && this.dynamicScale >= 1) return;
    if (this.frameMs >= 13 && this.frameMs <= 20) return;

    const wanted = this.dynamicScale * Math.sqrt(target / this.frameMs);
    const stepped = Math.max(this.dynamicScale - 0.2, Math.min(this.dynamicScale + 0.1, wanted));
    const next = Math.max(MIN_DYNAMIC_SCALE, Math.min(1, stepped));
    if (Math.abs(next - this.dynamicScale) < 0.02) return;
    this.dynamicScale = next;
    this.applyPixelRatio();
    this.resize();
  }

  get fps(): number {
    return Math.round(1000 / Math.max(1, this.frameMs));
  }

  get resolutionScale(): number {
    return this.baseScale * this.dynamicScale;
  }

  private buildComposer(vmScene?: THREE.Scene, vmCamera?: THREE.Camera): void {
    this.composer?.dispose();
    if (!this.tier.post) {
      this.composer = null;
      this.vmPass = null;
      this.gradePass = null;
      this.bloom = null;
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

    if (this.tier.bloom) {
      const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), this.quality === 'high' ? 0.22 : 0.16, 0.55, 1.0);
      composer.addPass(bloom);
      this.bloom = bloom;
    } else {
      this.bloom = null;
    }

    composer.addPass(new OutputPass());

    const grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
    this.gradePass = grade;
    // Re-assert the player's choice: rebuilding the chain resets the uniforms.
    this.applyScreenEffects();

    if (this.tier.smaa) composer.addPass(new SMAAPass());
    this.composer = composer;
  }

  setDamageFlash(v: number): void {
    if (this.gradePass) this.gradePass.uniforms.uDamage.value = v;
  }

  /**
   * Film grain, vignette and chromatic aberration. Some players read these as
   * smearing or find them nauseating, so they are one switch.
   */
  /**
   * 0.6..1.6 multiplier on exposure. Monitors and rooms vary far more than any
   * single tuned value can cover, so this is a control rather than a constant.
   */
  setBrightness(v: number): void {
    const k = Number.isFinite(v) ? Math.max(0.5, Math.min(2, v)) : 1;
    this.renderer.toneMappingExposure = BASE_EXPOSURE * k;
  }

  setScreenEffects(on: boolean): void {
    this.screenEffects = on;
    this.applyScreenEffects();
  }

  private applyScreenEffects(): void {
    if (!this.gradePass) return;
    const u = this.gradePass.uniforms;
    u.uGrain.value = this.screenEffects ? GRADE_GRAIN : 0;
    u.uVignette.value = this.screenEffects ? GRADE_VIGNETTE : 0;
    u.uAberration.value = this.screenEffects ? GRADE_ABERRATION : 0;
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
    this.governResolution();
    // The rig is fixed on the arena rather than following the player: the map is
    // 68m across and the frustum is 84m, so one map covers all of it. Following
    // the camera left the far side outside the frustum, where three's shadow
    // lookup returns "lit" and the roofed ring popped as you walked toward it.
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
  const zenith = new THREE.Color(SKY_ZENITH);
  const horizon = new THREE.Color(SKY_HORIZON);
  const ground = new THREE.Color(SKY_GROUND);

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
        const scale = SKY_ZENITH_SCALE + t * (SKY_HORIZON_SCALE - SKY_ZENITH_SCALE);
        r *= scale;
        g *= scale;
        b *= scale;
      } else {
        // Ground bounce, fading out with depth below the horizon.
        const t = Math.min(1, -dy * 3);
        const scale = 1.1 * (1 - t * 0.45);
        r = ground.r * scale;
        g = ground.g * scale;
        b = ground.b * scale;
      }

      // Broad, bounded sun lobe: enough to give speculars a direction without
      // any single texel blowing past what a half-float can hold.
      const d = Math.max(0, dx * sunDir.x + dy * sunDir.y + dz * sunDir.z);
      const lobe = Math.pow(d, 220) * 3.2 + Math.pow(d, 12) * 0.55;
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

/**
 * Gradient sky dome matching `buildSkyEnvTexture`. Values stay under 1.2 so the
 * tone mapper has headroom and the sky never becomes a white cut-out.
 */
function makeSkyMaterial(sunDir: THREE.Vector3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: new THREE.Color(SKY_ZENITH).multiplyScalar(SKY_ZENITH_SCALE) },
      uHorizon: { value: new THREE.Color(SKY_HORIZON).multiplyScalar(SKY_HORIZON_SCALE) },
      uGround: { value: new THREE.Color(SKY_GROUND).multiplyScalar(0.55) },
      uSunDir: { value: sunDir.clone() },
      uSunColour: { value: new THREE.Color(0xfff0d8) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uGround;
      uniform vec3 uSunDir;
      uniform vec3 uSunColour;
      varying vec3 vDir;

      void main() {
        vec3 dir = normalize(vDir);
        vec3 col;
        if (dir.y >= 0.0) {
          col = mix(uHorizon, uZenith, pow(clamp(dir.y, 0.0, 1.0), 0.45));
        } else {
          col = mix(uHorizon, uGround, clamp(-dir.y * 3.0, 0.0, 1.0));
        }
        // Soft, bounded sun. A hard disc is what reads as a blown-out hole.
        float d = max(dot(dir, uSunDir), 0.0);
        col += uSunColour * (pow(d, 1200.0) * 1.1 + pow(d, 26.0) * 0.22);
        // OutputPass owns tone mapping and the colour space conversion; every
        // scene material renders into a linear target.
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}
