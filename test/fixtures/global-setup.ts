import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'test/fixtures/out');
const SENTINELS = ['sample.mp4', 'hls/variants/hi_000.ts', 'hls/id3/seg_000.ts'];

// Runs once before all test files: make.sh wipes out/, so parallel workers must never run it.
// Without FFmpeg the fixture-backed suites skip themselves.
export default function setup(): void {
  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  if (hasFfmpeg && SENTINELS.some((f) => !existsSync(path.join(OUT, f)))) {
    execFileSync('bash', [path.join(ROOT, 'test/fixtures/make.sh')], { stdio: 'inherit' });
  }
}
