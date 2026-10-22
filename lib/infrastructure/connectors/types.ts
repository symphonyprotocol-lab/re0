/**
 * What every connector returns, and nothing more.
 *
 * A connector's whole job is to turn a location into an immutable set of files
 * plus the few facts about the source that scoring needs (requirement.md 6.3:
 * maintenance and licence are Trust inputs). Parsing, chunking and embedding
 * are the same for every source type and happen once, in the application layer,
 * which is why nothing here is format-aware.
 */
import type { DocumentFormat, FetchMethod, SourceConfig } from '@/lib/domain/ingestion';

export interface FetchedFile {
  /** Stable path within the source. Part of the snapshot digest. */
  path: string;
  /** Where a reader can see this document. Goes into every citation. */
  url: string;
  content: string;
  /**
   * How the bytes were obtained: our own fetch, or a rendering provider.
   * Set by the web connector; absent for sources that have no such choice
   * (a repository, a Notion space). Not part of the digest -- the same page
   * rendered two ways is the same content.
   */
  fetchedVia?: FetchMethod;
  /**
   * The title the page declares apart from `content`, when the connector
   * knows one (a rendered page's metadata, or its shell's `<title>`). Not
   * part of the digest: the same content under a corrected title is the
   * same content.
   */
  title?: string;
  /**
   * How `content` should be parsed when the path's extension does not say --
   * the PDF connector has already extracted text from a `.pdf`, and the
   * extension must stay so the citation names the file the operator uploaded.
   * Absent for every source whose files are what they are named.
   */
  format?: DocumentFormat;
}

export interface SourceSnapshot {
  files: FetchedFile[];
  /** `re0.json` if the source carries one, empty otherwise. */
  config: SourceConfig;
  /** Provider revision, such as a commit sha. Null when the source has none. */
  revision: string | null;
  lastModifiedAt: Date | null;
  hasLicense: boolean;
  /** True when the source itself says it is no longer maintained. */
  stale: boolean;
}
