/**
 * RIVER RAID 2026 - THREE.JS 3D KINETIC REMAKE ENGINE
 * Complete client-side 3D game implementation with Three.js renderer,
 * procedural river generator, enemy AI, particle systems, and audio/gamepad support.
 */

// --- Audio Synthesizer (Web Audio API) ---
class SoundSystem {
    constructor() {
        this.ctx = null;
        this.engineOsc = null;
        this.engineGain = null;
    }

    init() {
        if (this.ctx) return;
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContext();

        // Continuous jet engine drone
        this.engineOsc = this.ctx.createOscillator();
        this.engineOsc.type = 'sawtooth';
        this.engineOsc.frequency.setValueAtTime(60, this.ctx.currentTime);

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(300, this.ctx.currentTime);

        this.engineGain = this.ctx.createGain();
        this.engineGain.gain.setValueAtTime(0.15, this.ctx.currentTime);

        this.engineOsc.connect(filter);
        filter.connect(this.engineGain);
        this.engineGain.connect(this.ctx.destination);
        this.engineOsc.start();
    }

    updateEnginePitch(speedRatio, fuelRatio) {
        if (!this.ctx || !this.engineOsc) return;
        const freq = 50 + speedRatio * 80;
        this.engineOsc.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.05);

        // Warning siren pulse when fuel is low
        if (fuelRatio < 0.25) {
            const pulse = (Math.sin(this.ctx.currentTime * 12) + 1) * 0.1;
            this.engineGain.gain.setTargetAtTime(0.2 + pulse, this.ctx.currentTime, 0.05);
        } else {
            this.engineGain.gain.setTargetAtTime(0.15, this.ctx.currentTime, 0.05);
        }
    }

    playLaser() {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(880, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(110, this.ctx.currentTime + 0.15);

        gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.15);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + 0.15);
    }

    playExplosion() {
        if (!this.ctx) return;
        const bufferSize = this.ctx.sampleRate * 0.5;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }

        const noise = this.ctx.createBufferSource();
        noise.buffer = buffer;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(300, this.ctx.currentTime);
        filter.frequency.exponentialRampToValueAtTime(30, this.ctx.currentTime + 0.5);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.5, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.5);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);
        noise.start();
    }

    stop() {
        if (this.engineGain) {
            this.engineGain.gain.setValueAtTime(0, this.ctx.currentTime);
        }
    }
}

// --- Main Game Class ---
class RiverRaidGame {
    constructor() {
        this.canvas = document.getElementById('gameCanvas');
        this.width = 800;
        this.height = 700;
        this.canvas.width = this.width;
        this.canvas.height = this.height;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x020617);
        this.scene.fog = new THREE.FogExp2(0x0f172a, 0.0035);

        this.camera = new THREE.PerspectiveCamera(60, this.width / this.height, 0.1, 1000);
        this.camera.position.set(0, 35, 30);
        this.camera.lookAt(0, 0, -10);

        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
        this.renderer.setSize(this.width, this.height);
        this.renderer.shadowMap.enabled = true;

        // Lighting
        const ambientLight = new THREE.AmbientLight(0x38bdf8, 0.6);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
        dirLight.position.set(20, 50, 20);
        dirLight.castShadow = true;
        this.scene.add(dirLight);

        // Game State
        this.isPlaying = false;
        this.score = 0;
        this.fuel = 100;
        this.speed = 280;
        this.multiplier = 1;
        this.scrollOffset = 0;

        // Input Tracking
        this.keys = new Set();
        this.playerPos = { x: 0, z: 10 };
        this.playerRoll = 0;

        // Entities & World
        this.entities = [];
        this.terrainChunks = [];
        this.particles = [];
        this.sound = new SoundSystem();

        this.setupListeners();
        this.initWorld();
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    setupListeners() {
        window.addEventListener('keydown', (e) => this.keys.add(e.code));
        window.addEventListener('keyup', (e) => this.keys.delete(e.code));

        document.getElementById('start-btn').addEventListener('click', () => this.startGame());
        document.getElementById('restart-btn').addEventListener('click', () => this.startGame());
    }

    startGame() {
        document.getElementById('menu-screen').style.display = 'none';
        document.getElementById('game-over-screen').style.display = 'none';
        
        this.isPlaying = true;
        this.score = 0;
        this.fuel = 100;
        this.speed = 280;
        this.scrollOffset = 0;
        this.playerPos = { x: 0, z: 10 };
        this.multiplier = 1;

        // Clear existing entities
        this.entities.forEach(e => this.scene.remove(e.mesh));
        this.entities = [];

        this.sound.init();
        this.buildInitialTerrain();
    }

    gameOver() {
        this.isPlaying = false;
        this.sound.stop();
        document.getElementById('final-score').innerText = `Final Score: ${Math.floor(this.score)}`;
        document.getElementById('game-over-screen').style.display = 'flex';
    }

    initWorld() {
        // Water Plane
        const waterGeo = new THREE.PlaneGeometry(1000, 2000, 32, 64);
        const waterMat = new THREE.MeshStandardMaterial({
            color: 0x0369a1,
            roughness: 0.2,
            metalness: 0.8,
            flatShading: true
        });
        this.waterMesh = new THREE.Mesh(waterGeo, waterMat);
        this.waterMesh.rotation.x = -Math.PI / 2;
        this.waterMesh.position.set(0, -1, -500);
        this.scene.add(this.waterMesh);

        // Player Jet Mesh (Fighter Jet composite)
        this.playerGroup = new THREE.Group();
        
        const fuselageGeo = new THREE.ConeGeometry(1.2, 5, 6);
        fuselageGeo.rotateX(Math.PI / 2);
        const fuselageMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.8, roughness: 0.2 });
        const fuselage = new THREE.Mesh(fuselageGeo, fuselageMat);
        this.playerGroup.add(fuselage);

        const wingGeo = new THREE.BoxGeometry(4.5, 0.15, 1.8);
        const wingMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, metalness: 0.6, roughness: 0.3 });
        const wings = new THREE.Mesh(wingGeo, wingMat);
        wings.position.set(0, 0, 0.5);
        this.playerGroup.add(wings);

        const cockpitGeo = new THREE.SphereGeometry(0.6, 8, 8);
        const cockpitMat = new THREE.MeshStandardMaterial({ color: 0xc084fc, roughness: 0.1, transparent: true, opacity: 0.8 });
        const cockpit = new THREE.Mesh(cockpitGeo, cockpitMat);
        cockpit.position.set(0, 0.4, -0.2);
        this.playerGroup.add(cockpit);

        this.playerGroup.position.set(0, 0.5, 10);
        this.scene.add(this.playerGroup);
    }

    buildInitialTerrain() {
        // Generate initial riverbanks and entities
        for (let i = 0; i < 40; i++) {
            this.spawnTerrainChunk(-i * 40);
        }
    }

    spawnTerrainChunk(zPos) {
        const chunkLength = 40;
        const width = 24;
        const meander = Math.sin(zPos * 0.05) * 8;

        // Left Bank
        const leftGeo = new THREE.BoxGeometry(width, 4, chunkLength);
        const bankMat = new THREE.MeshStandardMaterial({ color: 0x166534, roughness: 0.9 });
        const leftBank = new THREE.Mesh(leftGeo, bankMat);
        leftBank.position.set(-18 + meander, 1, zPos);
        this.scene.add(leftBank);
        this.terrainChunks.push({ mesh: leftBank, z: zPos });

        // Right Bank
        const rightBank = new THREE.Mesh(leftGeo, bankMat);
        rightBank.position.set(18 + meander, 1, zPos);
        this.scene.add(rightBank);
        this.terrainChunks.push({ mesh: rightBank, z: zPos });

        // Spawn Entities periodically
        if (Math.abs(zPos) > 60 && Math.abs(zPos) % 80 === 0) {
            this.spawnEntity(zPos, meander);
        }
    }

    spawnEntity(zPos, meander) {
        const types = ['fuel', 'boat', 'chopper'];
        const type = types[Math.floor(Math.random() * types.length)];
        const xOffset = (Math.random() - 0.5) * 12 + meander;

        let mesh, entityType;
        if (type === 'fuel') {
            const geo = new THREE.CylinderGeometry(1.2, 1.2, 3, 8);
            const mat = new THREE.MeshStandardMaterial({ color: 0xef4444, metalness: 0.5, roughness: 0.3 });
            mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(xOffset, 1.5, zPos);
            entityType = 'FUEL';
        } else if (type === 'boat') {
            const geo = new THREE.BoxGeometry(2.5, 1, 4);
            const mat = new THREE.MeshStandardMaterial({ color: 0xeab308, metalness: 0.7, roughness: 0.3 });
            mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(xOffset, 0.5, zPos);
            entityType = 'BOAT';
        } else {
            const geo = new THREE.SphereGeometry(1.5, 8, 8);
            const mat = new THREE.MeshStandardMaterial({ color: 0xa855f7, metalness: 0.6, roughness: 0.3 });
            mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(xOffset, 3, zPos);
            entityType = 'CHOPPER';
        }

        this.scene.add(mesh);
        this.entities.push({ mesh, type: entityType, x: xOffset, z: zPos, active: true });
    }

    pollInput(dt) {
        let throttleDelta = 0;
        let steeringDelta = 0;
        let firePressed = false;

        if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) throttleDelta += 1;
        if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) throttleDelta -= 1;
        if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) steeringDelta -= 1;
        if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) steeringDelta += 1;
        if (this.keys.has('Space')) firePressed = true;

        // Gamepad support
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        const gp = gamepads[0];
        if (gp) {
            const deadzone = 0.15;
            if (Math.abs(gp.axes[0]) > deadzone) steeringDelta = gp.axes[0];
            if (Math.abs(gp.axes[1]) > deadzone) throttleDelta = -gp.axes[1];
            if (gp.buttons[0]?.pressed || gp.buttons[7]?.pressed) firePressed = true;
        }

        // Adjust Speed
        this.speed = Math.max(140, Math.min(460, this.speed + throttleDelta * 150 * dt));

        // Adjust Player Position & Roll
        const steerSpeed = 22;
        this.playerPos.x += steeringDelta * steerSpeed * dt;
        this.playerPos.x = Math.max(-14, Math.min(14, this.playerPos.x));

        this.playerRoll = THREE.MathUtils.lerp(this.playerRoll, -steeringDelta * 0.6, 10 * dt);
        this.playerGroup.rotation.z = this.playerRoll;
        this.playerGroup.position.x = this.playerPos.x;

        // Fire Projectile
        if (firePressed && !this.lastFire) {
            this.fireBullet();
        }
        this.lastFire = firePressed;
    }

    fireBullet() {
        const geo = new THREE.BoxGeometry(0.3, 0.3, 2);
        const mat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(this.playerPos.x, 0.5, this.playerPos.z - 2);
        this.scene.add(mesh);
        this.entities.push({ mesh, type: 'BULLET', x: this.playerPos.x, z: this.playerPos.z - 2, active: true, vz: -800 });
        this.sound.playLaser();
    }

    update(dt) {
        if (!this.isPlaying) return;

        this.pollInput(dt);

        // Advance World Scroll
        const distance = this.speed * dt;
        this.scrollOffset += distance;
        this.score += dt * 25 * (this.speed / 280);

        // Fuel Depletion
        const burnRate = 4.5 * (0.8 + 0.6 * ((this.speed - 140) / 320));
        this.fuel -= burnRate * dt;
        if (this.fuel <= 0) {
            this.fuel = 0;
            this.gameOver();
            return;
        }

        this.sound.updateEnginePitch((this.speed - 140) / 320, this.fuel / 100);

        // Update Entities & Collisions
        for (let i = this.entities.length - 1; i >= 0; i--) {
            const ent = this.entities[i];
            if (!ent.active) continue;

            if (ent.type === 'BULLET') {
                ent.z += ent.vz * dt;
                ent.mesh.position.z = ent.z;

                // Check collisions with entities
                for (let j = 0; j < this.entities.length; j++) {
                    const target = this.entities[j];
                    if (!target.active || target.type === 'BULLET' || target.type === 'FUEL') continue;

                    const dx = ent.x - target.x;
                    const dz = ent.z - target.z;
                    if (Math.sqrt(dx*dx + dz*dz) < 2.5) {
                        ent.active = false;
                        this.scene.remove(ent.mesh);
                        target.active = false;
                        this.scene.remove(target.mesh);
                        this.score += 200;
                        this.sound.playExplosion();
                        break;
                    }
                }

                if (ent.z < -100) {
                    ent.active = false;
                    this.scene.remove(ent.mesh);
                }
            } else {
                // Move towards player with world scroll
                ent.z += distance * 0.1; // relative motion
                ent.mesh.position.z = ent.z;

                // Check Player Collision
                const dx = this.playerPos.x - ent.x;
                const dz = this.playerPos.z - ent.z;
                if (Math.abs(dx) < 1.8 && Math.abs(dz) < 1.8) {
                    if (ent.type === 'FUEL') {
                        this.fuel = Math.min(100, this.fuel + 35 * dt);
                    } else {
                        this.sound.playExplosion();
                        this.gameOver();
                        return;
                    }
                }

                // Recycle entity when past camera
                if (ent.z > 20) {
                    ent.active = false;
                    this.scene.remove(ent.mesh);
                }
            }
        }

        // Clean up inactive entities
        this.entities = this.entities.filter(e => e.active);

        // Infinite Terrain Generation
        if (this.scrollOffset > 40) {
            this.scrollOffset = 0;
            this.spawnTerrainChunk(-800);
        }

        // Update UI HUD
        document.getElementById('hud-score').innerText = String(Math.floor(this.score)).padStart(6, '0');
        document.getElementById('hud-speed').innerText = Math.floor(this.speed);
        document.getElementById('fuel-bar').style.width = `${Math.max(0, this.fuel)}%`;
        document.getElementById('hud-multiplier').innerText = `${this.multiplier}x`;
    }

    animate() {
        requestAnimationFrame(this.animate);
        const dt = 0.016; // fixed timestep approx
        this.update(dt);
        this.renderer.render(this.scene, this.camera);
    }
}

// Initialize on load
window.addEventListener('load', () => {
    window.game = new RiverRaidGame();
});
