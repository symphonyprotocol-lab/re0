/**
 * The names the review automation writes into `library_review.stage` and
 * `workflow_operation.operation_type`. Kept apart from the layers that use
 * them so the rules layer (which queues a model review) and the model layer
 * (which draws samples) do not import each other.
 */

/** `library_review.stage` of a row the rules layer wrote. */
export const RULES_REVIEW_STAGE = 'rules';
/** `library_review.stage` of a row the model layer wrote. */
export const MODEL_REVIEW_STAGE = 'model';
/** `library_review.stage` of a sample drawn after an automatic publication. */
export const SAMPLE_REVIEW_STAGE = 'sample';
/** `workflow_operation.operation_type` of a queued model review. */
export const MODEL_REVIEW_OPERATION = 'model_review';
