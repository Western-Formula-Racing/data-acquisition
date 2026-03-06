import { useState, useEffect, useRef } from 'react';
import {
    Radio,
    Users,
    PhoneOff,
    Wifi,
    WifiOff,
    Mic,
    MicOff,
    Settings
} from 'lucide-react';
import CarVideoFeed from '../components/CarVideoFeed';
import CommsSensorStrip, { loadPinnedSensors, type CommsSensorConfig } from '../components/CommsSensorStrip';
import LinkHealthPanel from '../components/comms/LinkHealthPanel';

const jitsiBaseUrl = import.meta.env.VITE_JITSI_URL || `http://${window.location.hostname}:8000`;

// --- USER JOIN MODAL ---
const UserJoinModal = ({ onJoin }: { onJoin: (name: string, room: string) => void }) => {
    const [name, setName] = useState('');
    const [room, setRoom] = useState('wfr-comms');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const savedName = localStorage.getItem('comms_username');
        if (savedName) setName(savedName);
        inputRef.current?.focus();
    }, []);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (name.trim()) {
            localStorage.setItem('comms_username', name.trim());
            onJoin(name.trim(), room.trim() || 'wfr-comms');
        }
    };

    return (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
            <div className="bg-data-module-bg rounded-xl p-8 max-w-md w-full border border-sidebarfg/20 shadow-2xl">
                <div className="flex items-center gap-3 mb-6">
                    <div className="bg-sidebar p-3 rounded-lg">
                        <Radio className="w-8 h-8 text-emerald-400" />
                    </div>
                    <div>
                        <h2 className="text-2xl font-heading text-white">Join Comms</h2>
                        <p className="text-sidebarfg text-sm">Enter your name to connect</p>
                    </div>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="text-sidebarfg text-sm block mb-2">Your Name</label>
                        <input
                            ref={inputRef}
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Enter your name..."
                            className="w-full px-4 py-3 rounded-lg bg-data-textbox-bg border border-sidebarfg/20 text-white placeholder:text-sidebarfg/50 focus:outline-none focus:border-emerald-500/50"
                            maxLength={20}
                        />
                    </div>
                    <div>
                        <label className="text-sidebarfg text-sm block mb-2">Room Name</label>
                        <input
                            type="text"
                            value={room}
                            onChange={(e) => setRoom(e.target.value)}
                            placeholder="wfr-comms"
                            className="w-full px-4 py-3 rounded-lg bg-data-textbox-bg border border-sidebarfg/20 text-white placeholder:text-sidebarfg/50 focus:outline-none focus:border-emerald-500/50"
                        />
                        <p className="text-sidebarfg/60 text-xs mt-1">Use different rooms for different channels (e.g., wfr-driver, wfr-pit)</p>
                    </div>
                    <button
                        type="submit"
                        disabled={!name.trim()}
                        className="w-full py-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-sidebarfg/20 disabled:cursor-not-allowed text-white font-heading text-xl transition-colors mt-4"
                    >
                        Connect
                    </button>
                </form>
            </div>
        </div>
    );
};

// --- QUICK ROOM SWITCHER ---
const RoomSwitcher = ({ currentRoom, onSwitch }: { currentRoom: string, onSwitch: (room: string) => void }) => {
    const rooms = [
        { id: 'wfr-comms', label: 'All Team', icon: Users },
        { id: 'wfr-driver', label: 'Driver', icon: Radio },
        { id: 'wfr-pit', label: 'Pit Crew', icon: Settings },
    ];

    return (
        <div className="flex gap-2 flex-wrap">
            {rooms.map((room) => (
                <button
                    key={room.id}
                    onClick={() => onSwitch(room.id)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-footer transition-colors ${currentRoom === room.id
                        ? 'bg-emerald-600/20 border border-emerald-500/50 text-emerald-400'
                        : 'bg-data-textbox-bg border border-transparent text-sidebarfg hover:bg-sidebarfg/20'
                        }`}
                >
                    <room.icon className="w-4 h-4" />
                    {room.label}
                </button>
            ))}
        </div>
    );
};

// --- MAIN COMPONENT ---
export default function Comms() {
    const [username, setUsername] = useState<string | null>(null);
    const [roomName, setRoomName] = useState<string>('wfr-comms');
    const [isConnected, setIsConnected] = useState(false);
    const [audioMuted, setAudioMuted] = useState(false);
    const [pinnedSensors] = useState<CommsSensorConfig[]>(() => loadPinnedSensors());

    const handleJoin = (name: string, room: string) => {
        setUsername(name);
        setRoomName(room);
    };

    const handleDisconnect = () => {
        setUsername(null);
        setIsConnected(false);
    };

    const handleRoomSwitch = (newRoom: string) => {
        setRoomName(newRoom);
        setIsConnected(false);
    };

    const toggleAudio = () => {
        setAudioMuted(!audioMuted);
    };

    if (!username) {
        return <UserJoinModal onJoin={handleJoin} />;
    }

    return (
        <div className="w-full h-full flex flex-col p-4 md:p-6 overflow-hidden">
            {/* HEADER */}
            <header className="mb-4 flex flex-col md:flex-row md:items-center justify-between gap-4 flex-shrink-0">
                <div className="flex items-center gap-3">
                    <div className="bg-data-module-bg p-2 rounded-lg border border-sidebarfg/20">
                        <Radio className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="text-2xl md:text-3xl font-heading text-white tracking-wide">Comms</h1>
                        <div className="flex items-center gap-2 text-xs text-sidebarfg font-footer mt-1">
                            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                            {isConnected ? `${username} in ${roomName}` : 'Connecting...'}
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <RoomSwitcher currentRoom={roomName} onSwitch={handleRoomSwitch} />

                    <div className={`flex items-center gap-2 px-4 py-2 rounded-lg border ${isConnected
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                        : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                        }`}>
                        {isConnected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
                        <span className="font-footer text-sm">{isConnected ? 'Online' : 'Joining...'}</span>
                    </div>
                </div>
            </header>

            {/* PINNED SENSORS */}
            {pinnedSensors.length > 0 && (
                <div className="mb-4 flex-shrink-0">
                    <CommsSensorStrip sensors={pinnedSensors} />
                </div>
            )}

            {/* LINK HEALTH */}
            <div className="mb-4 flex-shrink-0">
                <LinkHealthPanel />
            </div>

            {/* MAIN CONTENT — Split: Video + Jitsi Audio */}
            <div className="flex-1 flex flex-col lg:flex-row gap-4 min-h-0">
                {/* Car Video Feed — top on mobile, left on desktop */}
                <div className="lg:flex-1 h-48 lg:h-auto bg-data-module-bg rounded-xl border border-sidebarfg/10 overflow-hidden">
                    <CarVideoFeed />
                </div>

                {/* Jitsi Audio — bottom on mobile, right panel on desktop */}
                <div className="lg:w-80 flex-1 lg:flex-none bg-data-module-bg rounded-xl border border-sidebarfg/10 overflow-hidden relative min-h-0">
                    <iframe
                        src={`${jitsiBaseUrl}/${roomName}#userInfo.displayName="${encodeURIComponent(username)}"&config.prejoinPageEnabled=false&config.startWithVideoMuted=true&config.startWithAudioMuted=false&config.disableDeepLinking=true&interfaceConfig.SHOW_JITSI_WATERMARK=false&interfaceConfig.SHOW_WATERMARK_FOR_GUESTS=false`}
                        allow="camera; microphone; fullscreen; display-capture; autoplay"
                        className="w-full h-full border-0"
                        onLoad={() => setIsConnected(true)}
                    />
                </div>
            </div>

            {/* BOTTOM CONTROLS */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-4 flex-shrink-0">
                <button
                    onClick={toggleAudio}
                    className={`flex items-center gap-2 px-6 py-3 rounded-full transition-all ${audioMuted
                        ? 'bg-rose-500/20 border border-rose-500/50 text-rose-400'
                        : 'bg-emerald-500/20 border border-emerald-500/50 text-emerald-400'
                        }`}
                >
                    {audioMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                    <span className="font-footer">{audioMuted ? 'Unmute' : 'Mute'}</span>
                </button>

                <button
                    onClick={handleDisconnect}
                    className="flex items-center gap-2 px-6 py-3 rounded-full bg-rose-500/10 border border-rose-500/30 text-rose-400 hover:bg-rose-500/20 transition-colors"
                >
                    <PhoneOff className="w-5 h-5" />
                    <span className="font-footer">Leave</span>
                </button>
            </div>

            {/* INFO */}
            <div className="mt-4 text-center text-xs text-sidebarfg/60 flex-shrink-0">
                <p>Video via go2rtc (WebRTC) • Audio via Jitsi Meet • Share room name with team members</p>
            </div>
        </div>
    );
}
