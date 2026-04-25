import React, { useState } from 'react';

interface FadedHeroImageProps {
    src: string;
}

const fadeOverlayStyle: React.CSSProperties = {
    background: 'linear-gradient(to bottom, color-mix(in srgb, var(--color-bg) 55%, transparent) 0%, color-mix(in srgb, var(--color-bg) 20%, transparent) 35%, color-mix(in srgb, var(--color-bg) 24%, transparent) 55%, color-mix(in srgb, var(--color-bg) 88%, transparent) 78%, var(--color-bg) 100%)',
};

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
            <div className="absolute inset-0" style={fadeOverlayStyle} />
        </div>
    );
};
