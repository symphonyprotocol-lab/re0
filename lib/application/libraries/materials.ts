/**
 * The owner's submission materials: the rights declaration a public
 * submission needs, and the self-check questions it may bring -- optional
 * for publishing since 2026-10-23, required of an expert-library
 * application (lib/domain/expert-library.ts).
 * review-visibility-proposal.md 5.1 and 5.2; rules in lib/domain/rights.ts
 * and lib/domain/library.ts (`submissionBlockers`).
 *
 * The questions share `library_eval_question` with the platform's own test
 * set, told apart by `author`. An owner writes and removes their own; the
 * platform's they can read but not touch. Only `admin` questions move the
 * Benchmark (ingestion/evaluate.ts): a reviewer adopts an owner's question
 * into the scored set from the console (administration/manage-eval-
 * questions.ts), which is the one way an owner's question starts counting.
 */
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { draftEvalQuestion, EVAL_MAX_QUESTIONS } from '@/lib/domain/benchmark';
import { uuidv7 } from '@/lib/domain/id';
import {
  PlatformLibraryRefused,
  submissionBlockers,
  submissionReady,
  type SubmissionBlocker,
} from '@/lib/domain/library';
import {
  parseRightsDeclaration,
  readRightsDeclaration,
  rightsAllowPublic,
  type RightsDeclaration,
} from '@/lib/domain/rights';
import { evaluateVersion, type EvaluationDependencies } from '@/lib/application/ingestion/evaluate';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { canManageLibraries, type WorkspaceRole } from './delete';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Reader = Pick<ReturnType<typeof db>, 'select'>;

export const EVAL_AUTHORS = ['owner', 'admin'] as const;
export type EvalAuthor = (typeof EVAL_AUTHORS)[number];

function authorOf(value: string): EvalAuthor {
  return value === 'owner' ? 'owner' : 'admin';
}

/* --------------------------------------------------------------- readiness */

export interface LibraryMaterials {
  rights: RightsDeclaration | null;
  /** Every question on the library, whoever wrote it. */
  questions: number;
  ownerQuestions: number;
  blockers: SubmissionBlocker[];
  ready: boolean;
}

/** What the library has brought, and what it still lacks, for the submission rules. */
export async function libraryMaterials(reader: Reader, libraryId: string): Promise<LibraryMaterials> {
  const [[row], [counts], ownerQuestions] = await Promise.all([
    reader
      .select({ rights: schema.library.rightsDeclaration })
      .from(schema.library)
      .where(eq(schema.library.id, libraryId))
      .limit(1),
    reader
      .select({ questions: count() })
      .from(schema.libraryEvalQuestion)
      .where(eq(schema.libraryEvalQuestion.libraryId, libraryId)),
    ownerQuestionCount(reader, libraryId),
  ]);
  const rights = readRightsDeclaration(row?.rights);
  const questions = counts?.questions ?? 0;
  const materials = {
    rightsDeclared: rights !== null,
    rightsAllowPublic: rights ? rightsAllowPublic(rights) : false,
  };
  return {
    rights,
    questions,
    ownerQuestions,
    blockers: submissionBlockers(materials),
    ready: submissionReady(materials),
  };
}

async function ownerQuestionCount(reader: Reader, libraryId: string): Promise<number> {
  const [row] = await reader
    .select({ n: count() })
    .from(schema.libraryEvalQuestion)
    .where(and(eq(schema.libraryEvalQuestion.libraryId, libraryId), eq(schema.libraryEvalQuestion.author, 'owner')));
  return row?.n ?? 0;
}

/* ------------------------------------------------------------------ rights */

/** The workspace's own live user library, or `library_not_found`. */
async function ownedLibrary(reader: Reader, workspaceId: string, libraryId: string) {
  if (!UUID.test(libraryId)) throw new AppError('library_not_found', 'no such library');
  const [row] = await reader
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      visibility: schema.library.visibility,
      rights: schema.library.rightsDeclaration,
      indexStatus: schema.library.indexStatus,
      currentVersionId: schema.library.currentVersionId,
    })
    .from(schema.library)
    .where(
      and(
        eq(schema.library.id, libraryId),
        eq(schema.library.ownerWorkspaceId, workspaceId),
        eq(schema.library.isPlatformLibrary, false),
        isNull(schema.library.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new AppError('library_not_found', 'no such library');
  return row;
}

function assertManager(role: WorkspaceRole, verb: string): void {
  if (!canManageLibraries(role)) {
    throw new AppError('access_denied', `only a workspace owner or admin can ${verb}`);
  }
}

export interface DeclareRightsInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  /** The signed-in user, recorded as who declared. */
  userId: string | null;
  rights: { origin?: unknown; license?: unknown; generation?: unknown; note?: unknown };
}

/**
 * Record or replace the owner's declaration. A declaration that does not
 * permit a public library is still recorded on a private one -- it is the
 * owner's statement about their content -- and refused on a public one,
 * which must not carry a declaration it cannot publish under.
 */
export async function declareLibraryRights(input: DeclareRightsInput): Promise<RightsDeclaration> {
  assertManager(input.role, 'declare rights');
  const database = db();
  const target = await ownedLibrary(database, input.workspaceId, input.libraryId);
  const declaration = parseRightsDeclaration(input.rights, { userId: input.userId, now: new Date() });
  if (!declaration) throw new PlatformLibraryRefused('rights_invalid', 'the declaration is incomplete');
  if (target.visibility === 'public' && !rightsAllowPublic(declaration)) {
    throw new PlatformLibraryRefused('rights_generated', 'model-generated content is not accepted as public');
  }
  await database
    .update(schema.library)
    .set({ rightsDeclaration: declaration })
    .where(eq(schema.library.id, target.id));
  return declaration;
}

/* --------------------------------------------------------------- questions */

export interface OwnerEvalQuestionView {
  id: string;
  question: string;
  expectedSource: string | null;
  expectedText: string | null;
  author: EvalAuthor;
  lastEvaluatedAt: string | null;
  /** 1-based; null with a `lastEvaluatedAt` is a miss. */
  lastRank: number | null;
  lastRunIsCurrent: boolean;
}

export interface OwnerEvalQuestions {
  questions: OwnerEvalQuestionView[];
  /** The library's cap; the expert gate's minimum lives with its rules (expert-libraries/owner.ts). */
  limits: { max: number };
}

/** The library's questions, the owner's and the platform's, for the owner's panel. */
export async function listLibraryEvalQuestions(input: {
  workspaceId: string;
  libraryId: string;
}): Promise<OwnerEvalQuestions> {
  const database = db();
  const target = await ownedLibrary(database, input.workspaceId, input.libraryId);
  const [library] = await database
    .select({ currentVersionId: schema.library.currentVersionId })
    .from(schema.library)
    .where(eq(schema.library.id, target.id));
  const rows = await database
    .select()
    .from(schema.libraryEvalQuestion)
    .where(eq(schema.libraryEvalQuestion.libraryId, target.id))
    .orderBy(asc(schema.libraryEvalQuestion.createdAt));
  return {
    questions: rows.map((row) => ({
      id: row.id,
      question: row.question,
      expectedSource: row.expectedSource,
      expectedText: row.expectedText,
      author: authorOf(row.author),
      lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
      lastRank: row.lastRank,
      lastRunIsCurrent: row.lastVersionId !== null && row.lastVersionId === library?.currentVersionId,
    })),
    limits: { max: EVAL_MAX_QUESTIONS },
  };
}

export interface AddOwnerEvalQuestionInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  question: string;
  expectedSource?: string | null;
  expectedText?: string | null;
  /** The retrieval the question is tried with; tests substitute their own. */
  dependencies?: EvaluationDependencies;
}

/**
 * Add one of the owner's questions. The library's whole set shares the cap.
 *
 * A question written after the build would otherwise wait for the next
 * build or the submission to be asked, so the new one is tried at once,
 * alone, against the current ready version -- the same unmetered retrieval
 * the build uses (ingestion/evaluate.ts). The rest of the set keeps its
 * result and the Benchmark is not touched: an owner's question never scores
 * (5.2), and no score row is written here. A try that cannot run leaves the
 * question unevaluated, and the add still stands.
 */
export async function addOwnerEvalQuestion(
  input: AddOwnerEvalQuestionInput,
): Promise<{ questionId: string; evaluated: boolean }> {
  assertManager(input.role, 'edit the question set');
  const drafted = draftEvalQuestion(input);
  if (!drafted.ok) throw new PlatformLibraryRefused('eval_question_invalid', drafted.refusal);
  const database = db();
  const target = await ownedLibrary(database, input.workspaceId, input.libraryId);
  const [existing] = await database
    .select({ n: count() })
    .from(schema.libraryEvalQuestion)
    .where(eq(schema.libraryEvalQuestion.libraryId, target.id));
  if ((existing?.n ?? 0) >= EVAL_MAX_QUESTIONS) {
    throw new PlatformLibraryRefused('eval_question_limit', 'the question set is full');
  }
  const questionId = uuidv7();
  await database.insert(schema.libraryEvalQuestion).values({
    id: questionId,
    libraryId: target.id,
    author: 'owner',
    ...drafted.draft,
  });
  if (target.indexStatus !== 'ready' || !target.currentVersionId) return { questionId, evaluated: false };
  try {
    const run = await evaluateVersion(
      database,
      { libraryId: target.id, versionId: target.currentVersionId, questionIds: [questionId] },
      input.dependencies,
    );
    return { questionId, evaluated: run !== null };
  } catch (error) {
    console.error(`trying question ${questionId} of ${target.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { questionId, evaluated: false };
  }
}

/** Remove one of the owner's questions; the platform's are not theirs to remove. */
export async function removeOwnerEvalQuestion(input: {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  questionId: string;
}): Promise<void> {
  assertManager(input.role, 'edit the question set');
  const database = db();
  const target = await ownedLibrary(database, input.workspaceId, input.libraryId);
  if (!UUID.test(input.questionId)) throw new AppError('invalid_request', 'no such question');
  const removed = await database
    .delete(schema.libraryEvalQuestion)
    .where(
      and(
        eq(schema.libraryEvalQuestion.id, input.questionId),
        eq(schema.libraryEvalQuestion.libraryId, target.id),
        eq(schema.libraryEvalQuestion.author, 'owner'),
      ),
    )
    .returning({ id: schema.libraryEvalQuestion.id });
  if (removed.length === 0) throw new AppError('invalid_request', 'no such question of yours');
}
