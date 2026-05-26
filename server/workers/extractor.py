import sys
import json
import subprocess
import time
import numpy as np
from essentia.standard import (
    TensorflowPredictMusiCNN, 
    TensorflowPredictEffnetDiscogs,
    Energy, DynamicComplexity, PitchSalience, Flux, ZeroCrossingRate, RhythmExtractor2013, SpectralCentroidTime
)

ANALYSIS_DURATION_SECONDS = 15.0
ANALYSIS_SEEK_FRACTION = 0.35
MIN_AUDIO_SAMPLES = 4096
FFMPEG_TIMEOUT_SECONDS = 60

class PersistentExtractor:
    def __init__(self, musicnn_pb, effnet_pb):
        self.musicnn_pb = musicnn_pb
        self.effnet_pb = effnet_pb
        self.init_error = None
        self.effnet_model = None
        self.musicnn_model = None
        self._init_models()

    def _init_models(self):
        started = time.perf_counter()
        try:
            self.effnet_model = TensorflowPredictEffnetDiscogs(
                graphFilename=self.effnet_pb,
                output="PartitionedCall:1"
            )
            self.musicnn_model = TensorflowPredictMusiCNN(graphFilename=self.musicnn_pb)
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            print(json.dumps({"event": "ready", "timings": {"model_init_ms": elapsed_ms}}), file=sys.stderr, flush=True)
        except Exception as e:
            self.init_error = str(e)
            print(json.dumps({"event": "init_error", "error": self.init_error}), file=sys.stderr, flush=True)

    def extract_features(self, file_path):
        if self.init_error:
            raise RuntimeError(f"Model initialization failed: {self.init_error}")
        if self.effnet_model is None or self.musicnn_model is None:
            raise RuntimeError("Model initialization failed")

        timings = {}
        total_started = time.perf_counter()

        def mark(stage, started):
            timings[f"{stage}_ms"] = round((time.perf_counter() - started) * 1000, 2)

        started = time.perf_counter()
        duration = probe_duration(file_path)
        start_time = choose_analysis_start(duration)
        timings["duration_probe_ms"] = round((time.perf_counter() - started) * 1000, 2)
        timings["source_duration_seconds"] = round(duration, 3) if duration is not None else None
        timings["analysis_start_seconds"] = round(start_time, 3)
        timings["analysis_duration_seconds"] = ANALYSIS_DURATION_SECONDS

        # 1. Load an analysis window for ML (16kHz required by MusiCNN and EffNet)
        started = time.perf_counter()
        audio_16k = decode_audio_window(file_path, 16000, start_time)
        mark("audio_16k_load", started)

        # 2. Discogs-EffNet (1280D Neural Embedding)
        started = time.perf_counter()
        embeddings = self.effnet_model(audio_16k)
        # Average frame-wise embeddings and L2 normalize for Cosine Distance
        mean_emb = np.mean(embeddings, axis=0)
        norm = np.linalg.norm(mean_emb)
        effnet_vector = (mean_emb / norm).tolist() if norm > 0 else mean_emb.tolist()
        mark("effnet", started)

        # 3. MusiCNN (Classification Tags)
        started = time.perf_counter()
        tags = self.musicnn_model(audio_16k)
        mean_tags = np.mean(tags, axis=0)
        mark("musicnn", started)

        # MusiCNN indices (based on MSD tag mappings)
        acousticness = float(mean_tags[29])
        instrumentalness = float(mean_tags[23])
        danceability = float(mean_tags[49]) # 'Danceable' tag

        # 4. Standard DSP Features (Requires 44.1kHz for accurate spectral data)
        started = time.perf_counter()
        audio_44k = decode_audio_window(file_path, 44100, start_time)
        mark("audio_44k_load", started)

        started = time.perf_counter()
        energy = float(Energy()(audio_44k))
        centroid = float(SpectralCentroidTime()(audio_44k))
        percussiveness = float(DynamicComplexity()(audio_44k)[0])
        zcr = float(ZeroCrossingRate()(audio_44k))
        bpm = float(RhythmExtractor2013()(audio_44k)[0])
        mark("dsp", started)

        # Calculate safe Z-Scores (using neutral fallbacks for simplicity, matching your JS logic)
        def z_score(val, max_val):
            return max(0.0, min(1.0, val / max_val))

        acoustic_vector = [
            z_score(energy, 100),            # Energy
            z_score(centroid, 10000),        # Brightness
            z_score(percussiveness, 50),     # Percussiveness
            0.5,                             # Pitch Salience (Simplified)
            instrumentalness,                # Instrumentalness (ML)
            acousticness,                    # Acousticness (ML)
            danceability,                    # Danceability (ML)
            z_score(bpm, 200)                # Tempo
        ]

        timings["total_ms"] = round((time.perf_counter() - total_started) * 1000, 2)

        return {
            "audioFeatures": {
                "bpm": round(bpm),
                "acoustic_vector": acoustic_vector,
                "embedding_vector": effnet_vector,
                "is_simulated": False
            },
            "timings": timings
        }

def probe_duration(file_path):
    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                file_path,
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        value = float(proc.stdout.strip())
        return value if np.isfinite(value) and value > 0 else None
    except Exception:
        return None

def choose_analysis_start(duration):
    if duration is None or duration <= ANALYSIS_DURATION_SECONDS:
        return 0.0
    preferred = duration * ANALYSIS_SEEK_FRACTION
    latest = max(0.0, duration - ANALYSIS_DURATION_SECONDS)
    return min(preferred, latest)

def decode_audio_window(file_path, sample_rate, start_time):
    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel", "error",
                "-ss", f"{start_time:.3f}",
                "-i", file_path,
                "-t", f"{ANALYSIS_DURATION_SECONDS:.3f}",
                "-f", "f32le",
                "-ac", "1",
                "-ar", str(sample_rate),
                "pipe:1",
            ],
            check=True,
            capture_output=True,
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"ffmpeg segment decode timed out after {FFMPEG_TIMEOUT_SECONDS}s") from e
    except subprocess.CalledProcessError as e:
        message = e.stderr.decode("utf8", errors="replace").strip()
        raise RuntimeError(f"ffmpeg segment decode failed: {message or e}") from e

    audio = np.frombuffer(proc.stdout, dtype=np.float32).copy()
    if len(audio) < MIN_AUDIO_SAMPLES:
        raise RuntimeError(f"Decoded audio window too short: {len(audio)} samples")
    return audio

def extract_features(file_path, musicnn_pb, effnet_pb):
    try:
        extractor = PersistentExtractor(musicnn_pb, effnet_pb)
        print(json.dumps(extractor.extract_features(file_path)["audioFeatures"]))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

def worker_mode(musicnn_pb, effnet_pb):
    extractor = PersistentExtractor(musicnn_pb, effnet_pb)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            job = json.loads(line)
            job_id = job.get("id")
            file_path = job.get("filePath")
            if not job_id or not file_path:
                raise ValueError("Job requires id and filePath")
            result = extractor.extract_features(file_path)
            print(json.dumps({
                "id": job_id,
                "audioFeatures": result["audioFeatures"],
                "timings": result["timings"]
            }), flush=True)
        except Exception as e:
            fallback_id = None
            try:
                fallback_id = job.get("id")
            except Exception:
                pass
            print(json.dumps({"id": fallback_id, "error": str(e)}), flush=True)

if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--worker":
        worker_mode(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 4:
        extract_features(sys.argv[1], sys.argv[2], sys.argv[3])
    else:
        print(json.dumps({"error": "Missing arguments"}), file=sys.stderr)
        sys.exit(1)
