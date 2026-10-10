import { readPNG } from './png.mjs';
const im = readPNG(process.argv[2]); const [x0, x1, y0, y1, step] = process.argv.slice(3).map(Number);
const bg = im.px(x0, y0); const diff = (a) => Math.abs(a[0]-bg[0])+Math.abs(a[1]-bg[1])+Math.abs(a[2]-bg[2]);
for (let y = y0; y <= y1; y += step) { let L = -1, R = -1; for (let x = x0; x <= x1; x++) if (diff(im.px(x, y)) > 30) { if (L < 0) L = x; R = x; } console.log(y, L, R, R - L + 1); }
