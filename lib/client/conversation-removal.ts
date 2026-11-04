/** Keep the rows mounted until every exit finishes, before refreshing the list. */
export async function animateConversationRemoval(rows: HTMLElement[], reducedMotion: boolean): Promise<void> {
  if (reducedMotion) return;
  await Promise.allSettled(rows.map(async (row) => {
    if (typeof row.animate !== 'function') return;
    const height = `${row.getBoundingClientRect().height}px`;
    await row.animate([
      { opacity: 1, transform: 'translateX(0)', height, minHeight: '0px', overflow: 'hidden', offset: 0 },
      { opacity: 0, transform: 'translateX(16px)', height, minHeight: '0px', overflow: 'hidden', offset: 0.55 },
      { opacity: 0, transform: 'translateX(16px)', height: '0px', minHeight: '0px', paddingTop: '0px', paddingBottom: '0px', borderBottomWidth: '0px', overflow: 'hidden', offset: 1 },
    ], { duration: 360, easing: 'ease-in-out', fill: 'forwards' }).finished;
  }));
}
