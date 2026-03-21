import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal, X, ChevronRight, Cpu, Gauge } from 'lucide-react';

interface RaceCarGameProps {
    onClose: () => void;
}

const GAME_WIDTH = 50;
const GAME_HEIGHT = 24;
const CAR_WIDTH = 5;
const ROAD_WIDTH = 18;
const TRACK_BOUNDARY = '█';
const SAND_CHAR = '░';

const CAR = [
    '  ▂▃▂  ',
    ' ▞▀▀▀▚ ',
    '▐▆▆▆▆▆▌',
    ' ▚▄▄▄▞ '
];

export default function RaceCarGame({ onClose }: RaceCarGameProps) {
    const [gameState, setGameState] = useState<'boot' | 'menu' | 'playing' | 'gameover'>('boot');
    const [score, setScore] = useState(0);
    const [bootLines, setBootLines] = useState<string[]>([]);
    const containerRef = useRef<HTMLDivElement>(null);

    const carX = useRef<number>(Math.floor(GAME_WIDTH / 2) - 2);
    const frameCount = useRef<number>(0);
    const animationRef = useRef<number | null>(null);

    const speed = useRef<number>(0);
    const trackOffsets = useRef<number[]>(new Array(GAME_HEIGHT).fill(GAME_WIDTH / 2));
    const curvePhase1 = useRef<number>(0);
    const curvePhase2 = useRef<number>(0);
    const isOffRoad = useRef<boolean>(false);

    const [renderBuffer, setRenderBuffer] = useState<string[]>([]);

    const keys = useRef<{ [key: string]: boolean }>({});
    const gyroTilt = useRef<number>(0);
    const isDragging = useRef<boolean>(false);

    useEffect(() => {
        if (gameState === 'boot') {
            const sequence = [
                '> INITIALIZING NEURAL LINK...',
                '> CONNECTING TO TELEMETRY CORE...',
                '> [OK] ACCESS GRANTED',
                '> LOADING VIRTUAL ENVIRONMENT...',
                '> EXECUTING "RACE.SH" --MODE=CHILL'
            ];
            let lineIdx = 0;
            const interval = setInterval(() => {
                if (lineIdx < sequence.length) {
                    setBootLines(prev => [...prev, sequence[lineIdx]]);
                    lineIdx++;
                } else {
                    clearInterval(interval);
                    setTimeout(() => setGameState('menu'), 600);
                }
            }, 250);
            return () => clearInterval(interval);
        }
    }, [gameState]);

    const renderGame = useCallback(() => {
        const buffer: string[] = [];
        for (let y = 0; y < GAME_HEIGHT; y++) {
            const center = Math.floor(trackOffsets.current[y]);
            const halfRoad = Math.floor(ROAD_WIDTH / 2);
            let rowChars = new Array(GAME_WIDTH).fill(SAND_CHAR);
            for (let x = center - halfRoad; x <= center + halfRoad; x++) {
                if (x >= 0 && x < GAME_WIDTH) {
                    if (x === center - halfRoad || x === center + halfRoad) rowChars[x] = TRACK_BOUNDARY;
                    else rowChars[x] = ' ';
                }
            }
            const stripeY = (y + Math.floor(frameCount.current * (speed.current / 20))) % 6;
            if (stripeY === 0 && center >= 0 && center < GAME_WIDTH) rowChars[center] = '┆';
            const carY = GAME_HEIGHT - CAR.length - 2;
            if (y >= carY && y < carY + CAR.length) {
                const cx = Math.floor(carX.current);
                const carLine = CAR[y - carY];
                for (let cxp = 0; cxp < carLine.length; cxp++) {
                    const px = cx + cxp;
                    if (px >= 0 && px < GAME_WIDTH && carLine[cxp] !== ' ') rowChars[px] = carLine[cxp];
                }
            }
            buffer.push(rowChars.join(''));
        }
        setRenderBuffer(buffer);
    }, []);

    const updateGame = useCallback(() => {
        if (gameState !== 'playing') return;
        frameCount.current++;
        curvePhase1.current += 0.012;
        curvePhase2.current += 0.007;
        const nextOffset = (GAME_WIDTH / 2) +
            Math.sin(curvePhase1.current) * (GAME_WIDTH / 6) +
            Math.sin(curvePhase2.current) * (GAME_WIDTH / 8);
        trackOffsets.current.unshift(nextOffset);
        trackOffsets.current.pop();
        const carYIdx = GAME_HEIGHT - CAR.length - 2;
        const trackCenterAtCar = trackOffsets.current[carYIdx];
        const distFromCenter = Math.abs(carX.current + (CAR_WIDTH / 2) - trackCenterAtCar);
        const roadLimit = (ROAD_WIDTH / 2) - 1;
        isOffRoad.current = distFromCenter > roadLimit;
        const maxSpeed = isOffRoad.current ? 24 : 72 + (score / 200);
        if (speed.current < maxSpeed) speed.current += 0.3;
        if (speed.current > maxSpeed) speed.current -= 0.6;
        let moveDir = 0;
        if (keys.current['ArrowLeft'] || keys.current['a']) moveDir -= 1;
        if (keys.current['ArrowRight'] || keys.current['d']) moveDir += 1;
        if (moveDir === 0 && Math.abs(gyroTilt.current) > 2) moveDir = gyroTilt.current / 15;
        const steeringPower = 0.5 * (1 + (speed.current / 150)); // Reduced by 60% (1.2 * 0.4 = 0.48, approx 0.5)
        carX.current += moveDir * steeringPower;
        if (carX.current < 0) carX.current = 0;
        if (carX.current > GAME_WIDTH - CAR_WIDTH) carX.current = GAME_WIDTH - CAR_WIDTH;
        if (frameCount.current % 10 === 0) setScore(s => s + Math.floor(speed.current / 10));
        renderGame();
        animationRef.current = requestAnimationFrame(updateGame);
    }, [gameState, renderGame, score]);

    useEffect(() => { if (containerRef.current) containerRef.current.focus(); }, [gameState]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            keys.current[e.key] = true;
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
        };
        const handleKeyUp = (e: KeyboardEvent) => { keys.current[e.key] = false; };
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
        };
    }, []);

    useEffect(() => {
        const handleOrientation = (event: DeviceOrientationEvent) => {
            if (event.gamma !== null) {
                let g = event.gamma;
                gyroTilt.current = g > 45 ? 45 : (g < -45 ? -45 : g);
            }
        };
        if (gameState === 'playing') window.addEventListener('deviceorientation', handleOrientation);
        return () => window.removeEventListener('deviceorientation', handleOrientation);
    }, [gameState]);

    useEffect(() => {
        if (gameState === 'playing') animationRef.current = requestAnimationFrame(updateGame);
        return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current); };
    }, [gameState, updateGame]);

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDragging.current || gameState !== 'playing') return;
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
            const x = e.clientX - rect.left;
            const percentage = x / rect.width;
            carX.current = (percentage * GAME_WIDTH) - (CAR_WIDTH / 2);
        }
    };

    const startGame = async () => {
        if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
            try { await (DeviceOrientationEvent as any).requestPermission(); } catch (e) { console.warn(e); }
        }
        carX.current = Math.floor(GAME_WIDTH / 2) - 2;
        trackOffsets.current = new Array(GAME_HEIGHT).fill(GAME_WIDTH / 2);
        frameCount.current = 0;
        speed.current = 0;
        setScore(0);
        setGameState('playing');
    };

    return (
        <div
            ref={containerRef}
            tabIndex={0}
            onMouseDown={() => { isDragging.current = true; }}
            onMouseMove={handleMouseMove}
            onMouseUp={() => { isDragging.current = false; }}
            onMouseLeave={() => { isDragging.current = false; }}
            className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-[#050510]/98 text-[#00ffcc] font-mono p-4 outline-none selection:bg-[#00ffcc]/30 cursor-crosshair"
        >
            <div className="pointer-events-none fixed inset-0 z-[201] bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.03]"></div>
            <div className="pointer-events-none fixed inset-0 z-[201] bg-gradient-to-b from-transparent via-[#00ffcc]/5 to-transparent bg-[length:100%_4px] animate-scanline"></div>

            <div className="max-w-4xl w-full bg-[#0a0a1a] border border-[#00ffcc]/20 rounded-lg shadow-[0_0_50px_rgba(0,255,204,0.1)] overflow-hidden flex flex-col h-[85vh]">
                <div className="flex items-center justify-between px-4 py-2 bg-[#121225] border-b border-[#00ffcc]/20">
                    <div className="flex items-center gap-2">
                        <Terminal size={14} className="text-[#00ffcc]" />
                        <span className="text-[10px] font-bold tracking-tight opacity-80 uppercase">pecan_v6_rand_sim</span>
                    </div>
                    <button onClick={onClose} className="hover:text-white transition-colors"><X size={18} /></button>
                </div>

                <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-2">
                    {gameState === 'boot' && (
                        <div className="flex flex-col gap-1">
                            {bootLines.map((line, i) => <div key={i} className="text-sm animate-in fade-in slide-in-from-left-2 duration-200">{line}</div>)}
                            <div className="w-2 h-4 bg-[#00ffcc] animate-pulse mt-1"></div>
                        </div>
                    )}

                    {(gameState === 'menu' || gameState === 'playing') && (
                        <>
                            <div className="flex flex-col opacity-60 text-[10px] border-l border-[#00ffcc]/30 pl-2">
                                <div>[KERNEL] RANDOM_SEED: ENABLED</div>
                                <div>[KERNEL] CONTROL_SCHEME: KEYBOARD | GYRO | MOUSE_DRAG</div>
                                {isOffRoad.current && <div className="text-yellow-500">[WARN] SURFACE_FRICTION: ACTIVE</div>}
                            </div>

                            {gameState === 'menu' && (
                                <div className="mt-10 flex flex-col items-center gap-6 py-12 border border-[#00ffcc]/10 bg-[#00ffcc]/2 rounded-lg">
                                    <Cpu size={48} className="text-[#00ffcc] opacity-40 animate-pulse" />
                                    <div className="text-center">
                                        <h2 className="text-3xl font-black tracking-tighter mb-1">DATA_DRIFT v6.0</h2>
                                        <p className="text-sm opacity-60 px-8">Drag with mouse, tilt, or use Arrows (Low Sens). A pure, obstacle-free driving simulation.</p>
                                    </div>
                                    <button onClick={startGame} className="group relative px-12 py-3 bg-[#00ffcc] text-[#050510] font-black uppercase tracking-widest transition-transform hover:scale-105">
                                        START ENGINE <ChevronRight size={18} className="inline ml-1" />
                                    </button>
                                </div>
                            )}

                            {gameState === 'playing' && (
                                <div className="flex flex-col lg:flex-row gap-6 mt-2 h-full">
                                    <div className="flex flex-col gap-4 w-full lg:w-48 shrink-0">
                                        <div className="bg-black/40 border border-[#00ffcc]/10 p-4 rounded flex flex-col gap-2">
                                            <div className="flex items-center gap-2 opacity-60 text-[10px] uppercase font-bold"><Gauge size={12} /> Speedometer</div>
                                            <div className="text-3xl font-black text-[#00ffcc] tabular-nums">
                                                {Math.floor(speed.current * 1.8)}
                                                <span className="text-[10px] ml-1 opacity-50 font-normal">KM/H</span>
                                            </div>
                                            <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                                                <div className="h-full bg-[#00ffcc] shadow-[0_0_10px_#00ffcc]" style={{ width: `${(speed.current / 120) * 100}%` }}></div>
                                            </div>
                                        </div>
                                        <div className="bg-black/40 border border-[#00ffcc]/10 p-4 rounded flex flex-col gap-1">
                                            <div className="opacity-60 text-[10px] uppercase font-bold">Total Distance</div>
                                            <div className="text-2xl font-black tabular-nums">{score}m</div>
                                        </div>
                                    </div>

                                    <div className="relative flex-1 bg-black/60 rounded border border-[#00ffcc]/5 shadow-inner flex items-center justify-center p-2 overflow-hidden">
                                        <pre className="text-[#00ffcc] text-[8px] md:text-[11px] leading-tight selection:bg-transparent tracking-tighter cursor-none">
                                            {renderBuffer.join('\n')}
                                        </pre>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>

            <style>{`@keyframes scanline { 0% { transform: translateY(-100%); } 100% { transform: translateY(100%); } } .animate-scanline { animation: scanline 10s linear infinite; }`}</style>
        </div>
    );
}
