/**
 * A minimal text PDF writer for tests: one Helvetica page per entry, one
 * line per string (ASCII). Used as the bytes uploaded to the fake Firecrawl
 * endpoint; its per-page response comes from the same handbook fixture.
 */
export function makePdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  const pageIds: number[] = [];
  /* 1: catalog, 2: pages, 3: font; then a content + page object per page. */
  const fontId = 3;
  let next = 4;
  const bodies: { id: number; body: string }[] = [];
  for (const lines of pages) {
    const escaped = lines.map((line) => line.replace(/[\\()]/g, (c) => `\\${c}`));
    const stream = `BT /F1 11 Tf 14 TL 56 780 Td ${escaped.map((line) => `(${line}) Tj T*`).join(' ')} ET`;
    const contentId = next++;
    const pageId = next++;
    bodies.push({ id: contentId, body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream` });
    bodies.push({
      id: pageId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    });
    pageIds.push(pageId);
  }
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (const { id, body } of bodies) objects[id] = body;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** Thirty pages about a fictional product, each with one fact only that page states. */
export function handbookPages(): string[][] {
  const topics = [
    'Onboarding', 'Billing', 'Refunds', 'Security', 'Exports', 'Teams', 'Roles', 'Integrations', 'Webhooks', 'Limits',
    'Search', 'Backups', 'Retention', 'Privacy', 'Support', 'Status page', 'Releases', 'Mobile app', 'Offline mode', 'Accessibility',
    'Localization', 'Audit log', 'Single sign-on', 'API keys', 'Rate limits', 'Storage', 'Notifications', 'Templates', 'Archiving', 'Glossary',
  ];
  return topics.map((topic, index) => [
    `Northwind Handbook - Chapter ${index + 1}: ${topic}`,
    '',
    `This chapter explains how ${topic.toLowerCase()} works in the Northwind workspace.`,
    `Key fact ${index + 1}: the ${topic.toLowerCase()} setting is managed by the workspace owner,`,
    `and changes take effect within ${index + 2} minutes for every member.`,
    index === 2 ? 'Refunds are issued to the original payment method within 14 days of the request.' : `The ${topic.toLowerCase()} policy was last reviewed in review cycle ${index + 7}.`,
    'Members can find the current configuration under Settings in the workspace sidebar.',
    'When in doubt, contact the workspace owner before changing anything shared.',
    ...Array.from({ length: 2 }, (_, line) => `Detail ${line + 1} about ${topic.toLowerCase()}: keep records tidy and consistent across teams.`),
  ]);
}
