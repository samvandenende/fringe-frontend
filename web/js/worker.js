// Off-main-thread computation of array beams and expected images.
import { arrayPattern, expectedImage } from './model.js';

self.onmessage = ({ data }) => {
  const { id, kind, args } = data;
  try {
    const started = performance.now();
    let result;
    if (kind === 'beam') {
      result = arrayPattern(args.xs, args.ys, args.freq, args.size, 1);
      // Mask outside the visible hemisphere.
      for (let j = 0; j < args.size; j++) {
        const m = -1 + ((j + 0.5) * 2) / args.size;
        for (let i = 0; i < args.size; i++) {
          const l = -1 + ((i + 0.5) * 2) / args.size;
          if (l * l + m * m > 1) result[j * args.size + i] = NaN;
        }
      }
    } else if (kind === 'expected') {
      result = expectedImage(args);
    } else {
      throw new Error(`unknown job ${kind}`);
    }
    self.postMessage({ id, result, ms: performance.now() - started }, [result.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
