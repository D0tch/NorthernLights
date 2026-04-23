import React, { useState } from 'react';

interface FadedHeroImageProps {
    src: string;
}

export const FadedHeroImage: React.FC<FadedHeroImageProps> = ({ src }) => {
    const [loaded, setLoaded] = useState(false);

    return (
        <div className="absolute top-0 left-0 w-full h-[320px] md:h-[440px] z-0 pointer-events-none overflow-hidden">
            <img
                src={src}
                alt=""
                aria-hidden="true"
                onLoad={() => setLoaded(true)}
                className={`w-full h-full object-cover transition-opacity duration-700 motion-reduce:transition-none ${loaded ? 'opacity-32 dark:opacity-22' : 'opacity-0'}`}
            />
            <div className="absolute inset-0 bg-gradient-to-b from-[var(--color-bg)]/55 via-[var(--color-bg)]/20 via-35% to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[var(--color-bg)]/24 via-55% to-[var(--color-bg)]/82" />
            <div className="absolute bottom-0 left-0 w-full h-32 md:h-40 bg-gradient-to-t from-[var(--color-bg)] via-[var(--color-bg)]/88 via-45% to-transparent" />
            <div className="absolute bottom-0 left-0 w-full h-20 md:h-24 bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,0.08)_0%,transparent_70%)] dark:bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.05)_0%,transparent_70%)]" />
        </div>
    );
};
