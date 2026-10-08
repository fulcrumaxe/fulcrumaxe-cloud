/**
 * D#483 S3 (M0, E1): the GraphQL documents the plan import may send. They are constants in this one file and the client
 * sends nothing else: a document that is not byte-for-byte one of these is refused before a token is used. Every one is a
 * single `query` operation (no mutation, no subscription, no fragment); `assertSingleQueryDocument` checks that again on
 * every send, and a test checks it on these constants, so an edit that adds a mutation fails twice.
 */

/** The default branch and its head commit, and whether Discussions are on. One request, any repository the token reaches. */
export const REPO_HEAD_QUERY = `query PlanRepoHead($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    hasDiscussionsEnabled
    defaultBranchRef {
      name
      target {
        ... on Commit {
          oid
        }
      }
    }
  }
}`;

/** One page of the repository's Discussions, oldest first. */
export const DISCUSSIONS_PAGE_QUERY = `query PlanDiscussions($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    hasDiscussionsEnabled
    discussions(first: $first, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        number
        title
        body
        closed
        createdAt
        author {
          login
        }
      }
    }
  }
}`;

/** One page of one Discussion's comments, oldest first. `isMinimized` is how a maintainer hides a spam comment; the import skips those. */
export const DISCUSSION_COMMENTS_QUERY = `query PlanDiscussionComments($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      comments(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          databaseId
          body
          createdAt
          isMinimized
          author {
            login
          }
        }
      }
    }
  }
}`;

export const ALLOWED_GRAPHQL_DOCUMENTS: ReadonlySet<string> = new Set([REPO_HEAD_QUERY, DISCUSSIONS_PAGE_QUERY, DISCUSSION_COMMENTS_QUERY]);

export class GraphqlDocumentRefused extends Error {
  constructor(reason: string) {
    super(`graphql document refused: ${reason}`);
    this.name = "GraphqlDocumentRefused";
  }
}

/**
 * Throws unless `document` is exactly one `query` operation: no `mutation`, no `subscription`, no `fragment`, no second
 * operation, nothing after the operation's closing brace. It reads the text the way GraphQL's lexer does for the parts
 * that matter here: comments (`#` to the end of the line) and string literals (including block strings) are skipped, so a
 * word inside one is not mistaken for an operation keyword, and braces and parentheses must balance.
 */
export function assertSingleQueryDocument(document: string): void {
  const n = document.length;
  let i = 0;
  let depth = 0; // nesting of { ( [
  let seenKeyword: string | null = null;
  let seenBody = false;
  let afterBody = false;
  let sawName = false;

  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);

  while (i < n) {
    const c = document[i]!;
    if (c === "#") {
      while (i < n && document[i] !== "\n" && document[i] !== "\r") i += 1;
      continue;
    }
    if (c === '"') {
      if (document.startsWith('"""', i)) {
        const end = document.indexOf('"""', i + 3);
        // a block string may contain \""" ; skip an escaped one
        let close = end;
        while (close > 0 && document[close - 1] === "\\") close = document.indexOf('"""', close + 3);
        if (close === -1) throw new GraphqlDocumentRefused("unterminated block string");
        i = close + 3;
      } else {
        i += 1;
        while (i < n && document[i] !== '"') {
          if (document[i] === "\\") i += 1;
          if (document[i] === "\n") throw new GraphqlDocumentRefused("unterminated string");
          i += 1;
        }
        if (i >= n) throw new GraphqlDocumentRefused("unterminated string");
        i += 1;
      }
      continue;
    }
    if (c === "{" || c === "(" || c === "[") {
      if (depth === 0 && c === "{") {
        if (afterBody) throw new GraphqlDocumentRefused("more than one operation");
        seenBody = true;
      }
      if (afterBody && depth === 0) throw new GraphqlDocumentRefused("text after the operation");
      depth += 1;
      i += 1;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth -= 1;
      if (depth < 0) throw new GraphqlDocumentRefused("unbalanced brackets");
      i += 1;
      if (depth === 0 && c === "}" && seenBody) afterBody = true;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < n && isNameChar(document[j]!)) j += 1;
      const word = document.slice(i, j);
      if (depth === 0) {
        if (afterBody) throw new GraphqlDocumentRefused("text after the operation");
        if (seenKeyword === null && !seenBody) {
          if (word !== "query") throw new GraphqlDocumentRefused(`only a query operation may be sent, not "${word}"`);
          seenKeyword = word;
        } else if (!sawName && !seenBody) {
          sawName = true; // the operation's name
        } else {
          throw new GraphqlDocumentRefused(`unexpected "${word}" outside the operation's selection set`);
        }
      }
      i = j;
      continue;
    }
    if (c === "@" && depth === 0 && !afterBody) {
      // a directive on the operation: skip '@' and its name and let any argument list be read as brackets
      i += 1;
      while (i < n && isNameChar(document[i]!)) i += 1;
      continue;
    }
    if (/\s|,/.test(c)) {
      i += 1;
      continue;
    }
    if (depth === 0) throw new GraphqlDocumentRefused(`unexpected character "${c}"`);
    i += 1;
  }
  if (depth !== 0) throw new GraphqlDocumentRefused("unbalanced brackets");
  if (!seenBody || !afterBody) throw new GraphqlDocumentRefused("no operation body");
  if (seenKeyword === null) {
    // the shorthand `{ ... }` is a query too; allowed
  }
}
