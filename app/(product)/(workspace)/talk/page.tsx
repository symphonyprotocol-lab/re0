import { redirect } from 'next/navigation';

/**
 * `/talk` was a new conversation. Private questions are private posts now
 * (2026-11-20), so old links and the sidebar's habit open the composer's
 * 私密提问 on 首页 instead. `?new=1` (the old 新建对话) asked for an empty
 * draft; the composer always starts empty, so it lands in the same place.
 */
export default function TalkPage() {
  redirect('/?compose=private');
}
