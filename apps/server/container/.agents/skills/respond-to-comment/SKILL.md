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

Default to **doing what the reviewer asked.** A concrete request on your own PR
is an instruction to carry out, not a proposal to debate.

- **Actionable**: any direct change request, real bug, missing test, or valid
  concern → fix it and push.
- **Genuinely not actionable**: only when the request would clearly break
  something, contradict an explicit project rule, or is factually wrong. Reply
  with one short, specific reason; if the reviewer repeats the request, do it.
- **Approval thumbs-up** (short body, no code refs): don't reply, stop

## Don't push back — do the work

- Never argue the same point twice. A restated request is a cue to act, not to
  re-explain the original choice.
- Do not declare a requested change out of scope when the reviewer has
  explicitly expanded the scope. Investigate and implement the smallest safe
  path.
- Before responding to review feedback, enumerate unresolved review threads and
  work through each one. Do not leave a thread unresolved without either a
  pushed fix or a one-line reason and a human owner.

```sh
gh api graphql --paginate -f query='query($o:String!,$r:String!,$n:Int!,$endCursor:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$endCursor){nodes{isResolved path comments(first:1){nodes{databaseId author{login} body}}}pageInfo{hasNextPage endCursor}}}}}' \
  -f o=<OWNER> -f r=<REPO> -F n=<N> \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | {path,body:.comments.nodes[0].body[0:80]}'
```

## Workflow

1. Check PR authorship — only push to your own PR's branch.
2. If actionable on your own PR: implement the fix, load `deslop`, commit, and
   push. Verify the remote branch contains the same commit before replying:

   ```sh
   git push origin HEAD
   test "$(git rev-parse HEAD)" = "$(git rev-parse @{u})"
   ```

   Then reply on the thread with the commit SHA, resolve the thread (see below),
   and leave one 🎉 reaction on the triggering comment. After all fixes, request review only after required checks are green.
3. If actionable on someone else's PR: reply with a `suggestion` block
   or description. Don't push.
4. If not actionable: reply on the thread with the reason and leave it open
   for a human to resolve.

## Durable discussion inbox

The webhook prompt can include a **PR discussion inbox**. Those are durable
messages that still need a real response, even if they arrived before the
current event or were compacted out of the conversation history.

- Inspect the live PR and answer **every** inbox item in its correct GitHub
  channel. Do not send generic acknowledgements, status-only comments, or a
  canned reply. The response must address that author's actual question.
- Choose the outcome from the work you did: `addressed` after a fix, `explained`
  after a considered answer, or `needs-human` after asking the one concrete
  decision you cannot safely make.
- After the substantive response, append the exact hidden marker shown for that
  item: `<!-- jared-discussion:<ID>:<outcome> -->`. GitHub delivers your reply
  back to Outpost, which verifies this marker and removes only that item from
  the inbox. Never add a marker before the visible response exists.
- An inline thread is resolved only after a real code fix. An explanation or
  `needs-human` response deliberately leaves it open for the reviewer.

## Ownership, not advisement

For an actionable item on your own PR, carry the work through the workflow
yourself. Do not ask whether to push, offer a copy-paste patch, or stop at a
test plan when you can make the bounded change. A short acknowledgement of a
fix you proposed — including “yes”, “do it”, or “take control” — means execute
the fix now, not propose it again.

Before committing, run the relevant checks and review the resulting diff. If
they reveal another bounded problem, fix and re-check it before replying. Ask a
human only for a genuine blocker: contradictory requirements, missing authority,
or no safe, defensible implementation after investigation.

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

## Completion reaction

Once the requested work is actually complete (not when it is skipped or
blocked), add one 🎉 reaction to the original trigger:

```sh
# inline PR review comment
gh api -X POST repos/<OWNER>/<REPO>/pulls/comments/<COMMENT_ID>/reactions -f content=hooray
# top-level PR or issue comment
gh api -X POST repos/<OWNER>/<REPO>/issues/comments/<COMMENT_ID>/reactions -f content=hooray
# labeled issue
gh api -X POST repos/<OWNER>/<REPO>/issues/<NUMBER>/reactions -f content=hooray
```

## Resolving a thread (only after you fixed it)

Resolve a review thread **only** when you pushed a code change that addresses
it. Leave won't-fix / not-actionable threads open with an explanatory reply.

1. Find the thread node id for the comment you addressed:

   ```sh
    THREAD_ID=$(gh api graphql --paginate -f query='
      query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100, after: $endCursor) {
              nodes { id isResolved comments(first: 1) { nodes { databaseId } } }
              pageInfo { hasNextPage endCursor }
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

After pushing fixes for a reviewer's feedback, check the required checks:

```sh
gh pr checks <N> --required
```

Do not re-request review or describe the PR as ready while required checks are
pending or failing. Leave it open for the CI-completion webhook to resume the
work. Only re-request review after required checks are green:

```sh
gh api -X POST "repos/<OWNER>/<REPO>/pulls/<N>/requested_reviewers" \
  -f "reviewers[]=<REVIEWER_LOGIN>"
```

Keep replies concise and natural — write like a teammate, not a
support bot. No filler phrases, no emoji unless the thread uses them.

Don't push to others' branches. Don't force-push. Don't merge.
