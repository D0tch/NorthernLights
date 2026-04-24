import React from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

interface BackButtonProps {
    onClick: () => void;
    children?: React.ReactNode;
}

type BackLocationState = {
    backLabel?: string;
};

export const BackButton: React.FC<BackButtonProps> = ({ onClick, children }) => {
    const location = useLocation();
    const state = location.state as BackLocationState | null;
    const label = children ?? state?.backLabel ?? 'Back to Library';

    return (
        <button
            onClick={onClick}
            className="mb-8 md:mb-12 inline-flex w-fit items-center gap-2 rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] px-3.5 py-2 text-sm font-semibold text-[var(--color-text-secondary)] shadow-[var(--shadow-sm)] backdrop-blur-xl transition-all duration-200 hover:border-[var(--glass-border-hover)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-primary)] active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] motion-reduce:transition-none motion-reduce:active:scale-100 md:px-4 md:text-base"
        >
            <ArrowLeft size={17} />
            <span>{label}</span>
        </button>
    );
};
