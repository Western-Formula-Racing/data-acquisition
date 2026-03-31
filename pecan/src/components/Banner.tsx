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
            className={`flex flex-row w-[calc(100%-2rem)] max-w-4xl justify-center items-center box-border px-4 py-3 rounded-xl border gap-4 transition-all duration-300 shadow-xl backdrop-blur-md bg-[var(--color-data-module-bg)]/95 border-[var(--color-border-strong)] text-[var(--color-text-primary)] ${className}`}
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
