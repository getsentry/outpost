---
name: respond-to-comment
description: Triage and respond to comments on a PR. Fix if actionable, reply either way. Load repo-setup first.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Respond to Comment

Triage a comment on a PR the bot is involved in. Load `repo-setup` first.

## Addressing guard

Before triaging, confirm the comment is actually for you:

- If the comment author equals your identity (`$ME` — see agent identity
  setup), stop: `SKIPPED: own comment`.
- If the body explicitly `@`-mentions a specific other user and does NOT
  `@`-mention `$ME`, the question is aimed at someone else — stop:
  `SKIPPED: directed at @<user>`. Applies to inline and top-level
  comments alike. Exceptions (keep going): the comment also `@`-mentions
  `$ME`, it's a direct reply to one of your own comments, or it's a
  comment on a `jared`-labeled issue (the router resumes `resolve-issue`
  for those, so answers to your own questions are never dropped even if
  they `@`-mention a helper).
- A comment with no `@`-mention of another user is not affected by this
  guard — proceed to triage as normal.

## Triage

Default to **doing what the reviewer asked.** A concrete request on your own PR —
"drop this paragraph", "revert this file", "rename X", "remove the try/catch" — is an
instruction to carry out, not a proposal to debate. Make the change.

- **Actionable** (the overwhelming majority): a real bug, missing test, valid
  concern, or any direct change request → fix it and push.
- **Genuinely not actionable**: only when doing it would clearly break something,
  contradicts an explicit project rule, or is factually wrong. Reply with ONE short,
  specific reason — and just do it if the reviewer says it again.
- **Approval thumbs-up** (short body, no code refs): don't reply, stop.

## Don't push back — do the work

The failure mode to avoid: writing a paragraph about why a comment doesn't apply
instead of addressing it. Reviewers read that as lazy, and they're right. Concretely:

- **Never refuse with "it'll be overwritten" / "it's a harness artifact" / "not my
  responsibility" / "leaving this for the maintainers".** If it's in your PR's diff,
  it's yours — fix it. (The real fix for a stray harness file like `AGENTS.md` is to
  never commit it in the first place — see `repo-setup` — but if a reviewer asks you
  to revert it, just revert it now.)
- **Never argue the same point twice.** If a reviewer restates their request, that's
  your cue to do it, not to re-explain your reasoning.
- **Don't defer actionable feedback** to "the author of a later commit". You authored
  the PR; you own it to merge-ready.

If a comment truly isn't yours to act on (out of scope, or a call only a human should
make), say so in one plain sentence AND `@`-mention a human so it has an owner — never
silently leave it open.

## Own your PR end-to-end

The bot owns getting its own PR merge-ready — that doesn't change because a maintainer
pushed a follow-up commit onto the branch. Before you start, list the open review
threads so none slip through (a missed comment is as bad as a refused one):

```sh
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved path comments(first:1){nodes{databaseId author{login} body}}}}}}}' \
  -f o=<OWNER> -f r=<REPO> -F n=<N> \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | {path,body:.comments.nodes[0].body[0:80]}'
```

Work through every unresolved thread; don't stop until each is either fixed-and-pushed
or has a one-line reason plus a human owner.

## Workflow

1. Check PR authorship — only push to your own PR's branch.
2. If actionable on your own PR: implement the fix, load `deslop`, commit and
   push, then **confirm the push landed** before you reply:

   ```sh
   git push origin HEAD
   git rev-parse HEAD @{u}   # the two SHAs must match — if not, the push failed
   ```

   Only once it's really on the branch, reply on the thread with the commit SHA,
   resolve the thread (see below), and drop a 🎉 reaction on the comment as the
   "done" signal:

   ```sh
   gh api -X POST repos/<OWNER>/<REPO>/pulls/comments/<COMMENT_ID>/reactions -f content=hooray
   ```

   After all fixes, re-request review.
3. If actionable on someone else's PR: reply with a `suggestion` block
   or description. Don't push.
4. If not actionable: reply on the thread with the reason and leave it open
   for a human to resolve.

## Replying to comments

There are two kinds of comments — reply to each in its own channel. **Never
use `gh pr comment` to answer an inline review comment**; that posts a
top-level PR comment that isn't attached to the thread.

**Inline review comment** (`pull_request_review_comment`, or a comment inside a
`pull_request_review`) — reply on the thread via the replies endpoint:

```sh
gh api -X POST \
  "repos/<OWNER>/<REPO>/pulls/<N>/comments/<COMMENT_ID>/replies" \
  -f body="Fixed in <SHA>."
```

`<COMMENT_ID>` is the review comment's `id` from the event payload (use the
top-level comment of the thread — the one with `in_reply_to_id` unset).

**Top-level PR comment** (`issue_comment` on a PR, not tied to a line) — reply
with:

```sh
gh pr comment <N> --body "..."
```

## Resolving a thread (only after you fixed it)

Resolve a review thread **only** when you pushed a code change that addresses
it. Leave won't-fix / not-actionable threads open with an explanatory reply.

1. Find the thread node id for the comment you addressed:

   ```sh
   THREAD_ID=$(gh api graphql -f query='
     query($owner: String!, $repo: String!, $pr: Int!) {
       repository(owner: $owner, name: $repo) {
         pullRequest(number: $pr) {
           reviewThreads(first: 100) {
             nodes { id isResolved comments(first: 1) { nodes { databaseId } } }
           }
         }
       }
     }' -f owner=<OWNER> -f repo=<REPO> -F pr=<N> \
     --jq '.data.repository.pullRequest.reviewThreads.nodes[]
            | select(.comments.nodes[0].databaseId == <COMMENT_ID>) | .id')
   ```

2. Resolve it:

   ```sh
   gh api graphql -f query='
     mutation($threadId: ID!) {
       resolveReviewThread(input: { threadId: $threadId }) {
         thread { isResolved }
       }
     }' -f threadId="$THREAD_ID"
   ```

## Re-requesting review

After pushing fixes for a reviewer's feedback, re-request their review so they
see the PR is ready again:

```sh
gh api -X POST "repos/<OWNER>/<REPO>/pulls/<N>/requested_reviewers" \
  -f "reviewers[]=<REVIEWER_LOGIN>"
```

Keep replies concise and natural — write like a teammate, not a
support bot. No filler phrases, no emoji unless the thread uses them.

Don't push to others' branches. Don't force-push. Don't merge.
