import type { Metadata } from 'next';
import { Playground } from '@/components/site/playground';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { playground } = await getMessages();
  return { title: playground.metaTitle, description: playground.metaDescription };
}

type Search = { searchParams: Promise<{ library?: string }> };

/** `?library=/owner/repo` pins the transcript to one public library (the detail page's entry). */
export default async function PlaygroundPage({ searchParams }: Search) {
  const [{ library }, { playground }] = await Promise.all([searchParams, getMessages()]);
  const initialLibrary = library && library.startsWith('/') ? library.slice(0, 256) : null;

  return (
    <section>
      <div className="mx-auto w-full max-w-[1200px] px-5 pt-14 pb-20">
        {/* The visible title lives in the empty transcript and leaves with the
            first question; the page keeps its heading for the whole session. */}
        <h1 className="sr-only">{playground.title}</h1>
        <Playground initialLibrary={initialLibrary} />
      </div>
    </section>
  );
}
