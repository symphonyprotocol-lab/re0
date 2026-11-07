import PublicReeImage from '@/app/(discover)/r/[slug]/opengraph-image';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'RE0';

/** The share link's preview is the public page's card (the video's first frame once there is one), so both links look the same wherever they land. */
export default function ShareImage(props: { params: Promise<{ slug: string }> }) {
  return PublicReeImage(props);
}
