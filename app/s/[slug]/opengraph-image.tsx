import { reeOpenGraphImage } from '@/lib/og/ree-image';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'RE0';

/** The share link's preview: the public page's card (lib/og/ree-image.tsx). */
export default async function ShareImage({ params }: { params: Promise<{ slug: string }> }) {
  return reeOpenGraphImage((await params).slug);
}
