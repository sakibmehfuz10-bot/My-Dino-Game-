
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useEffect, useRef, useState } from 'react';

// --- TYPES & INTERFACES ---

interface ExtendedWindow extends Window {
    webkitAudioContext?: typeof AudioContext;
}

interface VisionState {
    handLandmarker: any;
    lastVideoTime: number;
    results: any;
    prevY: number;
    prevTime: number;
    smoothedVelocity: number;
    peakVelocity: number;
    JUMP_VELOCITY_THRESHOLD: number;
    lastPredictionTime: number;
    lastJumpTime: number;
}

interface GameEngineState {
    gameRunning: boolean;
    canRestart: boolean;
    score: number;
    highScore: number;
    gameSpeed: number;
    lastTime: number;
    obstaclePool: (Cactus | Bird)[];
    groundPool: GroundDetail[];
    cloudPool: Cloud[];
    spawnTimer: number;
    groundSpawnTimer: number;
    cloudSpawnTimer: number;
    animationId: number;
    visionAnimationId: number;
    dino: DinoEntity;
    hasStarted: boolean;
    cameraReady: boolean;
    isNight: boolean;
}

interface DinoEntity {
    x: number;
    y: number;
    width: number;
    height: number;
    dy: number;
    grounded: boolean;
    isDucking: boolean;
    isCrashed: boolean;
    jumpTimer: number;
    legState: boolean;
    animTimer: number;
    jump: () => boolean;
    duck: (active: boolean) => void;
    update: (dt: number, speed: number, onStep?: () => void) => void;
    draw: (ctx: CanvasRenderingContext2D, color: string, bgColor: string) => void;
    reset: () => void;
}

// --- CONSTANTS ---

const GAME_CONFIG = {
    CANVAS_WIDTH: 1000,
    CANVAS_HEIGHT: 350, 
    GROUND_Y: 300,
    GRAVITY: 3800, // Adjusted for slightly more "floaty but snappy" feel
    JUMP_FORCE: 1100,
    INITIAL_SPEED: 500,
    MAX_SPEED: 3000,
    CONTINUOUS_GROWTH: 0.12,
    TIER_INCREMENT: 60,
    TIER_SCORE_GAP: 1000,
    DINO_START_X: 100,
    DINO_GROUND_Y: 255, 
    VISION_FPS: 30,
    JUMP_COOLDOWN_MS: 150,
    COLORS: {
        DAY_BG: '#f7f7f7',
        DAY_FG: '#535353',
        NIGHT_BG: '#202124',
        NIGHT_FG: '#bdc1c6',
        ACCENT: '#ff5252'
    }
};

// --- AUDIO SYNTHESIS ---

const SoundSynth = {
    ctx: null as AudioContext | null,
    bufferCache: {} as Record<string, AudioBuffer>,
    
    init() {
        if (!this.ctx) {
            const Win = window as ExtendedWindow;
            this.ctx = new (window.AudioContext || Win.webkitAudioContext)();
        }
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }

        if (this.ctx && !this.bufferCache['step']) {
            this.bufferCache['step'] = this.createNoiseBuffer(0.03);
        }
        if (this.ctx && !this.bufferCache['roar']) {
            this.bufferCache['roar'] = this.createNoiseBuffer(0.5);
        }
    },

    createNoiseBuffer(duration: number): AudioBuffer {
        const ctx = this.ctx!;
        const bufferSize = ctx.sampleRate * duration;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        return buffer;
    },

    playJump() {
        const ctx = this.ctx;
        if (!ctx) return;
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'square';
        osc.frequency.setValueAtTime(200, t);
        osc.frequency.exponentialRampToValueAtTime(800, t + 0.08);
        gain.gain.setValueAtTime(0.08, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.08);
        osc.start(t);
        osc.stop(t + 0.08);
    },

    playStep() {
        const ctx = this.ctx;
        if (!ctx || !this.bufferCache['step']) return;
        const t = ctx.currentTime;
        const noise = ctx.createBufferSource();
        noise.buffer = this.bufferCache['step'];
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(800, t);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.04, t); 
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
        noise.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        noise.start(t);
    },

    playScore() {
        const ctx = this.ctx;
        if (!ctx) return;
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'square';
        osc.frequency.setValueAtTime(880, t);
        osc.frequency.setValueAtTime(1046.5, t + 0.1);
        gain.gain.setValueAtTime(0.05, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        osc.start(t);
        osc.stop(t + 0.3);
    },

    playRoar() {
        const ctx = this.ctx;
        if (!ctx || !this.bufferCache['roar']) return;
        const t = ctx.currentTime;
        const noise = ctx.createBufferSource();
        noise.buffer = this.bufferCache['roar'];
        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.1, t);
        noiseGain.gain.linearRampToValueAtTime(0, t + 0.5);
        noise.connect(noiseGain);
        noiseGain.connect(ctx.destination);
        noise.start(t);
    }
};

// --- GAME ENTITIES ---

class Cloud {
    active: boolean = false;
    x: number = 0;
    y: number = 0;
    speedFactor: number = 0.2;

    spawn(startX: number) {
        this.x = startX;
        this.y = 40 + Math.random() * 60;
        this.speedFactor = 0.1 + Math.random() * 0.15;
        this.active = true;
    }

    update(dt: number, speed: number) {
        if (!this.active) return;
        this.x -= speed * this.speedFactor * dt;
        if (this.x < -120) this.active = false;
    }

    draw(ctx: CanvasRenderingContext2D, color: string) {
        if (!this.active) return;
        ctx.fillStyle = color;
        const ix = Math.floor(this.x);
        const iy = Math.floor(this.y);
        ctx.fillRect(ix + 16, iy, 16, 4);
        ctx.fillRect(ix + 12, iy + 4, 36, 4);
        ctx.fillRect(ix + 8, iy + 8, 44, 4);
        ctx.fillRect(ix + 4, iy + 12, 52, 4);
        ctx.fillRect(ix, iy + 16, 60, 4);
        ctx.fillRect(ix, iy + 20, 36, 4);
    }
}

class GroundDetail {
    active: boolean = false;
    x: number = 0;
    y: number = 0;
    width: number = 0;
    height: number = 2;

    spawn(startX: number) {
        this.x = startX;
        this.y = GAME_CONFIG.GROUND_Y + 4 + Math.random() * 20;
        this.width = Math.random() > 0.5 ? 2 : 4;
        this.active = true;
    }

    update(dt: number, speed: number) {
        if (!this.active) return;
        this.x -= speed * dt;
        if (this.x < -this.width) this.active = false;
    }

    draw(ctx: CanvasRenderingContext2D, color: string) {
        if (!this.active) return;
        ctx.fillStyle = color;
        ctx.fillRect(Math.floor(this.x), Math.floor(this.y), this.width, this.height);
    }
}

class Cactus {
    type: 'obstacle' = 'obstacle';
    active: boolean = false;
    x: number = 0;
    y: number = 0;
    width: number = 0;
    height: number = 0;
    variation: number = 0;

    spawn(startX: number) {
        this.x = startX;
        const r = Math.random();
        if (r < 0.6) {
            this.variation = Math.floor(Math.random() * 3);
            this.width = 17 + (this.variation * 17);
            this.height = 35;
        } else {
            this.variation = 3 + Math.floor(Math.random() * 2);
            this.width = 25 + (this.variation === 4 ? 25 : 0);
            this.height = 50;
        }
        this.y = GAME_CONFIG.GROUND_Y - this.height;
        this.active = true;
    }

    update(dt: number, speed: number) {
        if (!this.active) return;
        this.x -= speed * dt;
        if (this.x < -this.width) this.active = false;
    }

    draw(ctx: CanvasRenderingContext2D, color: string) {
        if (!this.active) return;
        ctx.fillStyle = color;
        const ix = Math.floor(this.x);
        const iy = Math.floor(this.y);
        
        const drawCactusUnit = (x: number, y: number, h: number, w: number) => {
            ctx.fillRect(x + w * 0.35, y, w * 0.3, h);
            ctx.fillRect(x, y + h * 0.3, w * 0.3, h * 0.1);
            ctx.fillRect(x, y + h * 0.15, w * 0.1, h * 0.2);
            ctx.fillRect(x + w * 0.6, y + h * 0.4, w * 0.4, h * 0.1);
            ctx.fillRect(x + w * 0.9, y + h * 0.25, w * 0.1, h * 0.2);
        };

        if (this.variation < 3) {
            const unitW = 17;
            for (let i = 0; i <= this.variation; i++) {
                drawCactusUnit(ix + i * unitW, iy, 35, unitW);
            }
        } else {
            const unitW = 25;
            const count = this.variation === 4 ? 2 : 1;
            for (let i = 0; i < count; i++) {
                drawCactusUnit(ix + i * unitW, iy, 50, unitW);
            }
        }
    }
}

class Bird {
    type: 'obstacle' = 'obstacle';
    active: boolean = false;
    x: number = 0;
    y: number = 0;
    width: number = 46;
    height: number = 40;
    animTimer: number = 0;
    wingState: boolean = false;

    spawn(startX: number) {
        this.x = startX;
        const levels = [GAME_CONFIG.GROUND_Y - 40, GAME_CONFIG.GROUND_Y - 75, GAME_CONFIG.GROUND_Y - 110];
        this.y = levels[Math.floor(Math.random() * levels.length)];
        this.active = true;
    }

    update(dt: number, speed: number) {
        if (!this.active) return;
        this.x -= (speed * 1.1) * dt;
        this.animTimer += dt;
        if (this.animTimer > 0.18) {
            this.wingState = !this.wingState;
            this.animTimer = 0;
        }
        if (this.x < -this.width) this.active = false;
    }

    draw(ctx: CanvasRenderingContext2D, color: string) {
        if (!this.active) return;
        ctx.fillStyle = color;
        const ix = Math.floor(this.x);
        const iy = Math.floor(this.y);
        ctx.fillRect(ix + 12, iy + 14, 22, 10);
        ctx.fillRect(ix, iy + 14, 12, 6);
        if (this.wingState) {
            ctx.fillRect(ix + 14, iy, 14, 14);
            ctx.fillRect(ix + 18, iy - 4, 6, 4);
        } else {
            ctx.fillRect(ix + 14, iy + 24, 14, 14);
            ctx.fillRect(ix + 18, iy + 38, 6, 4);
        }
    }
}

const createDino = (): DinoEntity => ({
    x: GAME_CONFIG.DINO_START_X,
    y: GAME_CONFIG.DINO_GROUND_Y,
    width: 44,
    height: 47,
    dy: 0,
    grounded: false,
    isDucking: false,
    isCrashed: false,
    jumpTimer: 0,
    legState: false,
    animTimer: 0,
    
    reset() {
        this.y = GAME_CONFIG.DINO_GROUND_Y;
        this.dy = 0;
        this.grounded = true;
        this.isDucking = false;
        this.isCrashed = false;
        this.jumpTimer = 0;
        this.legState = false;
        this.animTimer = 0;
    },

    draw(ctx: CanvasRenderingContext2D, color: string, bgColor: string) {
        const ix = Math.floor(this.x);
        const iy = Math.floor(this.y);
        ctx.fillStyle = color;

        if (this.isDucking && this.grounded) {
            ctx.fillRect(ix, iy + 18, 40, 25);
            ctx.fillRect(ix + 40, iy + 18, 19, 16);
            ctx.fillRect(ix + 54, iy + 18, 5, 8);
            ctx.fillStyle = bgColor;
            ctx.fillRect(ix + 46, iy + 22, 4, 4);
            ctx.fillStyle = color;
            // DUCK RUN LEGS
            if (this.legState) {
                ctx.fillRect(ix + 10, iy + 43, 10, 4);
            } else {
                ctx.fillRect(ix + 30, iy + 43, 10, 4);
            }
        } else {
            // MAIN BODY
            ctx.fillRect(ix + 22, iy, 22, 18);
            ctx.fillRect(ix + 38, iy + 4, 6, 10);
            ctx.fillStyle = bgColor;
            if (this.isCrashed) {
                ctx.fillRect(ix + 28, iy + 4, 6, 2);
                ctx.fillRect(ix + 30, iy + 2, 2, 6);
            } else {
                ctx.fillRect(ix + 28, iy + 4, 4, 4);
            }
            ctx.fillStyle = color;
            ctx.fillRect(ix + 14, iy + 18, 16, 22);
            ctx.fillRect(ix, iy + 18, 14, 14);
            ctx.fillRect(ix, iy + 22, 6, 14);
            ctx.fillRect(ix + 30, iy + 22, 6, 4);
            ctx.fillRect(ix + 34, iy + 22, 2, 8);
            
            // LEGS
            if (!this.grounded) {
                // Neutral leg pose in air
                ctx.fillRect(ix + 14, iy + 40, 8, 7);
                ctx.fillRect(ix + 24, iy + 40, 8, 7);
            } else if (this.legState) {
                // Front leg up, back leg down
                ctx.fillRect(ix + 14, iy + 40, 8, 7);
                ctx.fillRect(ix + 24, iy + 40, 8, 3);
            } else {
                // Front leg down, back leg up
                ctx.fillRect(ix + 14, iy + 40, 8, 3);
                ctx.fillRect(ix + 24, iy + 40, 8, 7);
            }
        }
    },

    jump() {
        if (this.grounded && !this.isDucking) {
            this.dy = -GAME_CONFIG.JUMP_FORCE;
            this.grounded = false;
            this.jumpTimer = 0.2;
            return true;
        }
        return false;
    },

    duck(active: boolean) {
        if (this.grounded) {
            this.isDucking = active;
        }
    },

    update(dt: number, speed: number, onStep?: () => void) {
        if (this.isCrashed) return;
        
        if (this.jumpTimer > 0) this.jumpTimer -= dt;

        if (this.grounded) {
            // Scale animation frequency with game speed for realism
            this.animTimer += dt * (speed / GAME_CONFIG.INITIAL_SPEED);
            const baseAnimLimit = this.isDucking ? 0.06 : 0.08;
            if (this.animTimer > baseAnimLimit) {
                this.legState = !this.legState;
                this.animTimer = 0;
                if (onStep) onStep();
            }
        } else {
            // Legs stay neutral in the air
            this.legState = false;
            this.animTimer = 0;
        }

        this.dy += GAME_CONFIG.GRAVITY * dt;
        this.y += this.dy * dt;

        if (this.y > GAME_CONFIG.DINO_GROUND_Y) {
            this.y = GAME_CONFIG.DINO_GROUND_Y;
            this.dy = 0;
            this.grounded = true;
        } else {
            this.grounded = false;
        }
    }
});

const DinoGame: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const outputCanvasRef = useRef<HTMLCanvasElement>(null);
    const jumpSignalRef = useRef<HTMLDivElement>(null);
    const gameWrapperRef = useRef<HTMLDivElement>(null);
    
    const [isLoading, setIsLoading] = useState(true);
    const [showVision, setShowVision] = useState(false);
    const [gameRunning, setGameRunning] = useState(false);
    const [canRestart, setCanRestart] = useState(false);
    const [hasStarted, setHasStarted] = useState(false);
    const [cameraReady, setCameraReady] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [uiScore, setUiScore] = useState(0); 
    const [highScore, setHighScore] = useState(0);
    const [isFullscreen, setIsFullscreen] = useState(false);

    const engineRef = useRef<GameEngineState>({
        gameRunning: false,
        canRestart: false,
        score: 0,
        highScore: 0,
        gameSpeed: GAME_CONFIG.INITIAL_SPEED,
        lastTime: 0,
        obstaclePool: [],
        groundPool: Array.from({ length: 50 }, () => new GroundDetail()),
        cloudPool: Array.from({ length: 8 }, () => new Cloud()),
        spawnTimer: 0,
        groundSpawnTimer: 0,
        cloudSpawnTimer: 0,
        animationId: 0,
        visionAnimationId: 0,
        dino: createDino(),
        hasStarted: false,
        cameraReady: false,
        isNight: false
    });

    const visionRef = useRef<VisionState>({
        handLandmarker: null,
        lastVideoTime: -1,
        results: undefined,
        prevY: 0,
        prevTime: 0,
        smoothedVelocity: 0,
        peakVelocity: 0,
        JUMP_VELOCITY_THRESHOLD: 1.6,
        lastPredictionTime: 0,
        lastJumpTime: 0
    });

    const getFromPool = <T extends { active: boolean }>(pool: T[], factory: () => T): T => {
        const item = pool.find(p => !p.active);
        if (item) return item;
        const newItem = factory();
        pool.push(newItem);
        return newItem;
    };

    const spawnObstacle = (dt: number) => {
        const engine = engineRef.current;
        engine.spawnTimer -= dt;
        if (engine.spawnTimer <= 0) {
            const r = Math.random();
            const canSpawnBird = engine.score > 600;
            if (canSpawnBird && r > 0.75) {
                const bird = getFromPool(engine.obstaclePool as Bird[], () => new Bird());
                bird.spawn(GAME_CONFIG.CANVAS_WIDTH);
            } else {
                const cactus = getFromPool(engine.obstaclePool as Cactus[], () => new Cactus());
                cactus.spawn(GAME_CONFIG.CANVAS_WIDTH);
            }
            const speedScale = GAME_CONFIG.INITIAL_SPEED / engine.gameSpeed;
            engine.spawnTimer = (0.7 + Math.random() * 0.9) * Math.max(speedScale, 0.4); 
        }
    };

    const runGameLoop = (timestamp: number) => {
        const engine = engineRef.current;
        if (!engine.gameRunning) return;
        
        if (!engine.lastTime) engine.lastTime = timestamp;
        const dt = Math.min((timestamp - engine.lastTime) / 1000, 0.05); 
        engine.lastTime = timestamp;

        const canvas = canvasRef.current!;
        const ctx = canvas.getContext('2d', { alpha: false })!;
        engine.isNight = (Math.floor(engine.score / 1500) % 2 === 1); 
        const bgColor = engine.isNight ? GAME_CONFIG.COLORS.NIGHT_BG : GAME_CONFIG.COLORS.DAY_BG;
        const fgColor = engine.isNight ? GAME_CONFIG.COLORS.NIGHT_FG : GAME_CONFIG.COLORS.DAY_FG;

        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        engine.cloudSpawnTimer -= dt;
        if (engine.cloudSpawnTimer <= 0) {
            getFromPool(engine.cloudPool, () => new Cloud()).spawn(GAME_CONFIG.CANVAS_WIDTH);
            engine.cloudSpawnTimer = 4.0 + Math.random() * 6.0;
        }
        for (const cloud of engine.cloudPool) if (cloud.active) { cloud.update(dt, engine.gameSpeed); cloud.draw(ctx, fgColor); }

        ctx.strokeStyle = fgColor;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, GAME_CONFIG.GROUND_Y); ctx.lineTo(canvas.width, GAME_CONFIG.GROUND_Y); ctx.stroke();

        const currentTier = Math.floor(engine.score / GAME_CONFIG.TIER_SCORE_GAP);
        const tierBonus = currentTier * GAME_CONFIG.TIER_INCREMENT;
        engine.gameSpeed = Math.min(
            GAME_CONFIG.INITIAL_SPEED + (engine.score * GAME_CONFIG.CONTINUOUS_GROWTH) + tierBonus, 
            GAME_CONFIG.MAX_SPEED
        );

        engine.groundSpawnTimer -= dt;
        if (engine.groundSpawnTimer <= 0) {
            getFromPool(engine.groundPool, () => new GroundDetail()).spawn(GAME_CONFIG.CANVAS_WIDTH);
            engine.groundSpawnTimer = 0.04 + Math.random() * 0.1; 
        }
        for (const detail of engine.groundPool) if (detail.active) { detail.update(dt, engine.gameSpeed); detail.draw(ctx, fgColor); }

        // Scaling animation by speed passed to dino update
        engine.dino.update(dt, engine.gameSpeed, () => { if (!isMuted) SoundSynth.playStep(); });
        engine.dino.draw(ctx, fgColor, bgColor);

        spawnObstacle(dt);
        const dino = engine.dino;
        for (const obs of engine.obstaclePool) if (obs.active) {
            obs.update(dt, engine.gameSpeed); obs.draw(ctx, fgColor);
            const dw = dino.isDucking ? 60 : dino.width;
            const dh = dino.isDucking ? 30 : dino.height;
            const dy = dino.isDucking ? dino.y + 17 : dino.y;
            
            if (dino.x + 16 < obs.x + obs.width - 16 && dino.x + dw - 16 > obs.x + 16 && dy + 12 < obs.y + obs.height - 12 && dy + dh - 12 > obs.y + 12) {
                engine.gameRunning = false; engine.canRestart = false; engine.dino.isCrashed = true;
                if (engine.score > engine.highScore) { engine.highScore = engine.score; setHighScore(Math.floor(engine.highScore/10)); }
                setGameRunning(false); 
                setCanRestart(false);
                setUiScore(Math.floor(engine.score / 10)); 
                if (!isMuted) SoundSynth.playRoar();
                setTimeout(() => { engine.canRestart = true; setCanRestart(true); }, 1000);
            }
        }

        if (engine.gameRunning) {
            const oldScore = Math.floor(engine.score / 10);
            engine.score += 80 * dt; 
            const newScore = Math.floor(engine.score / 10);
            
            if (Math.floor(newScore / 100) > Math.floor(oldScore / 100) && !isMuted) {
                SoundSynth.playScore();
            }
            
            ctx.fillStyle = fgColor; 
            ctx.font = "14px 'Press Start 2P'"; 
            ctx.textAlign = "right";
            const scoreStr = newScore.toString().padStart(5, '0');
            const highStr = Math.floor(engine.highScore/10).toString().padStart(5, '0');
            ctx.fillText(`HI ${highStr} ${scoreStr}`, canvas.width - 25, 45);
            
            engine.animationId = requestAnimationFrame(runGameLoop);
        }
    };

    const resetGame = () => {
        const engine = engineRef.current;
        engine.obstaclePool.forEach(p => p.active = false);
        engine.groundPool.forEach(p => p.active = false);
        engine.cloudPool.forEach(p => p.active = false);
        for (let x = 0; x < GAME_CONFIG.CANVAS_WIDTH; x += 15 + Math.random() * 30) getFromPool(engine.groundPool, () => new GroundDetail()).spawn(x);
        engine.score = 0; 
        engine.canRestart = false; 
        engine.gameSpeed = GAME_CONFIG.INITIAL_SPEED;
        engine.spawnTimer = 1.0; 
        engine.groundSpawnTimer = 0; 
        engine.cloudSpawnTimer = 0;
        engine.dino.reset(); 
        engine.lastTime = 0; 
        engine.gameRunning = true;
        setGameRunning(true); 
        setCanRestart(false);
        setUiScore(0);
        requestAnimationFrame(runGameLoop);
    };

    const predictWebcam = () => {
        const video = videoRef.current; const outCanvas = outputCanvasRef.current; const engine = engineRef.current;
        if (!video || !outCanvas || !visionRef.current.handLandmarker || video.readyState < 2) {
            engine.visionAnimationId = requestAnimationFrame(predictWebcam); return;
        }
        const now = performance.now(); const state = visionRef.current;
        
        if (now - state.lastPredictionTime < (1000 / GAME_CONFIG.VISION_FPS)) {
            engine.visionAnimationId = requestAnimationFrame(predictWebcam);
            return;
        }
        state.lastPredictionTime = now;

        if (outCanvas.width !== video.videoWidth || outCanvas.height !== video.videoHeight) {
            outCanvas.width = video.videoWidth; outCanvas.height = video.videoHeight;
        }
        
        if (state.lastVideoTime !== video.currentTime) {
            state.lastVideoTime = video.currentTime;
            state.results = state.handLandmarker.detectForVideo(video, now);
            if (state.results && state.results.landmarks && state.results.landmarks.length > 0) {
                const landmarks = state.results.landmarks[0];
                const indexFingerTip = landmarks[8]; const wrist = landmarks[0]; const currentY = indexFingerTip.y;
                const middleFingerTip = landmarks[12]; const handScale = Math.max(Math.hypot(wrist.x - middleFingerTip.x, wrist.y - middleFingerTip.y), 0.05);
                const currentTime = video.currentTime;
                if (currentTime - state.prevTime > 0.4) { state.prevTime = currentTime; state.prevY = currentY; state.smoothedVelocity = 0; }
                if (state.prevTime > 0 && currentTime > state.prevTime) {
                    const dtV = currentTime - state.prevTime; const dy = state.prevY - currentY; 
                    state.smoothedVelocity = state.smoothedVelocity * 0.3 + ((dy / handScale) / dtV) * 0.7;
                }
                state.peakVelocity = Math.max(state.smoothedVelocity, state.peakVelocity * 0.95);
                state.prevY = currentY; state.prevTime = currentTime;
                if (state.smoothedVelocity > state.JUMP_VELOCITY_THRESHOLD) {
                    const nowJ = Date.now();
                    if (nowJ - state.lastJumpTime > GAME_CONFIG.JUMP_COOLDOWN_MS) {
                        state.lastJumpTime = nowJ;
                        if (engine.gameRunning) { 
                            if (engine.dino.jump()) {
                                if (!isMuted) SoundSynth.playJump();
                                if (navigator.vibrate) navigator.vibrate(25);
                            }
                        }
                        else if (engine.canRestart) resetGame();
                        else if (!engine.hasStarted && engine.cameraReady) { SoundSynth.init(); setHasStarted(true); engineRef.current.hasStarted = true; resetGame(); }
                    }
                }
                engine.dino.duck(currentY > wrist.y + 0.12);
            } else { state.prevTime = 0; state.smoothedVelocity = 0; state.peakVelocity *= 0.6; engine.dino.duck(false); }
        }

        if (showVision) {
            const outCtx = outCanvas.getContext('2d', { alpha: true })!;
            outCtx.clearRect(0, 0, outCanvas.width, outCanvas.height);
            if (state.results && state.results.landmarks && state.results.landmarks.length > 0) {
                outCtx.fillStyle = GAME_CONFIG.COLORS.ACCENT;
                for (const landmark of state.results.landmarks[0]) { outCtx.beginPath(); outCtx.arc(landmark.x * outCanvas.width, landmark.y * outCanvas.height, 2, 0, 2 * Math.PI); outCtx.fill(); }
            }
            const barH = 80; const barW = 12; const barX = 15; const barY = 30;
            const maxVal = Math.max(state.JUMP_VELOCITY_THRESHOLD * 2, state.peakVelocity, 5);
            outCtx.fillStyle = 'rgba(0, 0, 0, 0.4)'; outCtx.fillRect(barX - 4, barY - 4, barW + 8, barH + 8);
            outCtx.fillStyle = GAME_CONFIG.COLORS.ACCENT; outCtx.fillRect(barX - 8, barY + barH - (state.JUMP_VELOCITY_THRESHOLD / maxVal) * barH, barW + 16, 2);
            outCtx.fillStyle = state.smoothedVelocity > state.JUMP_VELOCITY_THRESHOLD ? '#4ade80' : '#fbbf24';
            outCtx.fillRect(barX, barY + barH - Math.min(Math.max(state.smoothedVelocity / maxVal, 0), 1) * barH, barW, Math.min(Math.max(state.smoothedVelocity / maxVal, 0), 1) * barH);
        }
        
        engine.visionAnimationId = requestAnimationFrame(predictWebcam);
    };

    const toggleFullscreen = () => {
        if (!gameWrapperRef.current) return;
        if (!document.fullscreenElement) {
            gameWrapperRef.current.requestFullscreen().catch((err) => {
                console.error(`Error attempting to enable fullscreen: ${err.message}`);
            });
        } else {
            document.exitFullscreen();
        }
    };

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        
        const initMediaPipe = async () => {
            try {
                // @ts-ignore
                const { HandLandmarker, FilesetResolver } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/+esm");
                const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/wasm");
                visionRef.current.handLandmarker = await HandLandmarker.createFromOptions(vision, {
                    baseOptions: { modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`, delegate: "GPU" },
                    runningMode: "VIDEO", numHands: 1
                });
                setIsLoading(false);
            } catch (err) { console.error("MediaPipe load error:", err); }
        };
        initMediaPipe();
        return () => { 
            cancelAnimationFrame(engineRef.current.animationId); 
            cancelAnimationFrame(engineRef.current.visionAnimationId);
            document.removeEventListener('fullscreenchange', handleFullscreenChange);
        };
    }, []);

    return (
        <div className="flex flex-col items-center gap-8 w-full max-w-5xl relative px-2">
            <div 
                ref={gameWrapperRef}
                className={`relative w-full shadow-2xl rounded-2xl overflow-hidden border-4 border-[#333] bg-white ring-8 ring-black/5 ${isFullscreen ? 'h-full flex items-center bg-[#f7f7f7]' : ''}`}
            >
                <canvas 
                    ref={canvasRef} 
                    width={GAME_CONFIG.CANVAS_WIDTH} 
                    height={GAME_CONFIG.CANVAS_HEIGHT} 
                    className="w-full h-auto cursor-pointer block" 
                    style={{ imageRendering: 'pixelated' }} 
                    onClick={() => { 
                        if (!gameRunning && canRestart) resetGame(); 
                        else if (!hasStarted && cameraReady) { SoundSynth.init(); setHasStarted(true); engineRef.current.hasStarted = true; resetGame(); } 
                        else if (gameRunning) { 
                            if (engineRef.current.dino.jump()) {
                                if (!isMuted) SoundSynth.playJump();
                                if (navigator.vibrate) navigator.vibrate(25);
                            }
                        } 
                    }} 
                />
                
                <div className="absolute top-4 left-4 z-20 flex gap-2">
                    <button 
                        onClick={(e) => { e.stopPropagation(); setIsMuted(!isMuted); }} 
                        className="p-2 text-[#535353] bg-white/60 hover:bg-white/90 transition-all rounded-full border border-gray-300 shadow-sm"
                        title={isMuted ? "Unmute" : "Mute"}
                    >
                        {isMuted ? (
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" /></svg>
                        ) : (
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>
                        )}
                    </button>
                    <button 
                        onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }} 
                        className="p-2 text-[#535353] bg-white/60 hover:bg-white/90 transition-all rounded-full border border-gray-300 shadow-sm"
                        title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                    >
                        {isFullscreen ? (
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9L4 4m0 0l5 0M4 4l0 5m11-5l5 5m0-5l-5 0m5 0l0 5m-5 11l5 5m0-5l-5 0m5 5l0-5M9 15l-5 5m0 0l5 0m-5 0l0-5" /></svg>
                        ) : (
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
                        )}
                    </button>
                </div>

                {(!gameRunning && !canRestart && !hasStarted) && (
                    <div className="absolute top-0 left-0 w-full h-full bg-[#f7f7f7]/95 flex flex-col items-center justify-center z-10 p-6 text-center">
                        {isLoading ? (
                            <div className="flex flex-col items-center gap-6"><div className="w-16 h-16 border-4 border-gray-200 border-t-[#535353] rounded-full animate-spin"></div><p className="font-press-start text-[10px] text-[#535353]">PREPARING...</p></div>
                        ) : (
                            <div className="flex flex-col items-center gap-8">
                                <div className="animate-pulse">
                                    <h2 className="text-3xl text-[#535353] font-press-start mb-2">DINO JUMP</h2>
                                    <p className="text-[10px] text-gray-500 font-press-start uppercase tracking-[0.2em]">Ready to hop?</p>
                                </div>
                                {!cameraReady ? (
                                    <button onClick={async () => { SoundSynth.init(); try { const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360, facingMode: 'user' } }); if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.onloadedmetadata = () => { videoRef.current?.play().then(() => { predictWebcam(); setCameraReady(true); engineRef.current.cameraReady = true; }); }; } } catch (err) { alert("Camera access required for body controls!"); } }} className="px-10 py-5 bg-[#535353] text-white font-press-start text-xs hover:bg-black transition-all transform hover:scale-105 active:scale-95 rounded border-b-4 border-black">ACTIVATE CAMERA</button>
                                ) : (
                                    <div className="flex flex-col items-center gap-6">
                                        <button onClick={() => { SoundSynth.init(); setHasStarted(true); engineRef.current.hasStarted = true; resetGame(); }} className="px-12 py-6 bg-[#4a4a4a] text-white font-press-start text-sm hover:bg-black transition-all rounded shadow-xl border-b-4 border-black uppercase tracking-wider">START</button>
                                        <p className="font-press-start text-[10px] text-gray-400 animate-bounce">FLICK HAND UP</p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {(hasStarted && !gameRunning) && (
                    <div className="absolute top-0 left-0 w-full h-full bg-black/30 flex flex-col items-center justify-center z-10 backdrop-blur-sm">
                        <div className="flex flex-col gap-6 items-center bg-white p-10 rounded-xl shadow-2xl border-4 border-[#535353]">
                             <div className="text-[#535353] text-xl font-press-start mb-4 uppercase tracking-widest">GAME OVER</div>
                            <button onClick={resetGame} disabled={!canRestart} className={`px-12 py-6 font-press-start text-lg transition-all rounded shadow-xl uppercase ${canRestart ? 'bg-[#535353] text-white hover:bg-black hover:scale-105 cursor-pointer' : 'bg-gray-400 text-gray-200 opacity-50 cursor-wait'}`}>
                                {canRestart ? "RESTART" : "WAIT..."}
                            </button>
                            {canRestart && (
                                <div className="flex flex-col items-center gap-2">
                                    <p className="text-[#535353] text-[10px] font-press-start uppercase">Final Score: {uiScore}</p>
                                    <p className="text-gray-400 text-[8px] font-press-start animate-pulse mt-2">FLICK HAND UP</p>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            <div className="flex flex-col sm:flex-row justify-between w-full px-4 gap-6 text-[10px] text-[#535353] font-press-start uppercase">
                <div className="flex items-center gap-4">
                    <label className="cursor-pointer flex items-center group transition-all">
                        <input type="checkbox" checked={showVision} onChange={(e) => setShowVision(e.target.checked)} className="mr-3 w-5 h-5 cursor-pointer accent-[#535353]" />
                        <span className="group-hover:text-black">Debug Camera Feed</span>
                    </label>
                </div>
                <div className="flex gap-8 bg-gray-100 px-6 py-3 rounded-full shadow-inner border border-gray-200">
                    <span className="opacity-60">Speed: {Math.floor(engineRef.current.gameSpeed / 10)}</span>
                    <span className="text-[#535353] font-bold">Best: {highScore.toString().padStart(5, '0')}</span>
                </div>
            </div>

            {showVision && (
                <div className="relative w-full max-w-[340px] aspect-[4/3] border-4 border-[#333] rounded-2xl overflow-hidden bg-black shadow-2xl">
                    <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover scale-x-[-1]" />
                    <canvas ref={outputCanvasRef} className="absolute top-0 left-0 w-full h-full scale-x-[-1]" />
                    <div className="absolute top-4 left-4 text-[8px] text-white/50 font-press-start bg-black/40 px-2 py-1 rounded">MOTION FEED</div>
                </div>
            )}
            
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 p-6 bg-gray-50 rounded-2xl border border-gray-200 text-[8px] text-[#888] font-press-start text-center max-w-4xl leading-relaxed">
                <div className="flex flex-col gap-2"><div className="text-[#535353] font-bold pb-1 border-b border-gray-200 uppercase">JUMP</div><p>Flick your hand UP</p></div>
                <div className="flex flex-col gap-2"><div className="text-[#535353] font-bold pb-1 border-b border-gray-200 uppercase">DUCK</div><p>Lower your hand</p></div>
                <div className="flex flex-col gap-2"><div className="text-[#535353] font-bold pb-1 border-b border-gray-200 uppercase">DINO</div><p>Fluid run & jump animations!</p></div>
            </div>
        </div>
    );
};

export default DinoGame;
