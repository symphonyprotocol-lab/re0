import { BrandMark } from '@/components/ui/brand-mark';

/*
 * "RE0" as the site header sets it (site-shell.tsx `Wordmark`: `.wordmark`
 * in site.css, `.brand-zero` in globals.css): "RE" in Inter at weight 750,
 * the "0" in JetBrains Mono at 0.97em, -0.8px letter-spacing at 23px. The
 * glyphs are outlines, in units of 1/1000 em, so a card needs no font file
 * and none can fail to load: Inter 4 (Google Fonts, wght 750, opsz 14) and
 * JetBrains Mono (wght 750) instanced with fontTools' varLib.instancer and
 * drawn through SVGPathPen at the pen positions a browser gives them (no
 * R-E kerning). The box is the header's line box: the advance width, and
 * the body's 1.6 line-height around Inter's ascent and descent, so the
 * text centres on the icon as it does on the page.
 */
const WIDTH = 1746.2;
const TOP = -1163.3;
const HEIGHT = 1600;
const GLYPHS = [
  'M61 0V-727.5H352.1Q434.6 -727.5 493.4 -698.2Q552.2 -668.9 583.5 -615Q614.7 -561 614.7 -488.3Q614.7 -415 583 -362.5Q551.3 -310.1 491.5 -282.5Q431.6 -254.9 347.7 -254.9H156.7V-383.3H320.3Q363.3 -383.3 391.6 -395Q419.9 -406.7 434.3 -429.9Q448.7 -453.1 448.7 -488.3Q448.7 -523.9 434.3 -547.9Q419.9 -571.8 391.6 -584Q363.3 -596.2 319.8 -596.2H222.2V0ZM463.4 0 286.1 -331.5H459.5L640.6 0Z',
  'M685.9 0V-727.5H1182V-595.2H847.1V-432.1H1156.1V-302.7H847.1V-132.3H1182.5V0Z',
  'M1490 9.7Q1420.1 9.7 1368.7 -17Q1317.3 -43.6 1289.2 -91.2Q1261.1 -138.7 1261.1 -202.7V-505.4Q1261.1 -569.4 1289.2 -617.4Q1317.3 -665.4 1368.7 -691.6Q1420.1 -717.8 1490 -717.8Q1560.8 -717.8 1611.7 -691.6Q1662.6 -665.4 1690.8 -617.4Q1718.9 -569.4 1718.9 -505.4V-202.7Q1718.9 -138.7 1690.8 -91.2Q1662.6 -43.6 1611.7 -17Q1560.8 9.7 1490 9.7ZM1490 -105.7Q1538.5 -105.7 1566.1 -131.9Q1593.8 -158.1 1593.8 -202.7V-505.4Q1593.8 -550 1566.1 -576.2Q1538.5 -602.4 1490 -602.4Q1441.5 -602.4 1413.8 -576.2Q1386.2 -550 1386.2 -505.4V-202.7Q1386.2 -158.1 1414.3 -131.9Q1442.5 -105.7 1490 -105.7ZM1490 -289.1Q1460.9 -289.1 1442.5 -308Q1424 -326.9 1424 -357Q1424 -387 1442.5 -405Q1460.9 -422.9 1490 -422.9Q1520.1 -422.9 1538 -405Q1555.9 -387 1555.9 -357Q1555.9 -326.9 1538 -308Q1520.1 -289.1 1490 -289.1Z',
];

/**
 * The header's wordmark for the `next/og` cards: the mark, then "RE0", at
 * the header's proportions (23px text, 31px icon, 9px gap). `size` is the
 * text's font size; `color` its fill.
 */
export function OgWordmark({ size, color }: { size: number; color: string }) {
  const em = size / 1000;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: (size * 9) / 23 }}>
      <BrandMark size={(size * 31) / 23} />
      <svg width={WIDTH * em} height={HEIGHT * em} viewBox={`0 ${TOP} ${WIDTH} ${HEIGHT}`}>
        {GLYPHS.map((d) => (
          <path key={d.slice(0, 12)} d={d} fill={color} />
        ))}
      </svg>
    </div>
  );
}
