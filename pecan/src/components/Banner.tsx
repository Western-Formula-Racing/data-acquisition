import type { ReactNode } from "react";

export interface BannerProps {
    open: boolean;
    children: ReactNode;
    className?: string; // Allow custom classes (e.g. z-index)
}

export function Banner({ open, children, className = "" }: BannerProps) {
    if (!open) return null;

    return (
        <div
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-row w-[calc(100%-2rem)] max-w-4xl bg-dropdown-menu-bg justify-center items-center box-border px-6 py-4 shadow-2xl rounded-2xl border border-gray-600/50 backdrop-blur-md gap-8 transition-all duration-300 ${className}`}
        >
            {children}
        </div>
    );
}

export interface BannerButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    children: ReactNode;
}

export function BannerButton({ children, className = "", ...props }: BannerButtonProps) {
    return (
        <button
            className={`bg-banner-button hover:bg-banner-button-hover px-4 py-2 cursor-pointer text-center text-[12pt] font-semibold text-white rounded-md transition-colors shadow-sm whitespace-nowrap ${className}`}
            style={{ borderRadius: '0.375rem' }}
            {...props}
        >
            {children}
        </button>
    );
}
