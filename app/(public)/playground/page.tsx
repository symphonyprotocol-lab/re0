import type { Metadata } from 'next';
import { Playground } from '@/components/site/playground';
import { optionalSession } from '@/lib/http/session';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { playground } = await getMessages();
  return { title: playground.metaTitle, description: playground.metaDescription };
}

type Search = { searchParams: Promise<{ library?: string }> };

/**
 * `?library=/owner/repo` pins the transcript to one public library (the detail page's entry).
 *
 * Open to everyone to look at; asking needs a session. A visitor without
 * one is shown the sign-in dialog when they send (components/site/playground),
 * and the route refuses them regardless (`playgroundCaller`) -- the page only
 * decides which of the two they meet first.
 */
export default async function PlaygroundPage({ searchParams }: Search) {
  const [{ library }, { playground }, session] = await Promise.all([
    searchParams,
    getMessages(),
    optionalSession(),
  ]);
  const initialLibrary = library && library.startsWith('/') ? library.slice(0, 256) : null;

  return (
    <section>
      <div className="mx-auto w-full max-w-[1200px] px-5 pt-14 pb-20">
        {/* The visible title lives in the empty transcript and leaves with the
            first question; the page keeps its heading for the whole session. */}
        <h1 className="sr-only">{playground.title}</h1>
        <Playground initialLibrary={initialLibrary} signedIn={session !== null} />
      </div>
    </section>
  );
}
