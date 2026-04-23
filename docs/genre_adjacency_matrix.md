# Genre Adjacency Matrix — Dynamic Hop-Cost System

Aurora uses the MusicBrainz hierarchy to keep recommendation jumps musically plausible without making playlists brittle. Genre is guidance, not a hard prison, and it is only one layer inside a larger library-relative recommendation system.

## 1. Hop Cost Model

Genre distance is computed from the Lowest Common Ancestor of two hierarchical paths, for example:

- `electronic.edm.house.progressive house`
- `rock.alternative rock.indie rock`

The deeper the shared ancestor, the cheaper the jump.

| Relationship | Shared Depth | Typical Hop Cost |
|---|---:|---:|
| Deep siblings | 3+ | `0.05` |
| Cousins | 2 | `0.20` |
| Same root only | 1 | `0.50` |
| Unrelated roots | 0 | `2.0` |

These costs are not stored as a static matrix. They are computed from the hierarchy at query time.

## 2. Penalty Formula

Genre-aware re-ranking scales vector distance with an exponential hop-cost penalty:

```ts
const combined = distance * Math.pow(1 + hopCost, weight * penaltyCurve);
```

Where:

- `distance` is the vector similarity distance
- `weight` is derived from `llmGenreCohesion`
- `penaltyCurve` is derived from `genrePenaltyCurve`

Backend mapping:

```ts
const weight = (llmGenreCohesion ?? 50) / 100;
const penaltyCurve = 0.5 + ((genrePenaltyCurve ?? 50) / 100) * 1.5;
```

Higher cohesion and higher penalty curve make cross-genre moves more expensive.

## 3. Taxonomy Resolution Pipeline

Aurora resolves local metadata into MusicBrainz paths with a three-step categorization system.

### 3.1 Direct SQL Match

Fast resolution through `genre_tree_paths` and alias lookups:

- exact path match
- alias match
- standalone genre with parent fallback
- standalone alias
- fuzzy tree match
- fuzzy alias match

### 3.2 Vocabulary-Guided LLM Classification

Unmapped local genres are batched through the LLM with a bounded hierarchy vocabulary:

- if the library has fewer than 300 mapped genres, use the real local vocabulary
- otherwise use the top 300 hierarchy entries

This keeps the LLM grounded in the actual taxonomy instead of inventing free-form genre strings.

### 3.3 KNN Fallback

If metadata is weak or missing, the system can recover by vector similarity:

- full 21D similarity when both 8D and MFCC/timbre data are present
- 8D fallback when only the acoustic vector is available

## 4. How Genre Adjacency Is Used in LLM Playlists

The LLM playlist system no longer relies on a simple two-pool model. Genre adjacency is now used in several stages:

1. **Concept compilation**
   - resolves target paths
   - measures primary genre health
   - expands into adjacent library-supported paths according to `llmAdjacentReach`

2. **Named pool construction**
   - `core`
   - `adjacent`
   - `root`
   - `acoustic`
   - `discovery`
   - `bridge`

3. **Recovery ladder**
   - `exact-path`
   - `adjacent-path`
   - `same-root`
   - `acoustic-similarity`
   - `mood-bridge`
   - `discovery-backfill`

4. **Final re-ranking**
   - hop-cost penalties still shape ranking while genre anchoring is active
   - later recovery levels intentionally reduce or remove anchor pressure

## 5. Banned Genre Handling

Each LLM concept can include `banned_genres`.

Aurora applies those bans against full hierarchical paths:

- banning `dance` excludes the whole `dance.*` subtree
- banning `rock` excludes `rock.*`

The compiler now also sanitizes target and adjacent paths that directly conflict with banned genres before candidate generation starts.

User setting:

- `llmVetoMode = hard`
  - banned genres are absolute exclusions
- `llmVetoMode = adaptive`
  - bans stay hard during normal generation, but can become strong penalties in late recovery when a playlist would otherwise fail

## 6. EffNet / Timbre Recovery

When a concept starts from 8D mood structure and lacks a strong high-dimensional timbre anchor, Aurora can synthesize a timbre centroid from nearby library tracks.

Safeguards:

- minimum seed count
- distance threshold / relative cliff checks
- no imputation when the neighborhood is too sparse or unstable

This keeps weak concepts from fabricating misleading timbre centroids.

## 7. Infinity Mode

Infinity Mode uses the same hop-cost and hierarchy logic, but in a track-to-track continuous-discovery context instead of a finite LLM playlist context. The goal is gradual drift through related areas of the library rather than a single compiled concept with explicit recovery stages.
