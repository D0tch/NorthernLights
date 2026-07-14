import React, { useState } from 'react';

interface FadedHeroImageProps {
    src: string;
    variant?: 'standard' | 'wide';
}

export const FadedHeroImage: React.FC<FadedHeroImageProps> = ({ src, variant = 'standard' }) => {
    const [loaded, setLoaded] = useState(false);

    return (
        <div className={`faded-hero faded-hero--${variant}`}>
            <img
                src={src}
                alt=""
                aria-hidden="true"
                onLoad={() => setLoaded(true)}
                className={`faded-hero__image faded-hero__image--${variant} ${loaded ? 'is-loaded' : ''}`}
            />
            <div className={`faded-hero__veil faded-hero__veil--${variant}`} />
        </div>
    );
};
