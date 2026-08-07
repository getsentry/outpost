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

- **Actionable**: real bug, missing test, valid concern → fix it
- **Not actionable**: style preference, out of scope, already handled → reply with reason
- **Approval thumbs-up** (short body, no code refs): don't reply, stop

## Own your PR end-to-end

If the bot authored the PR, the bot owns getting it merge-ready — that doesn't
change just because a maintainer later pushed a follow-up commit onto the branch.
When a review comment on your PR is actionable, **fix it and push**; don't defer it
("leaving this for the author of that commit") and stop. Deferring strands the PR.

If a comment genuinely isn't yours to act on — it's out of scope, or it's about a
change only a human should make — say that plainly on the thread AND `@`-mention a
human maintainer so someone picks it up. Silently leaving it open with no owner is
the one thing to avoid.

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
