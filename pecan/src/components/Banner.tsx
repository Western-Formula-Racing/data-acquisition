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
            className={`fixed bottom-0 left-0 right-0 z-50 flex flex-row w-full bg-dropdown-menu-bg justify-center items-center box-border px-4 py-3 shadow-lg border-t border-gray-600 gap-8 ${className}`}
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
