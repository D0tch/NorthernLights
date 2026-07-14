import React, { useState } from 'react';
import { ArtistEntitiesTab } from './ArtistEntitiesTab';
import { GenreEntitiesTab } from './GenreEntitiesTab';

type EntitySection = 'artists' | 'genres';

export const LibraryEntitiesTab: React.FC = () => {
  const [section, setSection] = useState<EntitySection>('artists');

  return (
    <div className="settings-section mb-8">
      <div className="settings-section-header mb-4">
        <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Library Entities</h3>
      </div>

      <div className="flex flex-wrap gap-2 mb-6" role="tablist" aria-label="Library entity type">
        <button
          type="button"
          role="tab"
          id="library-entities-artists-tab"
          aria-controls="library-entities-artists-panel"
          aria-selected={section === 'artists'}
          className={`btn-tab ${section === 'artists' ? 'active' : ''}`}
          onClick={() => setSection('artists')}
        >
          Artists
        </button>
        <button
          type="button"
          role="tab"
          id="library-entities-genres-tab"
          aria-controls="library-entities-genres-panel"
          aria-selected={section === 'genres'}
          className={`btn-tab ${section === 'genres' ? 'active' : ''}`}
          onClick={() => setSection('genres')}
        >
          Genres
        </button>
      </div>

      <div
        role="tabpanel"
        id={`library-entities-${section}-panel`}
        aria-labelledby={`library-entities-${section}-tab`}
      >
        {section === 'artists' ? <ArtistEntitiesTab /> : <GenreEntitiesTab />}
      </div>
    </div>
  );
};
