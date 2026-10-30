'use client';

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Markdown } from '@/components/creator/markdown';
import { blockEdit, formatEdit, altFromFileName, type MarkdownFormat, type TextEdit } from '@/components/creator/markdown-format';
import { uploadMedia, type ConfirmMedia, type PrepareMedia } from '@/components/creator/media-upload';
import {
  BoldIcon,
  CodeIcon,
  HeadingIcon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  SpinnerIcon,
} from '@/components/ui/icons';
import { fill } from '@/lib/i18n/format';

type Mode = 'edit' | 'split' | 'preview';

export type MarkdownEditorLabels = {
  toolbar: string;
  bold: string;
  italic: string;
  heading: string;
  bullet: string;
  ordered: string;
  quote: string;
  code: string;
  link: string;
  image: string;
  placeholder: string;
  modes: Record<Mode, string>;
  modeLabel: string;
  previewEmpty: string;
  uploading: string;
  uploadingCount: string;
  failed: string;
  transfer: string;
  dropHint: string;
  characters: string;
};

const TOOLS: { format: MarkdownFormat; icon: (props: { size?: number }) => ReactNode; key?: string }[] = [
  { format: 'bold', icon: BoldIcon, key: 'b' },
  { format: 'italic', icon: ItalicIcon, key: 'i' },
  { format: 'heading', icon: HeadingIcon },
  { format: 'bullet', icon: ListIcon },
  { format: 'ordered', icon: ListOrderedIcon },
  { format: 'quote', icon: QuoteIcon },
  { format: 'code', icon: CodeIcon },
  { format: 'link', icon: LinkIcon, key: 'k' },
];

const TOOL_BUTTON =
  'inline-flex size-8 items-center justify-center rounded-md text-steel transition-colors hover:bg-subtle hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent';

/** A sequence for the placeholders of uploads in flight, unique on the page. */
let uploadSequence = 0;

/** Make one edit in the textarea, through the browser's own editing so undo still works. */
function applyEdit(textarea: HTMLTextAreaElement, edit: TextEdit): void {
  if (edit.start === edit.end && edit.text === '') return;
  textarea.focus();
  textarea.setSelectionRange(edit.start, edit.end);
  const inserted = edit.text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, edit.text);
  if (!inserted || textarea.value.slice(edit.start, edit.start + edit.text.length) !== edit.text) {
    textarea.setRangeText(edit.text, edit.start, edit.end, 'end');
  }
  textarea.setSelectionRange(edit.selectStart, edit.selectEnd);
}

/**
 * The Markdown editor of an article or an episode's show notes
 * (agent-first-proposal.md 6.5, 6.6): a toolbar over a plain textarea, and
 * a preview rendered by the reading page's own renderer, side by side or
 * one at a time.
 *
 * Images go in the way they do in any Markdown editor -- the toolbar's
 * picker, a drop onto the text, or a paste. Each lands as a placeholder at
 * the caret while it uploads through the same two server steps as any
 * other file (a ticket, then a confirmation), and becomes
 * `![alt](media:<id>)` when it is in. The alt text starts as the file name
 * and is edited in the text; no caption is stored with the file, so the
 * alt text is what retrieval reads (lib/domain/editorial.ts `indexedBody`).
 *
 * The textarea is the form's `name` field and stays uncontrolled; the
 * preview follows its value.
 */
export function MarkdownEditor({
  name,
  label,
  defaultValue,
  maxLength,
  tall,
  assetId,
  images,
  labels,
  errors,
  hint,
}: {
  name: string;
  /** The text field's accessible name: the body, or the show notes. */
  label: string;
  defaultValue: string;
  maxLength: number;
  /** An article's body gets the room; show notes are shorter. */
  tall: boolean;
  assetId: string;
  /** How images are uploaded, when this editor takes them. */
  images: { accept: string; prepare: PrepareMedia; confirm: ConfirmMedia } | null;
  labels: MarkdownEditorLabels;
  errors: Record<string, string>;
  hint: ReactNode;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultValue);
  const [mode, setMode] = useState<Mode>('split');
  const [uploading, setUploading] = useState(0);
  const [failures, setFailures] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);
  const dirty = useRef(false);

  /* Leaving with unsaved text asks first; submitting the form is not leaving it. */
  useEffect(() => {
    const form = textarea.current?.form;
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.current) event.preventDefault();
    };
    const saved = () => {
      dirty.current = false;
    };
    window.addEventListener('beforeunload', warn);
    form?.addEventListener('submit', saved);
    return () => {
      window.removeEventListener('beforeunload', warn);
      form?.removeEventListener('submit', saved);
    };
  }, []);

  function sync(): void {
    if (!textarea.current) return;
    dirty.current = true;
    setValue(textarea.current.value);
  }

  function format(kind: MarkdownFormat): void {
    const field = textarea.current;
    if (!field) return;
    applyEdit(field, formatEdit(field.value, field.selectionStart, field.selectionEnd, kind, labels.placeholder));
    sync();
  }

  async function insertImages(files: File[]): Promise<void> {
    const field = textarea.current;
    if (!field || !images || files.length === 0) return;
    const pending = files.map((file) => ({
      file,
      alt: altFromFileName(file.name) || 'image',
      token: `![${fill(labels.uploading, { name: file.name.replace(/[[\]\r\n]+/g, ' ') })}](uploading:${++uploadSequence})`,
    }));
    applyEdit(field, blockEdit(field.value, field.selectionStart, field.selectionEnd, pending.map((item) => item.token).join('\n\n')));
    sync();
    setUploading((count) => count + pending.length);
    for (const item of pending) {
      const done = await uploadMedia({
        assetId,
        kind: 'image',
        file: item.file,
        prepare: images.prepare,
        confirm: images.confirm,
        errors,
        transfer: labels.transfer,
      }).catch(() => ({ ok: false as const, message: errors.unavailable ?? labels.transfer }));
      setUploading((count) => count - 1);
      const current = textarea.current;
      if (!current) return;
      const at = current.value.indexOf(item.token);
      /* The writer may have deleted the placeholder meanwhile; then the image is not put back. */
      if (at !== -1) {
        current.setRangeText(done.ok ? `![${item.alt}](media:${done.mediaId})` : '', at, at + item.token.length, 'preserve');
        sync();
      }
      if (!done.ok) setFailures((list) => [...list, fill(labels.failed, { name: item.file.name, reason: done.message })]);
    }
  }

  function imageFiles(list: FileList | null | undefined): File[] {
    return Array.from(list ?? []).filter((file) => file.type.startsWith('image/'));
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = imageFiles(event.clipboardData.files);
    if (!images || files.length === 0) return;
    event.preventDefault();
    setFailures([]);
    void insertImages(files);
  }

  function onDragOver(event: DragEvent<HTMLTextAreaElement>): void {
    if (!images || !Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    setDropping(true);
  }

  function onDrop(event: DragEvent<HTMLTextAreaElement>): void {
    setDropping(false);
    if (!images || event.dataTransfer.files.length === 0) return;
    /* A dropped file is never opened in place of the page; only images are taken. */
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    const refused = files.filter((file) => !file.type.startsWith('image/'));
    setFailures(refused.map((file) => fill(labels.failed, { name: file.name, reason: errors.invalid_media ?? errors.unavailable ?? '' })));
    void insertImages(imageFiles(event.dataTransfer.files));
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    const tool = TOOLS.find((item) => item.key === event.key.toLowerCase());
    if (!tool) return;
    event.preventDefault();
    format(tool.format);
  }

  const height = tall ? 'h-[62vh] min-h-[420px]' : 'h-[40vh] min-h-[280px]';
  const shortcut = (key?: string) => (key ? ` (⌘/Ctrl+${key.toUpperCase()})` : '');

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-y border-line bg-subtle/60 px-3 py-1.5">
        <div role="toolbar" aria-label={labels.toolbar} className="flex flex-wrap items-center gap-0.5">
          {TOOLS.map((tool) => (
            <button
              key={tool.format}
              type="button"
              title={`${labels[tool.format]}${shortcut(tool.key)}`}
              aria-label={labels[tool.format]}
              onClick={() => format(tool.format)}
              disabled={mode === 'preview'}
              className={TOOL_BUTTON}
            >
              <tool.icon size={15} />
            </button>
          ))}
          {images ? (
            <>
              <span aria-hidden className="mx-1 h-4 w-px bg-line" />
              <button
                type="button"
                title={labels.image}
                aria-label={labels.image}
                onClick={() => picker.current?.click()}
                disabled={mode === 'preview'}
                className={TOOL_BUTTON}
              >
                <ImageIcon size={15} />
              </button>
              <input
                ref={picker}
                type="file"
                accept={images.accept}
                multiple
                hidden
                onChange={(event) => {
                  const files = imageFiles(event.target.files);
                  event.target.value = '';
                  setFailures([]);
                  void insertImages(files);
                }}
              />
            </>
          ) : null}
          {uploading > 0 ? (
            <span role="status" className="ml-2 inline-flex items-center gap-1.5 text-[11.5px] text-muted">
              <SpinnerIcon size={12} />
              {fill(labels.uploadingCount, { count: String(uploading) })}
            </span>
          ) : null}
        </div>
        <div role="group" aria-label={labels.modeLabel} className="inline-flex rounded-md border border-line bg-card p-0.5">
          {(['edit', 'split', 'preview'] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={mode === item}
              onClick={() => setMode(item)}
              className={`h-7 rounded px-2.5 text-[11.5px] font-medium transition-colors ${
                mode === item ? 'bg-brandsoft text-brandink' : 'text-steel hover:text-ink'
              } ${item === 'split' ? 'hidden lg:inline-block' : ''}`}
            >
              {labels.modes[item]}
            </button>
          ))}
        </div>
      </div>

      {failures.length > 0 ? (
        <ul role="alert" className="flex flex-col gap-0.5 border-b border-line bg-rose/5 px-4 py-2 text-[12px] text-rose">
          {failures.map((line, at) => (
            <li key={at}>{line}</li>
          ))}
        </ul>
      ) : null}

      <div className={`grid grid-cols-1 ${mode === 'split' ? 'lg:grid-cols-2' : ''}`}>
        <div className={`relative ${mode === 'preview' ? 'hidden' : ''}`}>
          <textarea
            ref={textarea}
            id={`editor-${name}`}
            name={name}
            aria-label={label}
            maxLength={maxLength}
            defaultValue={defaultValue}
            onChange={sync}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onDragOver={onDragOver}
            onDragLeave={() => setDropping(false)}
            onDrop={onDrop}
            spellCheck={false}
            className={`block w-full resize-none bg-transparent px-6 py-5 font-mono text-[13px] leading-[1.7] text-ink outline-none ${height} ${
              dropping ? 'bg-brandsoft/40' : ''
            }`}
          />
          {dropping ? (
            <span className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-md border-2 border-dashed border-brand/50 text-[12.5px] text-brandink">
              {labels.dropHint}
            </span>
          ) : null}
        </div>
        <div
          role="region"
          aria-label={labels.modes.preview}
          className={`overflow-y-auto px-7 py-5 ${height} ${mode === 'edit' ? 'hidden' : ''} ${mode === 'split' ? 'max-lg:hidden lg:border-l lg:border-line' : ''}`}
        >
          {value.trim() ? <Markdown source={value} /> : <p className="text-[13px] text-muted">{labels.previewEmpty}</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-t border-line px-6 py-2.5 text-[11px] leading-[1.5] text-muted">
        <span className="min-w-0 flex-1">{hint}</span>
        <span className="tabular-nums">{fill(labels.characters, { count: String(value.length), max: String(maxLength) })}</span>
      </div>
    </div>
  );
}
