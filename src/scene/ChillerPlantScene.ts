import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CameraPreset, LayerState, ProjectedLabel } from '../types/plant';

export interface SceneCallbacks {
  onSelectMeshKey: (meshKey: string) => void;
  onLabelsUpdate: (labels: ProjectedLabel[]) => void;
  onFpsUpdate: (fps: number) => void;
}

interface ExplodablePart {
  obj: THREE.Object3D;
  basePos: THREE.Vector3;
  explodeOffset: THREE.Vector3;
}

interface FlowPathItem {
  curve: THREE.CurvePath<THREE.Vector3>;
  meshes: THREE.Mesh[];
  speed: number;
}

interface LabelAnchor {
  id: string;
  text: string;
  worldPos: THREE.Vector3;
}

// Pre-allocated math helpers (Zero GC in render loop)
const _vec3 = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();
const _camTargetTarget = new THREE.Vector3(0.9, 1.3, -0.4);
const _camPosTarget = new THREE.Vector3(-12.8, 12.6, 15.8);

const DEFAULT_ISO_POS = new THREE.Vector3(-12.8, 12.6, 15.8);
const DEFAULT_ISO_TARGET = new THREE.Vector3(0.9, 1.3, -0.4);

export class ChillerPlantScene {
  private container: HTMLElement;
  private callbacks: SceneCallbacks;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private pmremGenerator: THREE.PMREMGenerator;
  private envRenderTarget: THREE.WebGLRenderTarget;
  private isSoftwareGl: boolean;

  private clock = new THREE.Clock();
  private frameId = 0;
  private resizeObserver: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerDownPos = new THREE.Vector2();

  // Groups for layers
  private layerGroups: Record<keyof LayerState, THREE.Group>;
  private clickableTargets: THREE.Object3D[] = [];
  private unitGroups = new Map<string, THREE.Group>();
  private selectionBoxHelper: THREE.Group;
  private fanRotors: THREE.Object3D[] = [];
  private explodableParts: ExplodablePart[] = [];
  private flowPaths: FlowPathItem[] = [];
  private labelAnchors: LabelAnchor[] = [];

  // Runtime state
  private isRunning = true;
  private speedMultiplier = 1;
  private targetExplode = 1.0;
  private currentExplode = 1.0;
  private autoOrbit = false;
  private cameraAnimating = false;
  private desiredCamPos = DEFAULT_ISO_POS.clone();
  private desiredCamTarget = DEFAULT_ISO_TARGET.clone();
  private selectedMeshKey = 'chiller-1';
  private showLabels = true;

  // FPS tracking
  private fpsFrames = 0;
  private fpsElapsed = 0;
  private disposed = false;

  // Shared materials to dispose cleanly
  private disposables: Array<{ dispose: () => void }> = [];

  constructor(container: HTMLElement, callbacks: SceneCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.isSoftwareGl = this.detectSoftwareWebGL();

    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x040a12);
    this.scene.fog = new THREE.FogExp2(0x040a12, 0.0155);

    this.camera = new THREE.PerspectiveCamera(31, width / height, 0.2, 160);
    this.camera.position.copy(DEFAULT_ISO_POS);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2),
    );
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    container.appendChild(this.renderer.domElement);

    // Environment Map (Studio reflections for brushed steel & painted vessels)
    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.envRenderTarget = this.pmremGenerator.fromScene(
      new RoomEnvironment(),
      0.04,
    );
    this.scene.environment = this.envRenderTarget.texture;
    this.scene.environmentIntensity = 0.72;

    // OrbitControls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(DEFAULT_ISO_TARGET);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 42;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minPolarAngle = 0.1;
    this.controls.autoRotateSpeed = 0.9;
    this.controls.addEventListener('start', () => {
      this.cameraAnimating = false;
    });
    this.controls.update();

    // Initialize layer groups
    this.layerGroups = {
      chillers: new THREE.Group(),
      pumps: new THREE.Group(),
      coolingTowers: new THREE.Group(),
      valvesAux: new THREE.Group(),
      chwPiping: new THREE.Group(),
      cwPiping: new THREE.Group(),
      flowIndicators: new THREE.Group(),
      steelFrame: new THREE.Group(),
    };
    this.layerGroups.steelFrame.visible = false;
    Object.values(this.layerGroups).forEach((g) => this.scene.add(g));

    this.selectionBoxHelper = new THREE.Group();
    this.scene.add(this.selectionBoxHelper);

    // Build entire environment & mechanical plant
    this.buildLightingAndBackdrop();
    this.buildFloorGrid();
    this.buildPlantEquipment();
    this.buildPipingAndFlows();
    this.buildSteelFrame();
    this.setupLabelAnchors();

    // Initial selection highlight on Chiller #1
    this.updateSelectionHighlight(this.selectedMeshKey);

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    // Event Listeners
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.addEventListener(
      'webglcontextlost',
      this.onContextLost,
    );

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.tick();
  }

  private detectSoftwareWebGL(): boolean {
    try {
      const probeCanvas = document.createElement('canvas');
      const gl = probeCanvas.getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    } catch {
      return true;
    }
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private buildLightingAndBackdrop(): void {
    // Cool/warm industrial studio lighting
    const hemi = new THREE.HemisphereLight(0x7dd3fc, 0x0b1626, 0.65);
    this.scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xeef6ff, 1.85);
    keyLight.position.set(-10, 18, 12);
    keyLight.castShadow = !this.isSoftwareGl;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 2;
    keyLight.shadow.camera.far = 48;
    const d = 14;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.025;
    this.scene.add(keyLight);

    // Warm subtle rim light from right-back to make orange CW piping & metallic bevels pop
    const rimLight = new THREE.DirectionalLight(0xfef3c7, 0.72);
    rimLight.position.set(14, 10, -10);
    this.scene.add(rimLight);

    // Signature volumetric cyan spotlight behind Cooling Towers (matches reference backdrop halo)
    const towerSpot = new THREE.PointLight(0x0ea5e9, 32, 24, 1.6);
    towerSpot.position.set(1.0, 5.2, -5.8);
    this.scene.add(towerSpot);

    const chillerFill = new THREE.PointLight(0x38bdf8, 10, 18, 1.8);
    chillerFill.position.set(-2.2, 4.0, 3.0);
    this.scene.add(chillerFill);

    // Procedural radial cyan volumetric glow backdrop behind Cooling Towers
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = 512;
    glowCanvas.height = 512;
    const gctx = glowCanvas.getContext('2d')!;
    const grad = gctx.createRadialGradient(256, 256, 8, 256, 256, 250);
    grad.addColorStop(0.0, 'rgba(56, 189, 248, 0.75)');
    grad.addColorStop(0.24, 'rgba(14, 165, 233, 0.42)');
    grad.addColorStop(0.55, 'rgba(7, 89, 133, 0.16)');
    grad.addColorStop(1.0, 'rgba(4, 10, 18, 0.0)');
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, 512, 512);

    const glowTex = this.track(new THREE.CanvasTexture(glowCanvas));
    glowTex.colorSpace = THREE.SRGBColorSpace;

    const backdropMat = this.track(
      new THREE.SpriteMaterial({
        map: glowTex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.78,
      }),
    );
    const glowSprite = new THREE.Sprite(backdropMat);
    glowSprite.position.set(1.2, 3.8, -6.2);
    glowSprite.scale.set(13.5, 9.5, 1);
    this.scene.add(glowSprite);
  }

  private buildFloorGrid(): void {
    // High-resolution procedural CAD grid texture with radial fade
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = '#040a12';
    ctx.fillRect(0, 0, size, size);

    // Subtle radial cyan floor pool under plant
    const pool = ctx.createRadialGradient(
      size * 0.5,
      size * 0.42,
      20,
      size * 0.5,
      size * 0.5,
      size * 0.46,
    );
    pool.addColorStop(0, 'rgba(14, 116, 144, 0.22)');
    pool.addColorStop(0.5, 'rgba(8, 51, 68, 0.1)');
    pool.addColorStop(1, 'rgba(4, 10, 18, 0)');
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, size, size);

    // Minor grid lines
    const cells = 32;
    const step = size / cells;
    ctx.strokeStyle = 'rgba(22, 110, 148, 0.24)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= cells; i++) {
      const p = Math.round(i * step) + 0.5;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }

    // Major grid lines every 4 cells
    ctx.strokeStyle = 'rgba(34, 165, 210, 0.36)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i <= cells; i += 4) {
      const p = Math.round(i * step) + 0.5;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }

    // Mask outer perimeter softly so grid fades cleanly into background
    const mask = ctx.createRadialGradient(
      size * 0.5,
      size * 0.5,
      size * 0.18,
      size * 0.5,
      size * 0.5,
      size * 0.5,
    );
    mask.addColorStop(0, 'rgba(4, 10, 18, 0)');
    mask.addColorStop(0.72, 'rgba(4, 10, 18, 0.35)');
    mask.addColorStop(1, 'rgba(4, 10, 18, 1)');
    ctx.fillStyle = mask;
    ctx.fillRect(0, 0, size, size);

    const gridTex = this.track(new THREE.CanvasTexture(canvas));
    gridTex.colorSpace = THREE.SRGBColorSpace;
    gridTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();

    const floorGeo = this.track(new THREE.PlaneGeometry(46, 46));
    const floorMat = this.track(
      new THREE.MeshStandardMaterial({
        map: gridTex,
        roughness: 0.85,
        metalness: 0.15,
      }),
    );
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(1.2, -0.005, -0.4);
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  private registerUnit(meshKey: string, group: THREE.Group): void {
    group.userData.meshKey = meshKey;
    this.unitGroups.set(meshKey, group);
    this.clickableTargets.push(group);
  }

  private registerExplodable(
    obj: THREE.Object3D,
    offsetX: number,
    offsetY: number,
    offsetZ: number,
  ): void {
    this.explodableParts.push({
      obj,
      basePos: obj.position.clone(),
      explodeOffset: new THREE.Vector3(offsetX, offsetY, offsetZ),
    });
  }

  private buildPlantEquipment(): void {
    // Shared calibrated PBR industrial materials
    const vesselMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x3b4858,
        metalness: 0.68,
        roughness: 0.34,
      }),
    );
    const darkSteelMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x1b2430,
        metalness: 0.72,
        roughness: 0.48,
      }),
    );
    const motorMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x26313e,
        metalness: 0.6,
        roughness: 0.42,
      }),
    );
    const chromeTrimMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x94a3b8,
        metalness: 0.9,
        roughness: 0.2,
      }),
    );
    const chwBlueMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x3da5e8,
        metalness: 0.48,
        roughness: 0.3,
      }),
    );
    const cwOrangeMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        metalness: 0.45,
        roughness: 0.32,
      }),
    );
    const hmiScreenMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x0ea5e9,
        emissive: 0x38bdf8,
        emissiveIntensity: 1.15,
        roughness: 0.2,
      }),
    );

    // 1. THREE CENTRIFUGAL CHILLERS (front-left bank: x = -4.2, -1.7, +0.8, z = 1.2)
    const chillerXs = [-4.2, -1.7, 0.8];
    chillerXs.forEach((cx, idx) => {
      const chiller = this.buildChillerAssembly(
        idx + 1,
        vesselMat,
        darkSteelMat,
        motorMat,
        chromeTrimMat,
        hmiScreenMat,
      );
      chiller.position.set(cx, 0, 1.25);
      this.layerGroups.chillers.add(chiller);
      this.registerUnit(`chiller-${idx + 1}`, chiller);
    });

    // 2. THREE CHW PUMPS (in front-right of chillers, z = 3.9)
    chillerXs.forEach((cx, idx) => {
      const pump = this.buildCentrifugalPump(
        chwBlueMat,
        motorMat,
        darkSteelMat,
        chromeTrimMat,
      );
      pump.position.set(cx + 0.15, 0, 3.85);
      pump.rotation.y = Math.PI * 0.5;
      this.layerGroups.pumps.add(pump);
      this.registerUnit(`chw-pump-${idx + 1}`, pump);
    });

    // 3. THREE CW PUMPS (far right bank: x = 5.4, 6.8, 8.2, z = 1.1)
    const cwPumpXs = [5.4, 6.8, 8.2];
    cwPumpXs.forEach((px, idx) => {
      const pump = this.buildCentrifugalPump(
        cwOrangeMat,
        motorMat,
        darkSteelMat,
        chromeTrimMat,
      );
      pump.position.set(px, 0, 1.15);
      pump.rotation.y = Math.PI * 0.5;
      this.layerGroups.pumps.add(pump);
      this.registerUnit(`cw-pump-${idx + 1}`, pump);
    });

    // 4. TWO INDUCED-DRAFT COOLING TOWERS (rear center: x = -0.9, +2.3, z = -4.6)
    const towerXs = [-0.9, 2.3];
    towerXs.forEach((tx, idx) => {
      const tower = this.buildCoolingTower(
        idx + 1,
        vesselMat,
        darkSteelMat,
        chromeTrimMat,
      );
      tower.position.set(tx, 0, -4.65);
      this.layerGroups.coolingTowers.add(tower);
      this.registerUnit(`cooling-tower-${idx + 1}`, tower);
    });

    // 5. AIR SEPARATOR (center-right at x = 3.25, z = 0.45)
    const airSep = this.buildAirSeparator(
      vesselMat,
      darkSteelMat,
      chromeTrimMat,
      chwBlueMat,
    );
    airSep.position.set(3.25, 0, 0.45);
    this.layerGroups.valvesAux.add(airSep);
    this.registerUnit('air-separator', airSep);

    // 6. PLANT CONTROL PANEL PEDESTAL (far rear-right at x = 7.75, z = -2.2)
    const panel = this.buildControlPanel(darkSteelMat, hmiScreenMat, chromeTrimMat);
    panel.position.set(7.75, 0, -2.15);
    panel.rotation.y = -Math.PI * 0.25;
    this.layerGroups.valvesAux.add(panel);
    this.registerUnit('control-panel', panel);
  }

  private buildChillerAssembly(
    index: number,
    vesselMat: THREE.Material,
    darkSteelMat: THREE.Material,
    motorMat: THREE.Material,
    chromeTrimMat: THREE.Material,
    screenMat: THREE.Material,
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = `chiller-${index}`;

    // Base skid rails sitting flush at y = 0
    const skidGeo = this.track(new THREE.BoxGeometry(1.55, 0.08, 2.95));
    const skid = new THREE.Mesh(skidGeo, darkSteelMat);
    skid.position.set(0, 0.04, 0);
    skid.castShadow = true;
    skid.receiveShadow = true;
    group.add(skid);

    // Mounting saddles (front & rear)
    const saddleGeo = this.track(new THREE.BoxGeometry(1.45, 0.42, 0.16));
    [-1.0, 1.0].forEach((sz) => {
      const saddle = new THREE.Mesh(saddleGeo, darkSteelMat);
      saddle.position.set(0, 0.29, sz);
      saddle.castShadow = true;
      group.add(saddle);
    });

    // Evaporator shell (front-left barrel)
    const evapGroup = new THREE.Group();
    const shellGeo = this.track(new THREE.CylinderGeometry(0.36, 0.36, 2.65, 24));
    const evapShell = new THREE.Mesh(shellGeo, vesselMat);
    evapShell.rotation.x = Math.PI / 2;
    evapShell.castShadow = true;
    evapShell.receiveShadow = true;
    evapGroup.add(evapShell);

    // Bolted waterbox end-caps & flange rings
    const capGeo = this.track(new THREE.CylinderGeometry(0.39, 0.39, 0.22, 24));
    const flangeGeo = this.track(new THREE.TorusGeometry(0.38, 0.03, 10, 24));
    [-1.36, 1.36].forEach((ez) => {
      const cap = new THREE.Mesh(capGeo, darkSteelMat);
      cap.rotation.x = Math.PI / 2;
      cap.position.z = ez;
      cap.castShadow = true;
      evapGroup.add(cap);

      const flange = new THREE.Mesh(flangeGeo, chromeTrimMat);
      flange.position.z = ez * 0.92;
      evapGroup.add(flange);
    });
    evapGroup.position.set(-0.38, 0.64, 0);
    group.add(evapGroup);

    // Condenser shell (slightly elevated rear-right barrel)
    const condGroup = new THREE.Group();
    const condShell = new THREE.Mesh(shellGeo, vesselMat);
    condShell.rotation.x = Math.PI / 2;
    condShell.castShadow = true;
    condShell.receiveShadow = true;
    condGroup.add(condShell);

    [-1.36, 1.36].forEach((ez) => {
      const cap = new THREE.Mesh(capGeo, darkSteelMat);
      cap.rotation.x = Math.PI / 2;
      cap.position.z = ez;
      cap.castShadow = true;
      condGroup.add(cap);

      const flange = new THREE.Mesh(flangeGeo, chromeTrimMat);
      flange.position.z = ez * 0.92;
      condGroup.add(flange);
    });
    condGroup.position.set(0.38, 0.86, 0);
    group.add(condGroup);
    this.registerExplodable(condGroup, 0.25, 0.35, 0);

    // Top Centrifugal Compressor & Ribbed Drive Motor Assembly
    const compGroup = new THREE.Group();
    compGroup.position.set(0.0, 1.32, 0.05);

    const motorBodyGeo = this.track(
      new THREE.CylinderGeometry(0.28, 0.28, 1.05, 20),
    );
    const motorMesh = new THREE.Mesh(motorBodyGeo, motorMat);
    motorMesh.rotation.x = Math.PI / 2;
    motorMesh.position.set(0, 0.04, 0.22);
    motorMesh.castShadow = true;
    compGroup.add(motorMesh);

    // Volute scroll housing
    const voluteGeo = this.track(
      new THREE.CylinderGeometry(0.38, 0.38, 0.34, 24),
    );
    const volute = new THREE.Mesh(voluteGeo, darkSteelMat);
    volute.rotation.x = Math.PI / 2;
    volute.position.set(0, 0.08, -0.45);
    volute.castShadow = true;
    compGroup.add(volute);

    // Suction elbow & discharge pipe stubs
    const stubGeo = this.track(new THREE.CylinderGeometry(0.14, 0.14, 0.45, 14));
    const suctionStub = new THREE.Mesh(stubGeo, vesselMat);
    suctionStub.position.set(-0.3, -0.26, -0.45);
    suctionStub.rotation.z = -0.35;
    compGroup.add(suctionStub);

    const dischStub = new THREE.Mesh(stubGeo, vesselMat);
    dischStub.position.set(0.3, -0.22, -0.45);
    dischStub.rotation.z = 0.4;
    compGroup.add(dischStub);

    // Top VFD / Starter Box on compressor
    const starterGeo = this.track(new THREE.BoxGeometry(0.46, 0.36, 0.56));
    const starter = new THREE.Mesh(starterGeo, darkSteelMat);
    starter.position.set(0.24, 0.22, -0.15);
    starter.castShadow = true;
    compGroup.add(starter);

    group.add(compGroup);
    this.registerExplodable(compGroup, 0, 0.95, 0);

    // Local Chiller Control Panel (front-right)
    const ctrlCab = new THREE.Group();
    const cabGeo = this.track(new THREE.BoxGeometry(0.16, 0.62, 0.44));
    const cab = new THREE.Mesh(cabGeo, darkSteelMat);
    cab.castShadow = true;
    ctrlCab.add(cab);

    const scrGeo = this.track(new THREE.PlaneGeometry(0.22, 0.16));
    const scr = new THREE.Mesh(scrGeo, screenMat);
    scr.position.set(0.082, 0.1, 0);
    scr.rotation.y = Math.PI / 2;
    ctrlCab.add(scr);

    ctrlCab.position.set(0.8, 0.72, 0.65);
    group.add(ctrlCab);
    this.registerExplodable(ctrlCab, 0.45, 0.25, 0);

    return group;
  }

  private buildCentrifugalPump(
    voluteMat: THREE.Material,
    motorMat: THREE.Material,
    darkSteelMat: THREE.Material,
    chromeTrimMat: THREE.Material,
  ): THREE.Group {
    const group = new THREE.Group();

    // Baseplate flush on floor
    const baseGeo = this.track(new THREE.BoxGeometry(1.18, 0.11, 0.58));
    const base = new THREE.Mesh(baseGeo, darkSteelMat);
    base.position.set(0, 0.055, 0);
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    // Motor & pump upper assembly (explodable upward)
    const upper = new THREE.Group();

    const motorGeo = this.track(new THREE.CylinderGeometry(0.21, 0.21, 0.56, 18));
    const motor = new THREE.Mesh(motorGeo, motorMat);
    motor.rotation.z = Math.PI / 2;
    motor.position.set(-0.22, 0.34, 0);
    motor.castShadow = true;
    upper.add(motor);

    // Terminal box on top of motor
    const termGeo = this.track(new THREE.BoxGeometry(0.16, 0.12, 0.16));
    const term = new THREE.Mesh(termGeo, darkSteelMat);
    term.position.set(-0.22, 0.56, 0);
    upper.add(term);

    // Coupling guard
    const coupGeo = this.track(new THREE.CylinderGeometry(0.1, 0.1, 0.2, 12));
    const coup = new THREE.Mesh(coupGeo, chromeTrimMat);
    coup.rotation.z = Math.PI / 2;
    coup.position.set(0.14, 0.34, 0);
    upper.add(coup);

    // Painted Volute Casing (blue for CHW, orange for CW)
    const voluteGeo = this.track(
      new THREE.CylinderGeometry(0.26, 0.26, 0.18, 22),
    );
    const volute = new THREE.Mesh(voluteGeo, voluteMat);
    volute.rotation.z = Math.PI / 2;
    volute.position.set(0.35, 0.36, 0);
    volute.castShadow = true;
    upper.add(volute);

    // Discharge vertical stub + flange
    const dischGeo = this.track(
      new THREE.CylinderGeometry(0.095, 0.095, 0.34, 14),
    );
    const disch = new THREE.Mesh(dischGeo, voluteMat);
    disch.position.set(0.35, 0.62, 0);
    upper.add(disch);

    const flGeo = this.track(new THREE.CylinderGeometry(0.14, 0.14, 0.04, 16));
    const dischFl = new THREE.Mesh(flGeo, voluteMat);
    dischFl.position.set(0.35, 0.78, 0);
    upper.add(dischFl);

    // Suction horizontal stub
    const sucGeo = this.track(
      new THREE.CylinderGeometry(0.1, 0.1, 0.22, 14),
    );
    const suc = new THREE.Mesh(sucGeo, voluteMat);
    suc.rotation.z = Math.PI / 2;
    suc.position.set(0.52, 0.36, 0);
    upper.add(suc);

    group.add(upper);
    this.registerExplodable(upper, 0, 0.55, 0);

    return group;
  }

  private buildCoolingTower(
    index: number,
    panelMat: THREE.Material,
    darkSteelMat: THREE.Material,
    chromeTrimMat: THREE.Material,
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = `cooling-tower-${index}`;

    const W = 2.45;
    const D = 2.2;
    const standH = 1.05;
    const bodyH = 1.65;

    // 1. Structural Steel Support Frame (4 legs + perimeter beams + diagonal cross-bracing)
    const legGeo = this.track(new THREE.BoxGeometry(0.12, standH, 0.12));
    const offsets = [
      [-W / 2 + 0.1, -D / 2 + 0.1],
      [W / 2 - 0.1, -D / 2 + 0.1],
      [-W / 2 + 0.1, D / 2 - 0.1],
      [W / 2 - 0.1, D / 2 - 0.1],
    ];
    offsets.forEach(([lx, lz]) => {
      const leg = new THREE.Mesh(legGeo, darkSteelMat);
      leg.position.set(lx, standH / 2, lz);
      leg.castShadow = true;
      group.add(leg);
    });

    // Horizontal perimeter frame beams
    const beamXGeo = this.track(new THREE.BoxGeometry(W, 0.1, 0.1));
    const beamZGeo = this.track(new THREE.BoxGeometry(0.1, 0.1, D));
    [-D / 2 + 0.1, D / 2 - 0.1].forEach((bz) => {
      const bx = new THREE.Mesh(beamXGeo, darkSteelMat);
      bx.position.set(0, standH - 0.05, bz);
      group.add(bx);
    });
    [-W / 2 + 0.1, W / 2 - 0.1].forEach((bx) => {
      const bz = new THREE.Mesh(beamZGeo, darkSteelMat);
      bz.position.set(bx, standH - 0.05, 0);
      group.add(bz);
    });

    // Front & side X-bracing bars
    const braceGeo = this.track(new THREE.BoxGeometry(0.04, 1.85, 0.04));
    [D / 2 - 0.1, -D / 2 + 0.1].forEach((bz) => {
      const b1 = new THREE.Mesh(braceGeo, darkSteelMat);
      b1.position.set(0, standH / 2, bz);
      b1.rotation.z = 0.96;
      group.add(b1);

      const b2 = new THREE.Mesh(braceGeo, darkSteelMat);
      b2.position.set(0, standH / 2, bz);
      b2.rotation.z = -0.96;
      group.add(b2);
    });

    // 2. Tower Casing & Louvered Intake Section
    const casingGroup = new THREE.Group();
    casingGroup.position.set(0, standH, 0);

    // Cold water collection basin pan
    const basinGeo = this.track(new THREE.BoxGeometry(W + 0.08, 0.24, D + 0.08));
    const basin = new THREE.Mesh(basinGeo, darkSteelMat);
    basin.position.set(0, 0.12, 0);
    basin.castShadow = true;
    casingGroup.add(basin);

    // Main upper tower box
    const bodyGeo = this.track(new THREE.BoxGeometry(W, bodyH - 0.24, D));
    const body = new THREE.Mesh(bodyGeo, panelMat);
    body.position.set(0, 0.24 + (bodyH - 0.24) / 2, 0);
    body.castShadow = true;
    body.receiveShadow = true;
    casingGroup.add(body);

    // Slatted louver bands on front and left/right sides
    const slatGeo = this.track(new THREE.BoxGeometry(W - 0.22, 0.045, 0.06));
    for (let s = 0; s < 6; s++) {
      const sy = 0.34 + s * 0.11;
      const slatF = new THREE.Mesh(slatGeo, darkSteelMat);
      slatF.position.set(0, sy, D / 2 + 0.015);
      slatF.rotation.x = 0.35;
      casingGroup.add(slatF);

      const slatB = new THREE.Mesh(slatGeo, darkSteelMat);
      slatB.position.set(0, sy, -D / 2 - 0.015);
      slatB.rotation.x = -0.35;
      casingGroup.add(slatB);
    }

    // Corner vertical structural posts
    const postGeo = this.track(new THREE.BoxGeometry(0.14, bodyH, 0.14));
    offsets.forEach(([lx, lz]) => {
      const post = new THREE.Mesh(postGeo, darkSteelMat);
      post.position.set(lx, bodyH / 2, lz);
      casingGroup.add(post);
    });

    group.add(casingGroup);
    this.registerExplodable(casingGroup, 0, 0.45, 0);

    // 3. Top Fan Deck + Circular Fan Shroud + Rotating 6-Blade Axial Fan
    const fanDeckGroup = new THREE.Group();
    fanDeckGroup.position.set(0, standH + bodyH, 0);

    const deckPlateGeo = this.track(
      new THREE.BoxGeometry(W + 0.06, 0.08, D + 0.06),
    );
    const deckPlate = new THREE.Mesh(deckPlateGeo, darkSteelMat);
    deckPlate.position.set(0, 0.04, 0);
    fanDeckGroup.add(deckPlate);

    // Dark recessed plenum pit
    const pitGeo = this.track(new THREE.CylinderGeometry(0.76, 0.76, 0.06, 28));
    const pitMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x09131f,
        emissive: 0x083344,
        emissiveIntensity: 0.45,
        roughness: 0.9,
      }),
    );
    const pit = new THREE.Mesh(pitGeo, pitMat);
    pit.position.set(0, 0.08, 0);
    fanDeckGroup.add(pit);

    // Cylindrical fan shroud stack (hollow ring via LatheGeometry)
    const shroudPts = [
      new THREE.Vector2(0.78, 0.0),
      new THREE.Vector2(0.86, 0.0),
      new THREE.Vector2(0.89, 0.34),
      new THREE.Vector2(0.82, 0.36),
      new THREE.Vector2(0.78, 0.04),
    ];
    const shroudGeo = this.track(new THREE.LatheGeometry(shroudPts, 32));
    const shroud = new THREE.Mesh(shroudGeo, panelMat);
    shroud.position.set(0, 0.06, 0);
    shroud.castShadow = true;
    fanDeckGroup.add(shroud);

    // Rotating 6-blade axial fan rotor
    const rotor = new THREE.Group();
    rotor.position.set(0, 0.18, 0);
    const hubGeo = this.track(new THREE.CylinderGeometry(0.16, 0.18, 0.14, 16));
    const hub = new THREE.Mesh(hubGeo, chromeTrimMat);
    rotor.add(hub);

    const bladeGeo = this.track(new THREE.BoxGeometry(0.56, 0.02, 0.14));
    for (let b = 0; b < 6; b++) {
      const bladePivot = new THREE.Group();
      bladePivot.rotation.y = (b * Math.PI * 2) / 6;
      const blade = new THREE.Mesh(bladeGeo, chromeTrimMat);
      blade.position.set(0.42, 0, 0);
      blade.rotation.x = 0.36;
      bladePivot.add(blade);
      rotor.add(bladePivot);
    }
    fanDeckGroup.add(rotor);
    this.fanRotors.push(rotor);

    group.add(fanDeckGroup);
    this.registerExplodable(fanDeckGroup, 0, 1.25, 0);

    return group;
  }

  private buildAirSeparator(
    vesselMat: THREE.Material,
    darkSteelMat: THREE.Material,
    chromeTrimMat: THREE.Material,
    accentBlueMat: THREE.Material,
  ): THREE.Group {
    const group = new THREE.Group();

    // 4 steel support legs flush on y = 0
    const legGeo = this.track(new THREE.CylinderGeometry(0.045, 0.055, 0.58, 10));
    [
      [-0.28, -0.28],
      [0.28, -0.28],
      [-0.28, 0.28],
      [0.28, 0.28],
    ].forEach(([lx, lz]) => {
      const leg = new THREE.Mesh(legGeo, darkSteelMat);
      leg.position.set(lx, 0.29, lz);
      leg.castShadow = true;
      group.add(leg);
    });

    // Main vertical pressure vessel
    const vesselGroup = new THREE.Group();
    const cylGeo = this.track(new THREE.CylinderGeometry(0.42, 0.42, 1.12, 24));
    const cyl = new THREE.Mesh(cylGeo, vesselMat);
    cyl.position.y = 1.05;
    cyl.castShadow = true;
    vesselGroup.add(cyl);

    const domeGeo = this.track(
      new THREE.SphereGeometry(0.42, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    );
    const topDome = new THREE.Mesh(domeGeo, vesselMat);
    topDome.position.y = 1.61;
    vesselGroup.add(topDome);

    const botDome = new THREE.Mesh(domeGeo, darkSteelMat);
    botDome.rotation.x = Math.PI;
    botDome.position.y = 0.49;
    vesselGroup.add(botDome);

    // Band collar & air-eliminator vent valve at top
    const bandGeo = this.track(new THREE.CylinderGeometry(0.435, 0.435, 0.09, 24));
    const band = new THREE.Mesh(bandGeo, accentBlueMat);
    band.position.y = 1.48;
    vesselGroup.add(band);

    const ventGeo = this.track(new THREE.CylinderGeometry(0.06, 0.08, 0.22, 12));
    const vent = new THREE.Mesh(ventGeo, chromeTrimMat);
    vent.position.y = 2.08;
    vesselGroup.add(vent);

    group.add(vesselGroup);
    this.registerExplodable(vesselGroup, 0, 0.65, 0);

    return group;
  }

  private buildControlPanel(
    darkSteelMat: THREE.Material,
    screenMat: THREE.Material,
    chromeTrimMat: THREE.Material,
  ): THREE.Group {
    const group = new THREE.Group();

    const plinthGeo = this.track(new THREE.BoxGeometry(0.55, 0.08, 0.45));
    const plinth = new THREE.Mesh(plinthGeo, darkSteelMat);
    plinth.position.y = 0.04;
    group.add(plinth);

    const postGeo = this.track(new THREE.BoxGeometry(0.22, 0.9, 0.22));
    const post = new THREE.Mesh(postGeo, darkSteelMat);
    post.position.y = 0.52;
    post.castShadow = true;
    group.add(post);

    const headGeo = this.track(new THREE.BoxGeometry(0.62, 0.64, 0.36));
    const head = new THREE.Mesh(headGeo, darkSteelMat);
    head.position.y = 1.24;
    head.castShadow = true;
    group.add(head);

    const bezelGeo = this.track(new THREE.BoxGeometry(0.48, 0.36, 0.03));
    const bezel = new THREE.Mesh(bezelGeo, chromeTrimMat);
    bezel.position.set(0, 1.28, 0.185);
    group.add(bezel);

    const scrGeo = this.track(new THREE.PlaneGeometry(0.42, 0.3));
    const scr = new THREE.Mesh(scrGeo, screenMat);
    scr.position.set(0, 1.28, 0.205);
    group.add(scr);

    return group;
  }

  private buildRoundedPipePath(points: THREE.Vector3[], radius = 0.22): THREE.CurvePath<THREE.Vector3> {
    const path = new THREE.CurvePath<THREE.Vector3>();
    if (points.length < 2) return path;

    let currentStart = points[0].clone();

    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const next = points[i + 1];

      const dirIn = curr.clone().sub(prev);
      const dirOut = next.clone().sub(curr);
      const lenIn = dirIn.length();
      const lenOut = dirOut.length();
      const r = Math.min(radius, lenIn * 0.4, lenOut * 0.4);

      dirIn.normalize();
      dirOut.normalize();

      const pBefore = curr.clone().sub(dirIn.clone().multiplyScalar(r));
      const pAfter = curr.clone().add(dirOut.clone().multiplyScalar(r));

      if (currentStart.distanceTo(pBefore) > 0.001) {
        path.add(new THREE.LineCurve3(currentStart, pBefore));
      }
      path.add(new THREE.QuadraticBezierCurve3(pBefore, curr.clone(), pAfter));
      currentStart = pAfter;
    }

    const last = points[points.length - 1];
    if (currentStart.distanceTo(last) > 0.001) {
      path.add(new THREE.LineCurve3(currentStart, last));
    }

    return path;
  }

  private addPipeRun(
    points: THREE.Vector3[],
    radius: number,
    mat: THREE.Material,
    targetGroup: THREE.Group,
    flowMat?: THREE.Material,
    flowSpeed = 0.16,
    flowCount = 4,
    explodeY = 0,
  ): void {
    const curve = this.buildRoundedPipePath(points, 0.2);
    const tubeGeo = this.track(new THREE.TubeGeometry(curve, 56, radius, 12, false));
    const mesh = new THREE.Mesh(tubeGeo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    targetGroup.add(mesh);

    if (explodeY !== 0) {
      this.registerExplodable(mesh, 0, explodeY, 0);
    }

    if (flowMat && flowCount > 0) {
      const meshes: THREE.Mesh[] = [];
      const arrowGeo = this.track(
        new THREE.CapsuleGeometry(radius * 0.65, radius * 2.2, 4, 8),
      );
      for (let i = 0; i < flowCount; i++) {
        const ind = new THREE.Mesh(arrowGeo, flowMat);
        this.layerGroups.flowIndicators.add(ind);
        meshes.push(ind);
      }
      this.flowPaths.push({ curve, meshes, speed: flowSpeed });
    }
  }

  private addValve(
    pos: THREE.Vector3,
    axis: 'x' | 'y' | 'z',
    bodyMat: THREE.Material,
    wheelMat: THREE.Material,
    meshKey?: string,
  ): void {
    const vGroup = new THREE.Group();
    vGroup.position.copy(pos);

    const bodyGeo = this.track(new THREE.CylinderGeometry(0.16, 0.16, 0.16, 16));
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    if (axis === 'x') body.rotation.z = Math.PI / 2;
    if (axis === 'z') body.rotation.x = Math.PI / 2;
    vGroup.add(body);

    const stemGeo = this.track(new THREE.CylinderGeometry(0.03, 0.03, 0.24, 10));
    const stem = new THREE.Mesh(stemGeo, wheelMat);
    stem.position.y = 0.18;
    vGroup.add(stem);

    const wheelGeo = this.track(new THREE.TorusGeometry(0.11, 0.022, 8, 18));
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.y = 0.3;
    vGroup.add(wheel);

    this.layerGroups.valvesAux.add(vGroup);
    if (meshKey) {
      this.registerUnit(meshKey, vGroup);
    }
  }

  private buildPipingAndFlows(): void {
    const chwPipeMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x4aa8e8,
        metalness: 0.45,
        roughness: 0.28,
      }),
    );
    const cwPipeMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        metalness: 0.42,
        roughness: 0.3,
      }),
    );
    const valveBodyMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        metalness: 0.75,
        roughness: 0.35,
      }),
    );
    const valveWheelMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        metalness: 0.5,
        roughness: 0.3,
      }),
    );
    const chwFlowMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xbae6fd,
        emissive: 0x38bdf8,
        emissiveIntensity: 1.6,
        roughness: 0.2,
      }),
    );
    const cwFlowMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xfef08a,
        emissive: 0xf59e0b,
        emissiveIntensity: 1.5,
        roughness: 0.2,
      }),
    );

    const chillerXs = [-4.2, -1.7, 0.8];

    // --- CHILLED WATER (CHW) PIPING (SKY BLUE) ---
    // 1. Main CHW Supply Header (front of pumps -> left riser "To Building")
    this.addPipeRun(
      [
        new THREE.Vector3(1.4, 0.78, 3.85),
        new THREE.Vector3(-6.4, 0.78, 3.85),
        new THREE.Vector3(-6.4, 2.25, 3.85),
        new THREE.Vector3(-7.6, 2.25, 3.85),
      ],
      0.115,
      chwPipeMat,
      this.layerGroups.chwPiping,
      chwFlowMat,
      0.14,
      6,
      0.35,
    );

    // 2. Main CHW Return Header ("To Building" upper riser -> behind chillers)
    this.addPipeRun(
      [
        new THREE.Vector3(-7.6, 1.8, 2.95),
        new THREE.Vector3(-6.0, 1.8, 2.95),
        new THREE.Vector3(-6.0, 1.05, 2.95),
        new THREE.Vector3(-6.0, 1.05, -0.45),
        new THREE.Vector3(1.2, 1.05, -0.45),
        new THREE.Vector3(3.25, 1.05, 0.45),
      ],
      0.115,
      chwPipeMat,
      this.layerGroups.chwPiping,
      chwFlowMat,
      0.13,
      7,
      0.45,
    );

    // 3. Individual Chiller Evaporator -> CHW Pump branches
    chillerXs.forEach((cx, idx) => {
      // Evaporator front outlet -> pump suction -> supply header
      this.addPipeRun(
        [
          new THREE.Vector3(cx - 0.38, 0.64, 2.6),
          new THREE.Vector3(cx - 0.38, 0.36, 2.95),
          new THREE.Vector3(cx + 0.15, 0.36, 3.35),
        ],
        0.085,
        chwPipeMat,
        this.layerGroups.chwPiping,
        chwFlowMat,
        0.22,
        2,
      );

      // Rear return header drop into chiller evaporator
      this.addPipeRun(
        [
          new THREE.Vector3(cx - 0.38, 1.05, -0.45),
          new THREE.Vector3(cx - 0.38, 0.64, -0.1),
        ],
        0.085,
        chwPipeMat,
        this.layerGroups.chwPiping,
      );

      // Isolation Butterfly Valve on each CHW branch
      this.addValve(
        new THREE.Vector3(cx - 0.15, 0.36, 3.12),
        'z',
        valveBodyMat,
        valveWheelMat,
        `valve-${idx + 1}`,
      );
    });

    // --- CONDENSER WATER (CW) PIPING (AMBER ORANGE) ---
    // 1. Overhead CW Return Header (Chillers Condenser Side -> Cooling Towers top distribution)
    this.addPipeRun(
      [
        new THREE.Vector3(-4.0, 2.15, 0.15),
        new THREE.Vector3(1.6, 2.15, 0.15),
        new THREE.Vector3(1.6, 2.75, -3.15),
        new THREE.Vector3(-0.9, 2.75, -3.15),
        new THREE.Vector3(-0.9, 2.75, -3.65),
      ],
      0.12,
      cwPipeMat,
      this.layerGroups.cwPiping,
      cwFlowMat,
      0.15,
      6,
      0.75,
    );

    // Branch to Cooling Tower #2
    this.addPipeRun(
      [
        new THREE.Vector3(1.6, 2.75, -3.15),
        new THREE.Vector3(2.3, 2.75, -3.15),
        new THREE.Vector3(2.3, 2.75, -3.65),
      ],
      0.115,
      cwPipeMat,
      this.layerGroups.cwPiping,
      cwFlowMat,
      0.22,
      2,
      0.75,
    );

    // Vertical risers from each Chiller's Condenser barrel up to overhead CW header
    chillerXs.forEach((cx, idx) => {
      this.addPipeRun(
        [
          new THREE.Vector3(cx + 0.38, 0.92, 0.15),
          new THREE.Vector3(cx + 0.38, 2.15, 0.15),
        ],
        0.085,
        cwPipeMat,
        this.layerGroups.cwPiping,
        cwFlowMat,
        0.26,
        2,
        0.55,
      );

      this.addValve(
        new THREE.Vector3(cx + 0.38, 1.55, 0.15),
        'y',
        valveBodyMat,
        cwPipeMat,
        `valve-${idx + 4}`,
      );
    });

    // 2. Cooling Tower Cold Basin -> CW Pumps Suction Header -> Air Separator -> Chillers
    this.addPipeRun(
      [
        new THREE.Vector3(-0.9, 0.85, -3.45),
        new THREE.Vector3(2.3, 0.85, -3.45),
        new THREE.Vector3(4.5, 0.85, -3.45),
        new THREE.Vector3(8.5, 0.85, -3.45),
        new THREE.Vector3(8.5, 0.36, 0.55),
        new THREE.Vector3(5.2, 0.36, 0.55),
      ],
      0.115,
      cwPipeMat,
      this.layerGroups.cwPiping,
      cwFlowMat,
      0.13,
      7,
      0.25,
    );

    // CW Pump discharge manifold -> Air Separator -> Chiller Condensers
    this.addPipeRun(
      [
        new THREE.Vector3(8.2, 0.78, 1.15),
        new THREE.Vector3(5.4, 0.78, 1.15),
        new THREE.Vector3(4.45, 0.78, 1.15),
        new THREE.Vector3(3.25, 1.15, 0.45),
        new THREE.Vector3(1.6, 1.55, 0.45),
        new THREE.Vector3(-3.8, 1.55, 0.45),
      ],
      0.115,
      cwPipeMat,
      this.layerGroups.cwPiping,
      cwFlowMat,
      0.14,
      7,
      0.4,
    );
  }

  private buildSteelFrame(): void {
    const beamMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x334155,
        metalness: 0.8,
        roughness: 0.38,
      }),
    );

    const colGeo = this.track(new THREE.BoxGeometry(0.14, 3.1, 0.14));
    const colPositions = [
      [-5.2, -1.2],
      [-5.2, 2.8],
      [-1.0, -1.2],
      [-1.0, 2.8],
      [2.2, -1.2],
      [2.2, 2.8],
    ];
    colPositions.forEach(([x, z]) => {
      const col = new THREE.Mesh(colGeo, beamMat);
      col.position.set(x, 1.55, z);
      col.castShadow = true;
      this.layerGroups.steelFrame.add(col);
    });

    const longBeamGeo = this.track(new THREE.BoxGeometry(7.6, 0.16, 0.16));
    [-1.2, 2.8].forEach((z) => {
      const lb = new THREE.Mesh(longBeamGeo, beamMat);
      lb.position.set(-1.5, 3.02, z);
      this.layerGroups.steelFrame.add(lb);
    });

    const crossBeamGeo = this.track(new THREE.BoxGeometry(0.14, 0.16, 4.1));
    [-5.2, -1.0, 2.2].forEach((x) => {
      const cb = new THREE.Mesh(crossBeamGeo, beamMat);
      cb.position.set(x, 3.02, 0.8);
      this.layerGroups.steelFrame.add(cb);
    });
  }

  private setupLabelAnchors(): void {
    this.labelAnchors = [
      {
        id: 'lbl-towers',
        text: 'Cooling Towers',
        worldPos: new THREE.Vector3(0.7, 3.45, -4.65),
      },
      {
        id: 'lbl-building',
        text: 'To Building',
        worldPos: new THREE.Vector3(-7.4, 2.75, 3.35),
      },
      {
        id: 'lbl-airsep',
        text: 'Air Separator',
        worldPos: new THREE.Vector3(3.25, 2.45, 0.45),
      },
      {
        id: 'lbl-cond',
        text: 'Chillers (Condenser Side)',
        worldPos: new THREE.Vector3(-1.8, 2.45, 0.15),
      },
      {
        id: 'lbl-chwp',
        text: 'Chilled Water Pumps',
        worldPos: new THREE.Vector3(-1.6, 1.15, 4.4),
      },
      {
        id: 'lbl-cwp',
        text: 'Condenser Water Pumps',
        worldPos: new THREE.Vector3(6.8, 1.45, 1.2),
      },
    ];
  }

  private updateSelectionHighlight(meshKey: string): void {
    // Clear previous selection graphics
    while (this.selectionBoxHelper.children.length > 0) {
      const child = this.selectionBoxHelper.children[0];
      this.selectionBoxHelper.remove(child);
      if (child instanceof THREE.LineSegments || child instanceof THREE.LineLoop || child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (!Array.isArray(child.material)) child.material.dispose();
      }
    }

    const target = this.unitGroups.get(meshKey);
    if (!target) return;

    const box = new THREE.Box3().setFromObject(target);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    // Pad slightly for crisp CAD outline
    const pad = 0.16;
    const w = size.x + pad * 2;
    const h = size.y + pad;
    const d = size.z + pad * 2;

    // Glowing cyan floor footprint outline (matching Chiller #1 in the reference!)
    const floorPts = [
      new THREE.Vector3(center.x - w / 2, 0.02, center.z - d / 2),
      new THREE.Vector3(center.x + w / 2, 0.02, center.z - d / 2),
      new THREE.Vector3(center.x + w / 2, 0.02, center.z + d / 2),
      new THREE.Vector3(center.x - w / 2, 0.02, center.z + d / 2),
    ];
    const floorGeo = new THREE.BufferGeometry().setFromPoints(floorPts);
    const floorMat = new THREE.LineBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.95,
    });
    const floorLoop = new THREE.LineLoop(floorGeo, floorMat);
    this.selectionBoxHelper.add(floorLoop);

    // Subtle glowing floor tint under selected asset
    const padGeo = new THREE.PlaneGeometry(w, d);
    const padMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
    });
    const padMesh = new THREE.Mesh(padGeo, padMat);
    padMesh.rotation.x = -Math.PI / 2;
    padMesh.position.set(center.x, 0.015, center.z);
    this.selectionBoxHelper.add(padMesh);

    // Soft wireframe silhouette box around the selected equipment
    const boxGeo = new THREE.BoxGeometry(w, h, d);
    const edges = new THREE.EdgesGeometry(boxGeo);
    boxGeo.dispose();
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.42,
    });
    const wire = new THREE.LineSegments(edges, edgeMat);
    wire.position.set(center.x, box.min.y + h / 2, center.z);
    this.selectionBoxHelper.add(wire);
  }

  // Public API for React HUD
  public setSelectedMeshKey(meshKey: string): void {
    this.selectedMeshKey = meshKey;
    this.updateSelectionHighlight(meshKey);
  }

  public setLayers(layers: LayerState): void {
    (Object.keys(layers) as Array<keyof LayerState>).forEach((key) => {
      if (this.layerGroups[key]) {
        this.layerGroups[key].visible = layers[key];
      }
    });
  }

  public setRunning(running: boolean): void {
    this.isRunning = running;
  }

  public setSpeedMultiplier(speed: number): void {
    this.speedMultiplier = speed;
  }

  public setExplodeFactor(factor: number): void {
    this.targetExplode = THREE.MathUtils.clamp(factor, 1.0, 2.5);
  }

  public setShowLabels(show: boolean): void {
    this.showLabels = show;
    if (!show) {
      this.callbacks.onLabelsUpdate([]);
    }
  }

  public setAutoOrbit(enabled: boolean): void {
    this.autoOrbit = enabled;
    this.controls.autoRotate = enabled && !this.isSoftwareGl;
  }

  public setCameraPreset(preset: CameraPreset): void {
    this.cameraAnimating = true;
    this.desiredCamTarget.copy(DEFAULT_ISO_TARGET);

    if (preset === 'Iso') {
      this.desiredCamPos.copy(DEFAULT_ISO_POS);
    } else if (preset === 'Top') {
      this.desiredCamPos.set(1.2, 23.5, 0.8);
    } else if (preset === 'Front') {
      this.desiredCamPos.set(0.9, 5.2, 21.5);
    }
  }

  public resetView(): void {
    this.setAutoOrbit(false);
    this.setExplodeFactor(1.0);
    this.setCameraPreset('Iso');
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.pointerDownPos.set(e.clientX, e.clientY);
  };

  private onPointerUp = (e: PointerEvent): void => {
    const dx = e.clientX - this.pointerDownPos.x;
    const dy = e.clientY - this.pointerDownPos.y;
    if (Math.hypot(dx, dy) > 5) return; // Dragged camera, not a click

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.clickableTargets, true);
    if (hits.length > 0) {
      let obj: THREE.Object3D | null = hits[0].object;
      while (obj && !obj.userData.meshKey) {
        obj = obj.parent;
      }
      if (obj?.userData.meshKey) {
        this.setSelectedMeshKey(obj.userData.meshKey);
        this.callbacks.onSelectMeshKey(obj.userData.meshKey);
      }
    }
  };

  private onContextLost = (e: Event): void => {
    e.preventDefault();
  };

  private handleResize(): void {
    const w = Math.max(this.container.clientWidth, 1);
    const h = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private projectLabels(): void {
    if (!this.showLabels) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const explodeLift = (this.currentExplode - 1.0) * 0.65;

    const projected: ProjectedLabel[] = this.labelAnchors.map((anchor) => {
      _vec3.copy(anchor.worldPos);
      _vec3.y += explodeLift;
      _vec3.project(this.camera);

      const visible = _vec3.z < 1 && _vec3.z > -1;
      return {
        id: anchor.id,
        text: anchor.text,
        x: ((_vec3.x + 1) / 2) * w,
        y: ((-_vec3.y + 1) / 2) * h,
        visible,
      };
    });
    this.callbacks.onLabelsUpdate(projected);
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || typeof gl.fenceSync !== 'function') {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) return;
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private tick = (): void => {
    if (this.disposed) return;

    const rawDelta = Math.min(this.clock.getDelta(), 0.1);
    const elapsed = this.clock.getElapsedTime();

    // Smoothly damp explode factor
    if (Math.abs(this.currentExplode - this.targetExplode) > 0.0005) {
      this.currentExplode = THREE.MathUtils.damp(
        this.currentExplode,
        this.targetExplode,
        8,
        rawDelta,
      );
      const t = this.currentExplode - 1.0;
      for (let i = 0; i < this.explodableParts.length; i++) {
        const p = this.explodableParts[i];
        p.obj.position
          .copy(p.basePos)
          .addScaledVector(p.explodeOffset, t);
      }
      this.updateSelectionHighlight(this.selectedMeshKey);
    }

    // Smoothly damp camera presets
    if (this.cameraAnimating) {
      _camPosTarget.copy(this.desiredCamPos);
      _camTargetTarget.copy(this.desiredCamTarget);

      this.camera.position.x = THREE.MathUtils.damp(
        this.camera.position.x,
        _camPosTarget.x,
        6,
        rawDelta,
      );
      this.camera.position.y = THREE.MathUtils.damp(
        this.camera.position.y,
        _camPosTarget.y,
        6,
        rawDelta,
      );
      this.camera.position.z = THREE.MathUtils.damp(
        this.camera.position.z,
        _camPosTarget.z,
        6,
        rawDelta,
      );

      this.controls.target.x = THREE.MathUtils.damp(
        this.controls.target.x,
        _camTargetTarget.x,
        6,
        rawDelta,
      );
      this.controls.target.y = THREE.MathUtils.damp(
        this.controls.target.y,
        _camTargetTarget.y,
        6,
        rawDelta,
      );
      this.controls.target.z = THREE.MathUtils.damp(
        this.controls.target.z,
        _camTargetTarget.z,
        6,
        rawDelta,
      );

      if (this.camera.position.distanceTo(_camPosTarget) < 0.05) {
        this.cameraAnimating = false;
      }
    }

    // Animate cooling tower fans & pipe flow indicators when running
    if (this.isRunning) {
      const simDelta = rawDelta * Math.min(this.speedMultiplier, 12);
      for (let i = 0; i < this.fanRotors.length; i++) {
        this.fanRotors[i].rotation.y += simDelta * 4.5;
      }

      const flowTime = elapsed * (0.55 + Math.log10(this.speedMultiplier) * 1.15);
      for (let i = 0; i < this.flowPaths.length; i++) {
        const fp = this.flowPaths[i];
        const count = fp.meshes.length;
        for (let j = 0; j < count; j++) {
          const u = (flowTime * fp.speed + j / count) % 1;
          fp.curve.getPointAt(u, _vec3);
          fp.curve.getTangentAt(u, _tangent);
          const m = fp.meshes[j];
          m.position.copy(_vec3);
          _quat.setFromUnitVectors(_up, _tangent);
          m.quaternion.copy(_quat);
        }
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.projectLabels();

    // Update FPS readout every 0.5s
    this.fpsFrames++;
    this.fpsElapsed += rawDelta;
    if (this.fpsElapsed >= 0.5) {
      const fps = Math.max(1, Math.round(this.fpsFrames / this.fpsElapsed));
      this.callbacks.onFpsUpdate(fps);
      this.fpsFrames = 0;
      this.fpsElapsed = 0;
    }

    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.frameId = requestAnimationFrame(this.tick);
    }
  };

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener(
      'pointerdown',
      this.onPointerDown,
    );
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.removeEventListener(
      'webglcontextlost',
      this.onContextLost,
    );
    this.controls.dispose();
    this.envRenderTarget.dispose();
    this.pmremGenerator.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
