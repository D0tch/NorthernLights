import { Router } from 'express';
import { getPlaylists } from '../database';
import { generateCustomPlaylist } from '../services/llm.service';
import { getHubCollections } from '../services/recommendation.service';
import { getLlmPlaylistSettings, queueLlmHubRefreshForUser, runLlmHubRegeneration } from '../services/hubRefresh.service';

const router = Router();

// Get Hub Data (per-user)
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    queueLlmHubRefreshForUser(userId, 'hub-view');
    const collections = await getHubCollections([], userId);
    res.json({ collections });
  } catch (error) {
    console.error('Hub fetch error:', error);
    res.status(500).json({ error: 'Failed to generate hub' });
  }
});

// Trigger LLM Hub Regeneration explicitly (per-user)
router.post('/regenerate', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { force } = req.body;
    const result = await runLlmHubRegeneration(userId, { force: !!force, source: 'manual' });
    res.json(result);
  } catch (error) {
    console.error('Hub regeneration error:', error);
    res.status(500).json({ error: 'Failed to regenerate hub' });
  }
});

// Generate a single custom playlist from a user prompt
router.post('/generate-custom', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'A prompt is required' });
    }
    const hubSettings = await getLlmPlaylistSettings(userId);
    const existingPlaylists = await getPlaylists(userId);
    const existingIds = new Set(existingPlaylists.map((playlist: any) => playlist.id));

    let playlist = null;
    let attempts = 0;
    while (attempts < 3) {
      const concept = await generateCustomPlaylist(prompt.trim());
      if (!concept) {
        attempts++;
        continue;
      }
      
      const saved = await getHubCollections([concept], userId, {
        ...hubSettings,
        llmGenerationSource: 'custom',
      });
      playlist = saved.find((candidate: any) => candidate.isLlmGenerated && candidate.id && !existingIds.has(candidate.id));
      
      if (!playlist || (concept as any).dropped) {
        console.warn(`[LLM Hub] Custom concept failed/dropped on attempt ${attempts + 1}. Retrying...`);
        attempts++;
        if (attempts < 3) await new Promise(r => setTimeout(r, 2000)); // Backoff
        continue;
      }
      break; // Success
    }

    if (!playlist) {
      return res.status(503).json({ error: 'LLM generated genres could not be matched after 3 retries or failed completely.' });
    }

    res.json({ playlist });
  } catch (error) {
    console.error('Custom playlist generation error:', error);
    res.status(500).json({ error: 'Failed to generate custom playlist' });
  }
});

export default router;
