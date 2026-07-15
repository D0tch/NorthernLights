import fs from 'fs';
import path from 'path';
import React from 'react';
import { fireEvent, render } from '@testing-library/react';

import { FadedHeroImage } from './FadedHeroImage';

describe('FadedHeroImage', () => {
  it('uses the shared wide hero classes and reveals the image after loading', () => {
    const { container } = render(<FadedHeroImage src="/artist.jpg" variant="wide" />);
    const hero = container.firstElementChild as HTMLElement;
    const image = hero.querySelector('img') as HTMLImageElement;

    expect(hero.className.split(' ')).toEqual(expect.arrayContaining(['faded-hero', 'faded-hero--wide']));
    expect(hero.getAttribute('style')).toBeNull();
    expect(image.className).not.toContain('is-loaded');
    expect(image.getAttribute('style')).toBeNull();

    fireEvent.load(image);

    expect(image.className.split(' ')).toEqual(expect.arrayContaining([
      'faded-hero__image',
      'faded-hero__image--wide',
      'is-loaded',
    ]));
  });

  it('keeps the hero blend and routed overlay scrollbar in global CSS', () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');

    expect(css).toMatch(/\.faded-hero\s*\{[^}]*mask-image:/s);
    expect(css).toMatch(/\.faded-hero__veil--wide\s*\{/);
    expect(css).toMatch(/\.app-scroll-viewport\s*\{[^}]*overflow-y:\s*auto;[^}]*overflow-y:\s*overlay;/s);
  });
});
