import React, { useState } from 'react';

interface FadedHeroImageProps {
    src: string;
    variant?: 'standard' | 'wide';
}

const fadeOverlayStyle: React.CSSProperties = {
    background: 'linear-gradient(to bottom, color-mix(in srgb, var(--color-bg) 55%, transparent) 0%, color-mix(in srgb, var(--color-bg) 20%, transparent) 35%, color-mix(in srgb, var(--color-bg) 24%, transparent) 55%, color-mix(in srgb, var(--color-bg) 88%, transparent) 78%, var(--color-bg) 100%)',
};

const wideMaskStyle: React.CSSProperties = {
    WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.96) 0%, rgba(0,0,0,0.84) 18%, rgba(0,0,0,0.52) 34%, rgba(0,0,0,0.20) 52%, transparent 72%)',
    maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.96) 0%, rgba(0,0,0,0.84) 18%, rgba(0,0,0,0.52) 34%, rgba(0,0,0,0.20) 52%, transparent 72%)',
};

export const FadedHeroImage: React.FC<FadedHeroImageProps> = ({ src, variant = 'standard' }) => {
    const [loaded, setLoaded] = useState(false);
    const isWide = variant === 'wide';

    return (
        <div className={`${isWide ? 'left-1/2 w-screen -translate-x-1/2 h-[32rem] md:h-[44rem]' : 'left-0 w-full h-[320px] md:h-[440px]'} absolute top-0 z-0 pointer-events-none overflow-hidden`}>
            <img
                src={src}
                alt=""
                aria-hidden="true"
                onLoad={() => setLoaded(true)}
                style={isWide ? wideMaskStyle : undefined}
                className={`h-full w-full object-cover transition-opacity duration-700 motion-reduce:transition-none ${loaded ? (isWide ? 'opacity-28 dark:opacity-24' : 'opacity-32 dark:opacity-22') : 'opacity-0'}`}
            />
            {isWide ? (
                <>
                    <div className="absolute inset-0 bg-gradient-to-b from-[var(--color-bg)]/12 via-transparent via-12% to-transparent" />
                    <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent via-24% to-[var(--color-bg)]/80" />
                    <div className="absolute bottom-0 left-0 h-44 md:h-56 w-full bg-gradient-to-t from-[var(--color-bg)] via-[var(--color-bg)]/94 via-46% to-transparent" />
                </>
            ) : (
                <div className="absolute inset-0" style={fadeOverlayStyle} />
            )}
        </div>
    );
};
