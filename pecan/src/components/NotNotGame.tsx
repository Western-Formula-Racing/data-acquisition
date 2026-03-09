import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';

interface NotNotGameProps {
    onClose: () => void;
}

type Direction = 'up' | 'down' | 'left' | 'right';

interface Side {
    dir: Direction;
    color: string;
    bg: string;
    hover: string;
}

interface Puzzle {
    sides: Side[];
    instruction: string;
    validMoves: Direction[];
}

const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];
const COLORS = [
    { name: 'red', bg: 'bg-rose-500', hover: 'hover:bg-rose-400' },
    { name: 'blue', bg: 'bg-blue-500', hover: 'hover:bg-blue-400' },
    { name: 'green', bg: 'bg-emerald-500', hover: 'hover:bg-emerald-400' },
    { name: 'yellow', bg: 'bg-amber-400', hover: 'hover:bg-amber-300' }
];

const NotNotGame: React.FC<NotNotGameProps> = ({ onClose }) => {
    const [gameState, setGameState] = useState<'menu' | 'playing' | 'gameover'>('menu');
    const [score, setScore] = useState(0);
    const [timeLeft, setTimeLeft] = useState(100); // Percentage
    const [maxTimeMs, setMaxTimeMs] = useState(3000);
    const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
    const [shake, setShake] = useState(false);

    const startTimeRef = useRef(0);
    const animationFrameRef = useRef<number | null>(null);

    // Generate a new puzzle based on current score
    const generatePuzzle = useCallback((currentScore: number): Puzzle => {
        let numNots = 0;
        let useColor = false;

        // Difficulty scaling
        if (currentScore >= 5) useColor = Math.random() > 0.4;
        if (currentScore >= 10) numNots = Math.random() > 0.5 ? 1 : 0;
        if (currentScore >= 20) numNots = Math.floor(Math.random() * 3); // 0, 1, or 2
        if (currentScore >= 40) numNots = Math.floor(Math.random() * 4); // Up to 3 NOTs

        // Assign random colors to the 4 directions
        const shuffledColors = [...COLORS].sort(() => Math.random() - 0.5);
        const sides: Side[] = DIRECTIONS.map((dir, i) => ({
            dir,
            color: shuffledColors[i].name,
            bg: shuffledColors[i].bg,
            hover: shuffledColors[i].hover
        }));

        // Decide if the base target is a Direction or a Color
        const isColorTarget = useColor && Math.random() > 0.5;
        let targetValue: string;
        let baseValidMoves: Direction[] = [];

        if (isColorTarget) {
            const targetColorObj = shuffledColors[Math.floor(Math.random() * 4)];
            targetValue = targetColorObj.name;
            baseValidMoves = sides.filter(s => s.color === targetValue).map(s => s.dir);
        } else {
            targetValue = DIRECTIONS[Math.floor(Math.random() * 4)];
            baseValidMoves = [targetValue as Direction];
        }

        // Apply "NOT" logic
        let validMoves = [...baseValidMoves];
        let instructionText = targetValue.toUpperCase();

        for (let i = 0; i < numNots; i++) {
            validMoves = DIRECTIONS.filter(d => !validMoves.includes(d));
            instructionText = "NOT " + instructionText;
        }

        // Failsafe: if a rule results in no valid moves (rare but possible with certain combos), regenerate
        if (validMoves.length === 0) {
            return generatePuzzle(currentScore);
        }

        return { sides, instruction: instructionText, validMoves };
    }, []);

    const startGame = () => {
        setScore(0);
        setMaxTimeMs(3500);
        setPuzzle(generatePuzzle(0));
        setGameState('playing');
        startTimeRef.current = performance.now();
        setTimeLeft(100);
    };

    const gameOver = useCallback(() => {
        setGameState('gameover');
        setShake(true);
        setTimeout(() => setShake(false), 500);
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
        }
    }, []);

    const handleMove = useCallback((direction: Direction) => {
        if (gameState !== 'playing' || !puzzle) return;

        if (puzzle.validMoves.includes(direction)) {
            // Correct move
            const newScore = score + 1;
            setScore(newScore);

            // Decrease time limit as score goes up (minimum 1000ms)
            const newMaxTime = Math.max(1000, 3500 - (newScore * 60));
            setMaxTimeMs(newMaxTime);

            setPuzzle(generatePuzzle(newScore));
            startTimeRef.current = performance.now();
            setTimeLeft(100);
        } else {
            // Wrong move
            gameOver();
        }
    }, [gameState, puzzle, score, generatePuzzle, gameOver]);

    // Handle Keyboard Input
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (gameState !== 'playing') return;

            switch (e.key) {
                case 'ArrowUp': handleMove('up'); break;
                case 'ArrowDown': handleMove('down'); break;
                case 'ArrowLeft': handleMove('left'); break;
                case 'ArrowRight': handleMove('right'); break;
                default: break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleMove, gameState]);

    // Timer Loop
    useEffect(() => {
        if (gameState === 'playing') {
            const updateTimer = (time: number) => {
                const elapsed = time - startTimeRef.current;
                const remaining = Math.max(0, 100 - (elapsed / maxTimeMs) * 100);
                setTimeLeft(remaining);

                if (remaining <= 0) {
                    gameOver();
                } else {
                    animationFrameRef.current = requestAnimationFrame(updateTimer);
                }
            };
            animationFrameRef.current = requestAnimationFrame(updateTimer);
        }

        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, [gameState, maxTimeMs, gameOver]);


    // UI Helper to get the side data based on direction
    const getSide = (dir: Direction) => puzzle?.sides.find(s => s.dir === dir);

    return (
        <div className="h-full w-full bg-background flex flex-col items-center justify-center font-sans text-white select-none overflow-hidden relative rounded-xl border border-white/5">

            {/* Close Button */}
            <button
                onClick={onClose}
                className="absolute top-4 right-4 p-2 text-sidebarfg hover:text-white transition-colors z-50 cursor-pointer"
                aria-label="Close game"
            >
                <X className="w-6 h-6" />
            </button>

            {/* Header */}
            <div className="absolute top-8 text-center w-full">
                <h1 className="text-3xl font-heading italic tracking-widest text-[#56B4E9] mb-2 uppercase drop-shadow-[0_0_10px_rgba(86,180,233,0.3)]">Not Not</h1>
                {gameState !== 'menu' && (
                    <div className="text-xl font-footer text-sidebarfg">Score: <span className="text-white">{score}</span></div>
                )}
            </div>

            {/* Main Game Area */}
            <div className={`relative w-72 h-72 max-w-full transition-transform duration-75 ${shake ? 'translate-x-2 -translate-y-2' : ''}`}>

                {gameState === 'menu' && (
                    <div className="absolute inset-0 bg-option rounded-2xl flex flex-col items-center justify-center shadow-2xl z-10 p-6 text-center border-4 border-sidebarfg/20">
                        <h2 className="text-xl font-footer font-bold mb-4 text-white">How to Play</h2>
                        <p className="text-sidebarfg mb-2 text-sm">Follow the logic on the cube.</p>
                        <p className="text-sidebarfg/60 text-xs mb-6 font-mono">Use arrow keys or tap the directional blocks. Beware of the word "NOT"!</p>
                        <button
                            onClick={startGame}
                            className="px-8 py-2.5 bg-banner-button hover:bg-banner-button-hover text-white font-bold rounded-full transition-all shadow-lg active:scale-95 text-md cursor-pointer border-none"
                        >
                            PLAY NOW
                        </button>
                    </div>
                )}

                {gameState === 'gameover' && (
                    <div className="absolute inset-0 bg-rose-950/90 backdrop-blur-sm rounded-2xl flex flex-col items-center justify-center shadow-2xl z-20 border-4 border-rose-500">
                        <h2 className="text-3xl font-heading mb-2 text-white drop-shadow-md italic uppercase">Crashed</h2>
                        <p className="text-xl font-footer mb-6 text-rose-200">Score: {score}</p>
                        <button
                            onClick={startGame}
                            className="px-8 py-2.5 bg-white text-rose-900 font-extrabold rounded-full hover:bg-neutral-200 transition-colors shadow-lg active:scale-95 text-md cursor-pointer border-none"
                        >
                            TRY AGAIN
                        </button>
                    </div>
                )}

                {/* The 3x3 Playing Grid */}
                <div className="w-full h-full grid grid-cols-3 grid-rows-3 gap-2">

                    {/* Top Row */}
                    <div className="col-start-2">
                        <DirectionButton dir="up" side={getSide('up')} onClick={() => handleMove('up')} disabled={gameState !== 'playing'} />
                    </div>

                    {/* Middle Row */}
                    <div className="col-start-1 row-start-2">
                        <DirectionButton dir="left" side={getSide('left')} onClick={() => handleMove('left')} disabled={gameState !== 'playing'} />
                    </div>

                    {/* Center Box (Instructions & Timer) */}
                    <div className="col-start-2 row-start-2 relative bg-option rounded-xl shadow-inner border-4 border-sidebarfg/10 flex items-center justify-center p-2 overflow-hidden">
                        {puzzle && (
                            <div className="text-center w-full z-10">
                                <span className={`font-heading italic uppercase break-words leading-tight ${puzzle.instruction.length > 10 ? 'text-md' : 'text-xl'
                                    } ${puzzle.instruction.includes('NOT') ? 'text-rose-400' : 'text-white'}`}>
                                    {puzzle.instruction}
                                </span>
                            </div>
                        )}
                        {/* Timer Bar embedded at the bottom of the center block */}
                        <div className="absolute bottom-0 left-0 w-full h-1.5 bg-black/40">
                            <div
                                className={`h-full transition-all duration-75 ease-linear ${timeLeft < 25 ? 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]' : 'bg-[#56B4E9]'}`}
                                style={{ width: `${timeLeft}%` }}
                            />
                        </div>
                    </div>

                    <div className="col-start-3 row-start-2">
                        <DirectionButton dir="right" side={getSide('right')} onClick={() => handleMove('right')} disabled={gameState !== 'playing'} />
                    </div>

                    {/* Bottom Row */}
                    <div className="col-start-2 row-start-3">
                        <DirectionButton dir="down" side={getSide('down')} onClick={() => handleMove('down')} disabled={gameState !== 'playing'} />
                    </div>

                </div>
            </div>

            {/* Footer Instructions */}
            <div className="absolute bottom-6 text-sidebarfg opacity-40 text-[10px] font-mono tracking-widest hidden md:block uppercase">
                Standard Control Protocol: Arrows / Mouse
            </div>
        </div>
    );
}

// Sub-component for the directional blocks
interface DirectionButtonProps {
    dir: Direction;
    side?: Side;
    onClick: () => void;
    disabled: boolean;
}

function DirectionButton({ dir, side, onClick, disabled }: DirectionButtonProps) {
    if (!side) return <div className="w-full h-full rounded-xl bg-option/30" />;

    // Determine border radius based on position for a cohesive 'cross' shape
    let roundedClass = "rounded-xl";
    if (dir === 'up') roundedClass = "rounded-t-2xl rounded-b-md";
    if (dir === 'down') roundedClass = "rounded-b-2xl rounded-t-md";
    if (dir === 'left') roundedClass = "rounded-l-2xl rounded-r-md";
    if (dir === 'right') roundedClass = "rounded-r-2xl rounded-l-md";

    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`w-full h-full ${side.bg} ${side.hover} ${roundedClass} shadow-lg transition-transform active:scale-95 flex items-center justify-center focus:outline-none cursor-pointer disabled:cursor-default border-none`}
        >
            <div className="w-1/3 h-1/3 bg-white/20 rounded-full blur-[1px]" />
        </button>
    );
}

export default NotNotGame;
