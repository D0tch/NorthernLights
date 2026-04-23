# Smart Music Recommendation Engine

The recommendation engine is now built around a **library-relative** model: every playlist concept is interpreted in the context of the actual local library rather than as a genre-absolute request. That allows the same system to recover gracefully on a 500-track library, a 22k-track library, or a very skewed personal collection.

## 1. Core Architecture
- **8D Acoustic Vectors**: High-level rhythmic and stylistic features stored as `acoustic_vector_8d`.
- **1280D Discogs-EffNet Embeddings**: High-fidelity timbre / production embeddings stored as `embedding_vector`.
- **Library Profile Layer**: Cached local-library diagnostics including analyzed coverage, artist entropy, vector percentiles, and per-genre health.
- **MusicBrainz Genre Tree**: Hierarchical path resolution and hop-cost math for genre-aware search and veto logic.
- **pgvector + HNSW**: Native PostgreSQL ANN search across both the 8D and 1280D spaces.

## 2. Database / Feature Schema

All similarity data lives in `track_features`:

- `track_id`: FK to `tracks`
- `acoustic_vector_8d`: `VECTOR(8)` using Euclidean distance (`<->`)
- `embedding_vector`: `VECTOR(1280)` using cosine distance (`<=>`)
- `is_simulated`: fallback-analysis marker

The 8D acoustic vector is:

`[energy, brightness, percussiveness, pitch_salience, instrumentalness, acousticness, danceability, tempo]`

The 1280D embedding is used for fine-grained timbre / production similarity.

## 3. Library-Relative LLM Pipeline

Hub playlist generation now follows these phases:

### 3.1 Concept Compilation
Raw LLM concepts are passed through `llmConceptCompiler.service.ts`, which:
- resolves `target_genres` to MusicBrainz paths
- removes paths that directly conflict with `banned_genres`
- picks a primary path using **specificity + local health + target order**
- expands into nearby locally-supported genre paths
- adapts the 8D target vector to local library percentiles
- generates a bridge vector toward the library mainstream
- scores concept quality and can reject broad, generic concepts for regeneration

### 3.2 Named Candidate Pools
The engine fetches several explicit pools instead of relying on the older two-pool model:

- `core`: exact target paths
- `adjacent`: nearby genre paths allowed by hop cost and local health
- `root`: same-root fallback
- `acoustic`: best vector/EffNet matches regardless of genre
- `discovery`: lower-played / long-unheard candidates
- `bridge`: tracks that sit between the concept vector and the local mainstream

### 3.3 Relaxation Ladder
Pools are enabled in a fixed order:

`exact-path` → `adjacent-path` → `same-root` → `acoustic-similarity` → `mood-bridge` → `discovery-backfill`

The ladder stops at the first stage that yields enough distinct songs and artists **after** banned-genre filters and cross-playlist exclusions are applied.

### 3.4 Re-ranking and Recovery
The main re-rank score is still based on hop-cost-aware distance:

```ts
combined = distance * Math.pow(1 + hopCost, genreWeight * penaltyCurve)
```

But the modern engine also includes:
- hard or adaptive banned-genre handling (`llmVetoMode`)
- multi-root-safe reranking for concepts like `jazz + soul`
- anchor fallback when strict anchored rerank overconstrains a still-healthy admissible pool
- direct admissible-set fallback when rerank stages collapse unexpectedly

## 4. EffNet Imputation

Because the LLM only supplies an 8D target vector, the engine imputes a 1280D embedding target:

1. Find the nearest 20 tracks in 8D space
2. Abort if the neighborhood fails a relative-cliff / sparsity check
3. Average and L2-normalize their `embedding_vector` values

This gives the high-dimensional search a timbre-aware target even though the LLM never emitted one directly.

## 5. Final Selector

The final playlist is not built by naive top-N selection. The selector now optimizes for:

- same-song deduplication (MBID or normalized artist/title)
- cross-playlist deduplication
- artist spread
- album spread
- genre-root spread
- pool-balance targets
- acoustic-cluster variety
- novelty / discovery bonuses
- controlled randomness

Every playlist also emits diagnostics:
- pool sizes
- relaxation level reached
- selected pool mix
- distinct artists / albums / roots / pools / clusters
- mean pairwise acoustic distance
- final diversity score

## 6. Quality / Sanitization Passes

To stop bad concepts from turning into weak playlists, the pipeline now includes:

- **concept-quality gating** for broad generic genre plans
- **target / adjacent conflict cleanup** against banned genres
- **long-playlist quality floors** that trigger a second-pass refill when 20-track playlists come back with poor artist spread or low diversity

## 7. Infinity Mode

Infinity Mode remains separate from the LLM Hub flow, but it reuses the same family of ideas:

1. weighted-decay centroid over recent tracks
2. genre-aware penalty model
3. gradual relaxation when the immediate search pool is too small

## 8. Deduplication & Anti-Repetition
- normalized title matching blocks duplicate song variants
- artist repetition is capped, then relaxed only if the pool is truly sparse
- LLM playlists are deduplicated against each other during a generation pass
