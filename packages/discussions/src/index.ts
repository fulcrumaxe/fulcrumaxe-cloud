/**
 * D#71 DS-2: the packages/discussions public surface. Deliberately does
 * NOT export `systemPrincipal` (that's `@fx/discussions/server`'s job
 * only -- criterion 2) and no function here returns a `Principal` at
 * all, so nothing exported from this file can ever hand a caller a
 * `kind: 'system'` object.
 */

export type { MembershipRole, TokenScope, Principal, DiscussionsContext } from "./principals.js";
export { isHumanOnly, hasScope } from "./principals.js";

export type { Operation, Access, OperationRule, DiscussionsErrorCode } from "./operations.js";
export { OPERATION_TABLE, authorize, assertAllowed, DiscussionsError } from "./operations.js";

export type { PlanId } from "./limits.js";
export {
  MAX_BODY_BYTES,
  MAX_COMMENTS_PER_RUN,
  MAX_RUN_COMMENT_BYTES,
  STORAGE_QUOTA_BYTES,
  MIRROR_WRITES_PER_MINUTE,
  MIRROR_WRITES_PER_HOUR,
  MIRROR_VISIBILITY_MAX_AGE_S,
  INBOUND_MAX_PER_REPO_PER_MINUTE,
  PUBLIC_READ_PER_IP_PER_MINUTE,
  utf8ByteLength,
} from "./limits.js";

export type {
  DiscussionKind,
  Visibility,
  Discussion,
  CreateDiscussionInput,
  ReviseDiscussionInput,
  SetVisibilityInput,
  DiscussionIdInput,
} from "./discussions.js";
export {
  DISCUSSION_KINDS,
  isBuildableKind,
  VISIBILITIES,
  RepoNotFoundError,
  createDiscussion,
  reviseDiscussion,
  setVisibility,
  setSecurity,
  clearSecurity,
} from "./discussions.js";

export type { Comment, PostCommentInput, EditOwnCommentInput, TombstoneCommentInput } from "./comments.js";
export { postComment, editOwnComment, tombstoneComment } from "./comments.js";

export type { DiscussionsEventType, DomainEventPayload } from "./events.js";

export type {
  SpecVersion,
  SpecCorrection,
  PublishSpecInput,
  RespecSpecInput,
  AmendSpecInput,
  AddCorrectionInput,
  RunIdInput,
  SpecAsOfResult,
} from "./specs.js";
export { publishSpec, respecSpec, amendSpec, addCorrection, specAsOf, correctionsSince } from "./specs.js";

export type { SetStageInput } from "./stages.js";
export { setStage, isHumanOnlyTransition } from "./stages.js";

export type { DependencyInput } from "./deps.js";
export { addDependency, removeDependency } from "./deps.js";

export type {
  PageCursor,
  Page,
  ListDiscussionsInput,
  GetDiscussionInput,
  ListCommentsInput,
  DiscussionDetail,
  CommentView,
} from "./reads.js";
export { listDiscussions, getDiscussion, listComments } from "./reads.js";
