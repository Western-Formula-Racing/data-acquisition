import { type ButtonHTMLAttributes, type ElementType, type ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement | HTMLLabelElement> {
    variant?: 'primary' | 'danger' | 'secondary';
    as?: ElementType;
    children: ReactNode;
    htmlFor?: string; // For label support
}

export function Button({
    variant = 'primary',
    as: Component = 'button',
    className = '',
    style,
    children,
    ...props
}: ButtonProps) {

    const baseStyles = "px-4 py-1.5 cursor-pointer text-center text-sm font-semibold text-white rounded-md transition-colors shadow-sm flex items-center justify-center";

    const variantStyles = {
        primary: "bg-banner-button hover:bg-banner-button-hover",
        danger: "bg-red-600 hover:bg-red-700",
        secondary: "bg-gray-600 hover:bg-gray-700"
    };

    return (
        <Component
            className={`${baseStyles} ${variantStyles[variant]} ${className}`}
            style={{ borderRadius: "0.375rem", ...style }}
            {...props}
        >
            {children}
        </Component>
    );
}
