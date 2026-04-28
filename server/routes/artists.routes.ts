import { Router } from 'express';
import { getArtistById, getAllArtists, getTracksByArtist, getSimilarArtistsByAudioProfile } from '../database';

const router = Router();

// Artists
router.get('/', async (req, res) => {
  try {
    const artists = await getAllArtists();
    res.json(artists);
  } catch (error) {
    console.error('Artists fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch artists' });
  }
});

router.get('/:id/similar', async (req, res) => {
  try {
    const artist = await getArtistById(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 8;
    const similarArtists = await getSimilarArtistsByAudioProfile(
      req.params.id,
      Number.isFinite(rawLimit) ? rawLimit : 8
    );
    res.json({ artists: similarArtists });
  } catch (error) {
    console.error('Similar artists fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch similar artists' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const artist = await getArtistById(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });
    const tracks = await getTracksByArtist(req.params.id);
    res.json({ ...artist, tracks });
  } catch (error) {
    console.error('Artist fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch artist' });
  }
});

export default router;
