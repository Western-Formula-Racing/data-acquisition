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
    accentBorder: string;
    accentGlow: string;
    accentBg: string;
    iconColor: string;
    isPending?: boolean;
}

const features: FeatureCard[] = [
    {
        title: "Live Dashboard",
        description: "Real-time telemetry monitoring with customizable data modules and live signal visualization.",
        icon: LayoutDashboard,
        path: "/dashboard",
        accentBorder: "border-violet-400/35",
        accentGlow: "hover:shadow-violet-500/15",
        accentBg: "from-violet-500/8 to-violet-700/4",
        iconColor: "text-violet-400",
    },
    {
        title: "Accumulator",
        description: "Battery cell health monitoring with voltage tracking, temperature alerts, and pack overview.",
        icon: Battery,
        path: "/accumulator",
        accentBorder: "border-emerald-400/35",
        accentGlow: "hover:shadow-emerald-500/15",
        accentBg: "from-emerald-500/8 to-teal-600/4",
        iconColor: "text-emerald-400",
    },
    {
        title: "Monitor Builder",
        description: "Create custom monitoring layouts with drag-and-drop signal configuration.",
        icon: Wrench,
        path: "/monitor-builder",
        accentBorder: "border-orange-400/35",
        accentGlow: "hover:shadow-orange-500/15",
        accentBg: "from-orange-500/8 to-amber-600/4",
        iconColor: "text-orange-400",
    },
    {
        title: "SystemLink",
        description: "System diagnostics, data playback, and integration status overview.",
        icon: Link2,
        path: "/system-link",
        accentBorder: "border-blue-400/35",
        accentGlow: "hover:shadow-blue-500/15",
        accentBg: "from-blue-500/8 to-cyan-600/4",
        iconColor: "text-blue-400",
    },
    {
        title: "CAN Trace",
      description: "Live timestamped log of every raw CAN frame, with scroll and fixed views, delta timing, and CSV export.",
        icon: ScrollText,
        path: "/trace",
                accentBorder: "border-cyan-400/35",
                accentGlow: "hover:shadow-cyan-500/15",
                accentBg: "from-cyan-500/8 to-teal-600/4",
        iconColor: "text-cyan-400",
    },
    {
        title: "ChargeCart",
        description: "Charging session management and power delivery monitoring.",
        icon: Zap,
        path: "/chargecart",
        accentBorder: "border-yellow-400/35",
        accentGlow: "hover:shadow-yellow-500/15",
        accentBg: "from-yellow-500/8 to-orange-600/4",
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
        group relative overflow-hidden min-h-[220px]
        bg-data-module-bg
        bg-gradient-to-br ${feature.accentBg}
        border ${feature.accentBorder}
        p-5 md:p-6
        text-left
        transition-all duration-250 ease-out
        hover:-translate-y-0.5 hover:border-white/25
        hover:shadow-xl ${feature.accentGlow}
        focus:outline-none focus:ring-2 focus:ring-white/30
        cursor-pointer
        ${feature.isPending ? "opacity-60" : ""}
      `}
        >
            <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            <div className="absolute left-0 top-0 h-full w-[3px] bg-white/20 group-hover:bg-white/40 transition-colors" />

            {/* Icon */}
            <div className={`mb-3 ${feature.iconColor}`}>
                <Icon
                    size={30}
                    strokeWidth={1.5}
                    className="transform group-hover:scale-105 transition-transform duration-300"
                />
            </div>

            {/* Title */}
            <h3 className="app-section-title text-white mb-2 flex items-center gap-2">
                {feature.title}
                {feature.isPending && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-yellow-500/15 border border-yellow-500/25 text-yellow-400 font-semibold uppercase tracking-wide">
                        Coming Soon
                    </span>
                )}
            </h3>

            {/* Description */}
            <p className="text-sm text-slate-400 leading-relaxed">
                {feature.description}
            </p>

            {/* Arrow indicator */}
            <div className="absolute bottom-5 right-5 text-white/25 group-hover:text-white/55 group-hover:translate-x-1 transition-all duration-300">
                →
            </div>
        </button>
    );
}

function Landing() {
    return (
        <div className="h-full overflow-y-auto bg-background">
            <div className="max-w-6xl mx-auto px-6 py-12 md:py-14">
                {/* Hero Section */}
                <div className="text-center mb-10 md:mb-12">
                    <h1 className="app-menu-title uppercase mb-3">
                        Project{" "}
                        <span className="bg-gradient-to-r from-purple-500 to-rose-500 bg-clip-text text-transparent">
                            PECAN
                        </span>
                    </h1>
                    <p className="text-base md:text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
                        Formula-grade telemetry platform. Monitor your vehicle in real-time,
                        analyze battery health, and build custom dashboards.
                    </p>
                </div>

                {/* Feature Cards Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                    {features.map((feature) => (
                        <FeatureCardComponent key={feature.path} feature={feature} />
                    ))}
                </div>

                {/* Footer tagline */}
                <div className="text-center mt-12 text-slate-500 text-sm font-mono">
                    Built by Western Formula Racing
                </div>
            </div>
        </div>
    );
}

export default Landing;
