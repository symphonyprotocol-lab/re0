/**
 * The article editor (agent-first-proposal.md 6.5): what its toolbar does to
 * the text, where an uploaded image's reference lands, the alt text an image
 * starts with, and which dashboard routes go without the workspace rail.
 */
import { describe, expect, it } from 'vitest';
import { altFromFileName, blockEdit, formatEdit, type TextEdit } from '@/components/creator/markdown-format';
import { isFocusedRoute } from '@/components/dashboard/columns';
import { indexedBody, referencedMedia } from '@/lib/domain/editorial';

/** The text after an edit, and what is selected in it. */
function run(value: string, edit: TextEdit): { text: string; selected: string } {
  const text = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
  return { text, selected: text.slice(edit.selectStart, edit.selectEnd) };
}

/** `value` with `[` and `]` marking the selection. */
function at(marked: string): [string, number, number] {
  const start = marked.indexOf('[');
  const end = marked.indexOf(']') - 1;
  return [marked.replace('[', '').replace(']', ''), start, end];
}

describe('the editor toolbar', () => {
  it('wraps a selection in emphasis and takes it off again', () => {
    const [value, start, end] = at('say [hello] now');
    const bold = run(value, formatEdit(value, start, end, 'bold', 'text'));
    expect(bold).toEqual({ text: 'say **hello** now', selected: 'hello' });
    const again = formatEdit(bold.text, 6, 11, 'bold', 'text');
    expect(run(bold.text, again)).toEqual({ text: 'say hello now', selected: 'hello' });
    expect(run(value, formatEdit(value, start, end, 'italic', 'text')).text).toBe('say *hello* now');
    /* Italic inside bold adds italic; it does not strip one of the bold stars. */
    expect(run(bold.text, formatEdit(bold.text, 6, 11, 'italic', 'text')).text).toBe('say ***hello*** now');
  });

  it('inserts a selected placeholder when nothing is selected', () => {
    expect(run('ab', formatEdit('ab', 1, 1, 'bold', 'text'))).toEqual({ text: 'a**text**b', selected: 'text' });
    expect(run('', formatEdit('', 0, 0, 'code', 'text'))).toEqual({ text: '`text`', selected: 'text' });
  });

  it('fences a multi-line selection as a code block', () => {
    const value = 'intro\nconst a = 1;\nconst b = 2;';
    const result = run(value, formatEdit(value, 6, value.length, 'code', 'text'));
    expect(result.text).toBe('intro\n```\nconst a = 1;\nconst b = 2;\n```\n');
    expect(result.selected).toBe('const a = 1;\nconst b = 2;');
  });

  it('makes a link of the selection and leaves the address to type', () => {
    const [value, start, end] = at('see [the docs] here');
    expect(run(value, formatEdit(value, start, end, 'link', 'text'))).toEqual({ text: 'see [the docs](https://) here', selected: 'https://' });
    expect(run('', formatEdit('', 0, 0, 'link', 'text'))).toEqual({ text: '[text](https://)', selected: 'text' });
  });

  it('prefixes the lines a selection touches, skips blank ones, and toggles back', () => {
    const value = 'one\n\ntwo\nthree';
    const list = run(value, formatEdit(value, 1, value.length - 1, 'ordered', 'text'));
    expect(list.text).toBe('1. one\n\n2. two\n3. three');
    expect(run(list.text, formatEdit(list.text, 0, list.text.length, 'ordered', 'text')).text).toBe(value);
    expect(run('- a\n- b', formatEdit('- a\n- b', 0, 7, 'quote', 'text')).text).toBe('> - a\n> - b');
    /* A bulleted line becomes numbered rather than both. */
    expect(run('- a', formatEdit('- a', 0, 0, 'ordered', 'text')).text).toBe('1. a');
  });

  it('turns a line into a heading, replacing another level, and keeps the caret in place', () => {
    const edit = formatEdit('# Title\nbody', 3, 3, 'heading', 'text');
    const result = run('# Title\nbody', edit);
    expect(result.text).toBe('## Title\nbody');
    expect(edit.selectStart).toBe(4);
    expect(run('## Title', formatEdit('## Title', 4, 4, 'heading', 'text')).text).toBe('Title');
  });
});

describe('images in the editor', () => {
  it('lands an image reference on lines of its own', () => {
    const block = '![a](media:00000000-0000-4000-8000-000000000000)';
    expect(run('first para', blockEdit('first para', 10, 10, block)).text).toBe(`first para\n\n${block}\n\n`);
    expect(run('a\n\nb', blockEdit('a\n\nb', 3, 3, block)).text).toBe(`a\n\n${block}\n\nb`);
    expect(run('', blockEdit('', 0, 0, block)).text).toBe(`${block}\n\n`);
  });

  it('starts the alt text from the file name, which then is what retrieval reads', () => {
    expect(altFromFileName('Screen Shot [2].png')).toBe('Screen Shot 2');
    expect(altFromFileName('diagram.v2.webp')).toBe('diagram.v2');
    const id = '11111111-1111-4111-8111-111111111111';
    const body = `Before\n\n![${altFromFileName('cat-on-desk.jpg')}](media:${id})\n`;
    expect(referencedMedia(body)).toEqual([id]);
    /* No caption is stored with an editor upload, so the alt text is indexed. */
    expect(indexedBody(body, new Map([[id, null]]))).toBe('Before\n\n[Image: cat-on-desk]\n');
  });

  it('keeps an upload placeholder out of the references and the index', () => {
    const body = '![Uploading cat.png…](uploading:3)';
    expect(referencedMedia(body)).toEqual([]);
  });
});

describe('focused dashboard routes', () => {
  it('drop the workspace rail only on the article and episode editor', () => {
    expect(isFocusedRoute(['assets', '6f1c', 'edit'])).toBe(true);
    expect(isFocusedRoute(['assets', '6f1c'])).toBe(false);
    expect(isFocusedRoute(['assets', 'new'])).toBe(false);
    expect(isFocusedRoute(['assets'])).toBe(false);
    expect(isFocusedRoute([])).toBe(false);
  });
});
