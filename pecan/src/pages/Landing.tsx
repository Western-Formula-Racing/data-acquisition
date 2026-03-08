import { useNavigate } from "react-router";
import {
    LayoutDashboard,
    Battery,
    Wrench,
    Link2,
    Zap,
    ScrollText,
    type LucideIcon,
} from "lucide-react";

interface FeatureCard {
    title: string;
    description: string;
    icon: LucideIcon;
    path: string;
    gradient: string;
    iconColor: string;
    isPending?: boolean;
}

const features: FeatureCard[] = [
    {
        title: "Live Dashboard",
        description: "Real-time telemetry monitoring with customizable data modules and live signal visualization.",
        icon: LayoutDashboard,
        path: "/dashboard",
        gradient: "from-violet-500/20 to-purple-600/20",
        iconColor: "text-violet-400",
    },
    {
        title: "Accumulator",
        description: "Battery cell health monitoring with voltage tracking, temperature alerts, and pack overview.",
        icon: Battery,
        path: "/accumulator",
        gradient: "from-emerald-500/20 to-teal-600/20",
        iconColor: "text-emerald-400",
    },
    {
        title: "Monitor Builder",
        description: "Create custom monitoring layouts with drag-and-drop signal configuration.",
        icon: Wrench,
        path: "/monitor-builder",
        gradient: "from-orange-500/20 to-amber-600/20",
        iconColor: "text-orange-400",
    },
    {
        title: "SystemLink",
        description: "System diagnostics, data playback, and integration status overview.",
        icon: Link2,
        path: "/system-link",
        gradient: "from-blue-500/20 to-cyan-600/20",
        iconColor: "text-blue-400",
    },
    {
        title: "CAN Trace",
        description: "Live timestamped log of every raw CAN frame — Kvaser-style trace with scroll, fixed-position, delta timing, and CSV export.",
        icon: ScrollText,
        path: "/trace",
        gradient: "from-cyan-500/20 to-teal-600/20",
        iconColor: "text-cyan-400",
    },
    {
        title: "ChargeCart",
        description: "Charging session management and power delivery monitoring.",
        icon: Zap,
        path: "/chargecart",
        gradient: "from-yellow-500/20 to-orange-600/20",
        iconColor: "text-yellow-400",
        isPending: true,
    },
];

function FeatureCardComponent({ feature }: { feature: FeatureCard }) {
    const navigate = useNavigate();
    const Icon = feature.icon;

    return (
        <button
            onClick={() => navigate(feature.path)}
            style={{ borderRadius: '16px' }}
            className={`
        group relative overflow-hidden
        bg-gradient-to-br ${feature.gradient}
        backdrop-blur-xl
        border border-white/10
        p-6
        text-left
        transition-all duration-300 ease-out
        hover:scale-[1.02] hover:border-white/20
        hover:shadow-2xl hover:shadow-purple-500/10
        focus:outline-none focus:ring-2 focus:ring-purple-500/50
        cursor-pointer
        ${feature.isPending ? "opacity-60" : ""}
      `}
        >
            {/* Glow effect on hover */}
            <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

            {/* Icon */}
            <div className={`mb-4 ${feature.iconColor}`}>
                <Icon
                    size={36}
                    strokeWidth={1.5}
                    className="transform group-hover:scale-110 transition-transform duration-300"
                />
            </div>

            {/* Title */}
            <h3 className="text-xl font-semibold text-white mb-2 flex items-center gap-2">
                {feature.title}
                {feature.isPending && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 font-normal">
                        Coming Soon
                    </span>
                )}
            </h3>

            {/* Description */}
            <p className="text-sm text-gray-400 leading-relaxed">
                {feature.description}
            </p>

            {/* Arrow indicator */}
            <div className="absolute bottom-6 right-6 text-white/30 group-hover:text-white/60 group-hover:translate-x-1 transition-all duration-300">
                →
            </div>
        </button>
    );
}

function Landing() {
    return (
        <div className="h-full overflow-y-auto bg-gradient-to-b from-[#0d0c11] via-[#12111a] to-[#0d0c11]">
            <div className="max-w-6xl mx-auto px-6 py-16">
                {/* Hero Section */}
                <div className="text-center mb-16">
                    <h1 className="text-5xl md:text-6xl font-bold text-white mb-4 tracking-tight">
                        PROJECT{" "}
                        <span className="bg-gradient-to-r from-purple-500 to-rose-500 bg-clip-text text-transparent">
                            PECAN
                        </span>
                    </h1>
                    <p className="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
                        Formula-grade telemetry platform. Monitor your vehicle in real-time,
                        analyze battery health, and build custom dashboards.
                    </p>
                </div>

                {/* Feature Cards Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {features.map((feature) => (
                        <FeatureCardComponent key={feature.path} feature={feature} />
                    ))}
                </div>

                {/* Footer tagline */}
                <div className="text-center mt-16 text-gray-500 text-sm">
                    Built by Western Formula Racing
                </div>
            </div>
        </div>
    );
}

export default Landing;
