import { reeOpenGraphImage } from '@/lib/og/ree-image';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'RE0';

/** The public page's link preview (lib/og/ree-image.tsx). */
export default async function OpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  return reeOpenGraphImage((await params).slug);
}
